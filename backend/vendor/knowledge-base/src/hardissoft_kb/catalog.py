"""Authoritative PostgreSQL JSONB catalogue and accepted safe read projection."""
import copy
import hashlib
import json
from collections.abc import Mapping
import os
import re
from pathlib import Path
from .search.context import validate_context, scope_allows
from .search.lexical import technical_ids,cjk_bigrams

_DEFAULT_ROOT = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share'))) / 'hardviser' / 'knowledge-base'
ROOT = Path(os.environ.get('HIS_KB_ROOT', str(_DEFAULT_ROOT)))
_FILES={'sources.jsonl':'source','source-versions.jsonl':'source_version','artifacts.jsonl':'artifact','blocks.jsonl':'block','variants.jsonl':'text_variant','relations.jsonl':'relation','chunks.jsonl':'chunk','tables.jsonl':'table','cells.jsonl':'cell','decisions.jsonl':'decision','cards.jsonl':'knowledge_card','outcomes.jsonl':'outcome'}
_HASH=re.compile(r'^[a-f0-9]{64}$')
_POLICY_LOCK_KEY=140763501149349480
# Pinned forum privacy guard. Its identity is the hash; bytes are read from the KB config,
# never from processing staging. Historical receipts may name an older path for the same hash.
_PRIVACY_GUARD_SHA256='96a1292979831d5eb1b48475fa70f46334a6df1f8f6fc945b8b1102b41da5a5a'
_PRIVACY_GUARD_PATH=ROOT/'config'/'PRIVACY-GUARD-ADDENDUM.md'


def _lock_release_index(conn,release_id):
    if not isinstance(release_id,str) or not release_id:raise ValueError('release id required for index lock')
    conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('hardissoft-kb-vector-index:'+release_id,))


def _lock_current_policy(conn,*,shared=True):
    if shared:
        row=conn.execute('SELECT kb.lock_current_policy_shared() AS revision').fetchone()
    else:
        conn.execute('SELECT pg_advisory_xact_lock(%s::bigint)',(_POLICY_LOCK_KEY,))
        row=conn.execute('SELECT revision FROM kb.policy_state WHERE singleton').fetchone()
    if not row or row.get('revision') is None:raise PermissionError('current policy unavailable')
    return row['revision']


def _assert_restore_ready(conn):
    restore=conn.execute("SELECT to_regclass('kb.restore_state') AS relation").fetchone()
    if restore['relation'] is not None:
        state=conn.execute('SELECT kb.restore_ready() AS policy_reconciled').fetchone()
        if not state or state['policy_reconciled'] is not True:raise PermissionError('restored policy journal not reconciled')
    elif conn.info.dbname.startswith('kb_restore_'):
        raise PermissionError('restored policy gate missing')


class CandidateSet:
    """SQL-authorized release subset; text is hydrated only for bounded hits."""
    def __init__(self,sql,params,release_id,context,request,destination,include_candidates):
        self.sql=sql
        self.params=tuple(params)
        self.release_id=release_id
        self._context=dict(context)
        self._request=dict(request)
        self._destination=destination
        self._include_candidates=include_candidates

    def fetch_rows(self,conn,chunk_ids):
        if not isinstance(chunk_ids,(list,tuple)) or any(not isinstance(value,str) or not value for value in chunk_ids):
            raise ValueError('bounded chunk id list required')
        ids=list(dict.fromkeys(chunk_ids))
        if len(ids)>500:raise ValueError('candidate hydration exceeds 500 rows')
        if not ids:return []
        rows,_,_=authorized_rows(self._context,conn=conn,destination=self._destination,
            include_candidates=self._include_candidates,chunk_ids=ids,request=self._request)
        return rows

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()

def connect(dsn=None,*,readonly=False,admin=False):
    import psycopg
    from psycopg.rows import dict_row
    if dsn:return psycopg.connect(dsn,row_factory=dict_row)
    config=json.loads((ROOT/'runtime/postgres/connection.json').read_text())
    role=config.get('admin_user','deploy') if admin else config.get('read_user','kb_readsearch') if readonly else config.get('user','kb_ingest')
    args={k:config[k] for k in ('host','port','dbname')}
    transport=config.get('transport_user')
    if transport:
        if transport!='deploy' or config.get('restore_isolated') is not True or not args['dbname'].startswith('kb_restore_'):raise ValueError('restore transport forbidden for source instance')
        role=config.get('session_roles',{}).get('read' if readonly else 'write',role) if not admin else 'deploy'
        if role!=('deploy' if admin else 'kb_readsearch' if readonly else 'kb_ingest'):raise ValueError('invalid restored session role')
        conn=psycopg.connect(**args,user=transport,row_factory=dict_row)
        if not admin:
            try:conn.execute(psycopg.sql.SQL('SET ROLE {}').format(psycopg.sql.Identifier(role)))
            except Exception:conn.close();raise
        return conn
    return psycopg.connect(**args,user=role,row_factory=dict_row)

_LEGACY_CATALOG_MIGRATIONS=(
    '001_catalog.sql','002_immutability.sql','003_normalized_keys.sql',
    '004_origins.sql','005_acquisitions.sql','006_source_groups.sql',
    '007_authorized_candidates.sql','008_policy_gate.sql',
    '009_vector_index_privileges.sql',
)


def _legacy_catalog_complete(conn):
    required_relations={
        'kb.packages':'r','kb.entities':'r','kb.entity_dependencies':'r',
        'kb.chunks':'r','kb.releases':'r','kb.release_members':'r',
        'kb.index_builds':'r','kb.active_release':'r','kb.policy_state':'r',
        'kb.policy':'r','kb.revocations':'r','kb.citations':'r',
        'kb.read_projection':'v','kb.entity_packages':'r','kb.chunk_origins':'r',
        'kb.release_chunk_origins':'r','kb.release_relation_origins':'r',
        'kb.release_source_groups':'r','kb.release_chunk_dependencies':'r',
        'kb.embeddings':'r','kb.embedding_checkpoints':'r',
        'kb_private.provenance':'r','kb_private.provenance_packages':'r',
    }
    relations=conn.execute('''SELECT required.name,actual.relkind
        FROM unnest(%s::text[]) AS required(name)
        LEFT JOIN pg_catalog.pg_class actual
          ON actual.oid=pg_catalog.to_regclass(required.name)''',
        (list(required_relations),)).fetchall()
    if any(row['relkind']!=required_relations[row['name']] for row in relations):
        return False

    generated_columns={'source_id','source_version_id','artifact_id','parent_id',
                       'variant_id','from_id','to_id'}
    generated=conn.execute('''SELECT attname,attgenerated FROM pg_catalog.pg_attribute
        WHERE attrelid=pg_catalog.to_regclass('kb.entities') AND attnum>0
          AND NOT attisdropped AND attname=ANY(%s)''',
        (list(generated_columns),)).fetchall()
    if ({row['attname'] for row in generated}!=generated_columns or
            any(row['attgenerated']!='s' for row in generated)):
        return False

    columns=conn.execute('''WITH required(schema_name,table_name,column_name) AS (
          VALUES ('kb','chunks','context_order'),
                 ('kb','citations','operation'),
                 ('kb','citations','context_relation'))
        SELECT required.schema_name,required.table_name,required.column_name,actual.attnotnull
        FROM required
        LEFT JOIN pg_catalog.pg_class relation
          ON relation.oid=pg_catalog.to_regclass(required.schema_name||'.'||required.table_name)
        LEFT JOIN pg_catalog.pg_attribute actual
          ON actual.attrelid=relation.oid AND actual.attname=required.column_name
         AND actual.attnum>0 AND NOT actual.attisdropped''').fetchall()
    present={(row['schema_name'],row['table_name'],row['column_name']):row['attnotnull']
             for row in columns if row['attnotnull'] is not None}
    if (set(present)!={('kb','chunks','context_order'),('kb','citations','operation'),
                      ('kb','citations','context_relation')} or
            present[('kb','chunks','context_order')] is not True or
            present[('kb','citations','operation')] is not True):
        return False

    constraints=conn.execute('''WITH required(table_name,constraint_name) AS (
          VALUES ('kb.entities','entity_envelope_keys'),
                 ('kb.entities','entity_scoped_identity'),
                 ('kb.citations','citations_context_relation_check'))
        SELECT required.constraint_name,actual.conname
        FROM required
        LEFT JOIN pg_catalog.pg_constraint actual
          ON actual.conrelid=pg_catalog.to_regclass(required.table_name)
         AND actual.conname=required.constraint_name''').fetchall()
    if any(row['conname']!=row['constraint_name'] for row in constraints):
        return False

    required_functions={'reject_immutable_change','guard_release_member',
                         'guard_accepted_index','guard_accepted_release',
                         'lock_current_policy_shared','restore_ready'}
    functions=conn.execute('''SELECT proc.proname,pg_catalog.pg_get_functiondef(proc.oid) AS definition
        FROM pg_catalog.pg_proc proc JOIN pg_catalog.pg_namespace ns ON ns.oid=proc.pronamespace
        WHERE ns.nspname='kb' AND proc.proname=ANY(%s)''',
        (list(required_functions),)).fetchall()
    definitions={row['proname']:row['definition'] for row in functions}
    if (not required_functions.issubset(definitions) or
            'complete release acceptance receipt required' not in definitions['guard_accepted_release'] or
            'pg_advisory_xact_lock_shared' not in definitions['lock_current_policy_shared'] or
            'restore_state' not in definitions['restore_ready']):
        return False

    required_triggers={
        ('kb','entities','entities_immutable'),('kb','chunks','chunks_immutable'),
        ('kb_private','provenance','provenance_immutable'),
        ('kb','release_members','release_members_sealed'),
        ('kb','index_builds','indexes_sealed'),('kb','releases','releases_sealed'),
        ('kb','release_chunk_origins','release_origins_sealed'),
        ('kb','chunk_origins','chunk_origins_immutable'),
        ('kb','release_relation_origins','relation_origins_sealed'),
        ('kb','release_source_groups','source_groups_sealed'),
        ('kb','release_chunk_dependencies','chunk_dependencies_sealed'),
    }
    triggers=conn.execute('''SELECT ns.nspname,relation.relname,tg.tgname
        FROM pg_catalog.pg_trigger tg
        JOIN pg_catalog.pg_class relation ON relation.oid=tg.tgrelid
        JOIN pg_catalog.pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE NOT tg.tgisinternal AND tg.tgenabled<>'D'
          AND ns.nspname IN ('kb','kb_private')''').fetchall()
    if not required_triggers.issubset({(row['nspname'],row['relname'],row['tgname']) for row in triggers}):
        return False

    required_indexes={
        'entities_payload_gin','entities_type','chunks_ru','chunks_en','chunks_ids','chunks_cjk',
        'entity_source_version_key','entity_parent_key','entity_relation_from_key','entity_relation_to_key',
        'acquisition_binding_variant','release_source_group_members','release_dependency_targets',
        'release_chunk_origin_lookup','structured_document_lookup','chunks_context_order_source',
        'chunks_caption_context_lookup','chunks_audio_context_lookup','chunks_context_track_lookup',
        'embeddings_config_chunk','embedding_checkpoints_content_config_idx',
    }
    indexes=conn.execute("SELECT indexname FROM pg_catalog.pg_indexes WHERE schemaname IN ('kb','kb_private')").fetchall()
    if not required_indexes.issubset({row['indexname'] for row in indexes}):
        return False

    required_roles={'kb_ingest','kb_readsearch','kb_policy_gate_owner','kb_restore_gate_owner'}
    roles=conn.execute('SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY(%s)',
                       (list(required_roles),)).fetchall()
    if not required_roles.issubset({row['rolname'] for row in roles}):
        return False
    if not conn.execute("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname='vector') AS present").fetchone()['present']:
        return False
    seeds=conn.execute('''SELECT EXISTS(SELECT 1 FROM kb.active_release WHERE singleton) AS active_release,
                                 EXISTS(SELECT 1 FROM kb.policy_state WHERE singleton) AS policy_state''').fetchone()
    return seeds['active_release'] is True and seeds['policy_state'] is True


def _catalog_has_objects(conn):
    return conn.execute('''SELECT EXISTS(
        SELECT 1 FROM pg_catalog.pg_class relation
        JOIN pg_catalog.pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname IN ('kb','kb_private')
          AND NOT (ns.nspname='kb' AND relation.relname='schema_migrations')
          AND relation.relkind IN ('r','p','v','m','S','f')) AS present''').fetchone()['present']


def _catalog_migration_source(raw):
    source=raw.decode('utf-8')
    return re.sub(r'(?im)^[ \t]*(?:BEGIN|COMMIT)[ \t]*;[ \t]*$', '', source)


def _adopt_legacy_catalog(conn,migrations):
    by_name={migration.name:migration for migration in migrations}
    if any(name not in by_name for name in _LEGACY_CATALOG_MIGRATIONS):
        raise RuntimeError('cannot adopt catalog schema: baseline migration set is incomplete')
    complete=_legacy_catalog_complete(conn)
    conn.commit()
    if not complete:
        raise RuntimeError('untracked catalog schema is partial; refusing automatic migration adoption')
    adopted={}
    with conn.transaction():
        for name in _LEGACY_CATALOG_MIGRATIONS:
            checksum=hashlib.sha256(by_name[name].read_bytes()).hexdigest()
            conn.execute('''INSERT INTO kb.schema_migrations(migration_id,checksum,adopted)
                VALUES(%s,%s,TRUE)''',(name,checksum))
            adopted[name]=checksum
    return adopted

def ensure_schema():
    """Apply immutable, checksummed catalog migrations; adopt only verified legacy schemas."""
    sql=Path(__file__).resolve().parents[2]/'sql/catalog'
    migrations=sorted(sql.glob('*.sql'))
    with connect(admin=True) as conn:
        conn.execute('CREATE SCHEMA IF NOT EXISTS kb')
        conn.execute('''CREATE TABLE IF NOT EXISTS kb.schema_migrations(
            migration_id text PRIMARY KEY,
            checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
            adopted boolean NOT NULL DEFAULT false,
            applied_at timestamptz NOT NULL DEFAULT now())''')
        conn.execute('REVOKE ALL ON kb.schema_migrations FROM PUBLIC')
        conn.execute('''DO $$ BEGIN
            IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='kb_ingest') THEN
                EXECUTE 'REVOKE ALL ON TABLE kb.schema_migrations FROM kb_ingest';
            END IF;
            IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='kb_readsearch') THEN
                EXECUTE 'REVOKE ALL ON TABLE kb.schema_migrations FROM kb_readsearch';
            END IF;
            IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='kb_search_projection_owner') THEN
                EXECUTE 'REVOKE ALL ON TABLE kb.schema_migrations FROM kb_search_projection_owner';
            END IF;
        END $$;''')
        conn.commit()
        conn.execute('SELECT pg_advisory_lock(hashtextextended(%s,0))',
                     ('hardissoft-kb-schema-migrations',))
        conn.commit()
        relation=conn.execute("SELECT relkind FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('kb.schema_migrations')").fetchone()
        ledger_columns=conn.execute('''SELECT column_name FROM information_schema.columns
            WHERE table_schema='kb' AND table_name='schema_migrations' ''').fetchall()
        conn.commit()
        if (not relation or relation['relkind']!='r' or
                {row['column_name'] for row in ledger_columns}!={'migration_id','checksum','adopted','applied_at'}):
            raise RuntimeError('catalog migration ledger has an incompatible schema')

        applied_rows=conn.execute('SELECT migration_id,checksum FROM kb.schema_migrations').fetchall()
        conn.commit()
        known={migration.name:migration for migration in migrations}
        applied={row['migration_id']:row['checksum'] for row in applied_rows}
        if set(applied)-set(known):
            raise RuntimeError('catalog migration ledger references a missing migration file')
        for name,checksum in applied.items():
            if hashlib.sha256(known[name].read_bytes()).hexdigest()!=checksum:
                raise RuntimeError('catalog migration changed after application: '+name)
        if not applied and _catalog_has_objects(conn):
            conn.commit()
            applied=_adopt_legacy_catalog(conn,migrations)
        else:
            conn.commit()
        seen_pending=False
        for migration in migrations:
            if migration.name in applied:
                if seen_pending:
                    raise RuntimeError('catalog migration ledger has an unapplied history gap')
                continue
            seen_pending=True
            raw=migration.read_bytes()
            checksum=hashlib.sha256(raw).hexdigest()
            with conn.transaction():
                conn.execute(_catalog_migration_source(raw),prepare=False)
                conn.execute('''INSERT INTO kb.schema_migrations(migration_id,checksum,adopted)
                    VALUES(%s,%s,FALSE)''',(migration.name,checksum))
            applied[migration.name]=checksum

def resolve_review_ref(reference):
    """Resolve actual immutable review bytes, never merely a claimed nonempty ID."""
    if isinstance(reference,dict):
        sha=reference.get('sha256','')
        path=Path(reference.get('path',''))
        if not _HASH.fullmatch(sha) or not path.is_absolute() or not path.is_file():raise ValueError('unresolved review artifact')
        if path.stat().st_size>4*1024*1024:raise ValueError('review artifact exceeds bounded receipt size')
        if hashlib.sha256(path.read_bytes()).hexdigest()!=sha:raise ValueError('review artifact hash mismatch')
        return sha
    if isinstance(reference,str):
        with connect() as conn:
            row=conn.execute("SELECT payload FROM kb.entities WHERE id=%s AND entity_type='decision'",(reference,)).fetchone()
        if row:return digest(row['payload'])
    raise ValueError('review reference must resolve to hashed artifact or immutable decision')

def review_model_allowed(receipt,policy=None):
    """Apply current admission routing; historical review evidence is never relabeled."""
    if not isinstance(receipt,dict):return False
    if policy is None:
        path=Path(os.environ.get('HIS_KB_REVIEW_MODEL_POLICY',str(ROOT/'config/model-policy.json')))
        try:policy=json.loads(path.read_text())
        except (OSError,ValueError):return False
    if not isinstance(policy,dict):return False
    resolved=receipt.get('resolved_model')
    # Explicit owner opt-in: any model may review; reviewer independence is still enforced by validate_review.
    if policy.get('any_review_model') is True:return bool(isinstance(resolved,str) and resolved.strip())
    model=policy.get('allowed_resolved_model')
    selector=policy.get('requested_selector')
    return bool(isinstance(model,str) and isinstance(selector,str) and model and selector and resolved==model and receipt.get('requested_selector')==selector)

def validate_review(receipt,manifest_sha256,producer):
    if not isinstance(receipt,dict) or receipt.get('status')!='accepted':raise ValueError('independent acceptance required')
    if receipt.get('manifest_sha256')!=manifest_sha256:raise ValueError('review manifest mismatch')
    if not review_model_allowed(receipt):raise ValueError('review model violates current dated policy')
    if not receipt.get('reviewer_id') or receipt['reviewer_id']==producer:raise ValueError('separate reviewer required')
    if receipt['reviewer_id'] in receipt.get('author_ids',[]):raise ValueError('reviewer is an author')
    if not isinstance(receipt.get('accepted_variant_ids'),list):raise ValueError('explicit accepted variant set required')
    if receipt.get('purpose')!='internal_retrieval':raise ValueError('purpose-specific acceptance required')
    if not isinstance(receipt.get('source_check_refs'),list) or not receipt['source_check_refs']:raise ValueError('actual source checks required')
    for reference in receipt['source_check_refs']:resolve_review_ref(reference)
    return receipt

def safe_locator(locator):
    if not isinstance(locator,dict):return None
    kind=locator.get('kind')
    keys={
      'text':('section_path','start_char','end_char'), 'pdf':('page_index','page_end_index','page_label','block_index'),
      'table_cell':('sheet_name','row_index','column_index','a1_ref','header_path'),
      'audio':('stream_index','start_ms','end_ms','time_basis','segment_id'),
      'frame':('stream_index','pts','time_base','timestamp_ms'),
      'forum':('namespace','native_id_format','topic_id','post_id','start_char','end_char','source_span'),
      'qa_answer':('site','question_id','answer_id','start_char','end_char'),
      'source_record':('precision','coordinate_space','fallback_reason')}.get(kind)
    if keys is None:return None
    required={'text':('start_char','end_char'),'pdf':('page_index',),'table_cell':('row_index','column_index'),
      'audio':('start_ms','end_ms','time_basis'),'frame':('pts','time_base'),'forum':('post_id',),'qa_answer':('question_id','answer_id'),'source_record':('precision','coordinate_space','fallback_reason')}[kind]
    if any(locator.get(k) is None for k in required):return None
    for k in ('start_char','end_char','page_index','page_end_index','row_index','column_index','start_ms','end_ms'):
        if k in locator and (type(locator[k]) is not int or locator[k]<0):return None
    for start,end in (('start_char','end_char'),('start_ms','end_ms'),('page_index','page_end_index')):
        if start in locator and end in locator and locator[end]<locator[start]:return None
    mapped=locator.get('native_id_format')=='opaque_mapped'
    if mapped:
        if not locator.get('mapping_ref'):return None
        for key in ('post_id','topic_id','question_id','answer_id'):
            if key in locator and not re.fullmatch(r'private-target:[a-f0-9]{64}',str(locator[key])):return None
    else:
        for key in ('question_id','answer_id'):
            if key in locator and (isinstance(locator[key],bool) or not re.fullmatch(r'[1-9][0-9]*',str(locator[key]))):return None
        if kind=='forum':
            native=str(locator.get('post_id',''))
            namespace=str(locator.get('namespace','')).casefold()
            if isinstance(locator.get('post_id'),bool):return None
            if namespace in ('reddit','reddit.com'):
                if not re.fullmatch(r'(?:t1_|t3_)?[a-z0-9]+',native):return None
            elif not re.fullmatch(r'[1-9][0-9]*',native):return None
    if kind=='forum' and 'source_span' in locator:
        span=locator['source_span']
        if (not isinstance(span,dict) or set(span)!={'start','end'} or
            type(span.get('start')) is not int or type(span.get('end')) is not int or
            not 0<=span['start']<=span['end']):
            return None
        if locator.get('coordinate_space')!='redacted_variant':return None
    if kind=='source_record' and locator.get('precision')!='coarse':return None
    common=('adapted','coordinate_space','mapping_ref','start_char','end_char','namespace','native_id_format','precision','fallback_reason')
    keys=tuple(dict.fromkeys(keys+common))
    if kind=='source_record':
        keys=('precision','coordinate_space','fallback_reason','adapted','mapping_ref','artifact_sha256','source_artifact_sha256','quote_kind')
        for key in ('artifact_sha256','source_artifact_sha256'):
            if key in locator and (not isinstance(locator[key],str) or not _HASH.fullmatch(locator[key])):return None
    if locator.get('mapping_ref') and not re.fullmatch(r'private:(?:privacy-mapping:)?[a-f0-9]{64}',str(locator['mapping_ref'])):return None
    result={'kind':kind,**{k:locator[k] for k in keys if k in locator and locator[k] is not None}}
    if len(result)==1:return None
    # Nested locator strings must not carry a URL or server path.
    rendered=json.dumps(result,ensure_ascii=False)
    if re.search(r'https?://|/(?:srv|home|tmp|root|mnt)/',rendered):return None
    return result

def _context_order(document):
    """Store only typed native ordering coordinates; never expose original offsets."""
    from fractions import Fraction
    if not isinstance(document,dict):return None
    provenance=document.get('provenance',{})
    original=provenance.get('original_document') if isinstance(provenance,dict) else None
    locator=original.get('locator') if isinstance(original,dict) else None
    if not isinstance(locator,dict):locator=document.get('locator')
    if not isinstance(locator,dict):return None
    kind=locator.get('kind')
    def nonnegative(name):return type(locator.get(name)) is int and locator[name]>=0
    if kind=='audio':
        fields=('stream_index','audio_window_index','segment_index','source_window_pts','source_window_time_base','source_window_start_seconds','time_basis')
        if any(locator.get(key) is None for key in fields) or any(not nonnegative(key) for key in ('stream_index','audio_window_index','segment_index')):
            return None
        if type(locator['source_window_pts']) is not int or locator['time_basis']!='asr_window_relative_estimate' or not re.fullmatch(r'[1-9][0-9]*/[1-9][0-9]*',str(locator['source_window_time_base'])):
            return None
        try:
            origin=Fraction(str(locator['source_window_start_seconds']))
        except (ValueError,ZeroDivisionError,TypeError):return None
        if origin<0:return None
        track={key:locator[key] for key in ('kind','stream_index','audio_window_index','source_window_pts','source_window_time_base','source_window_start_seconds','time_basis')}
        return {'track':track,'position_kind':'segment_index','position':locator['segment_index']}
    if kind=='text':
        stream=locator.get('stream_index')
        track={'kind':'text'}
        if isinstance(locator.get('time_basis'),str) and locator['time_basis']:track['time_basis']=locator['time_basis']
        if type(stream) is int and stream>=0:track['stream_index']=stream
        if locator.get('time_basis')=='explicit_caption_timestamp' and nonnegative('timestamp_ms'):
            method=locator.get('timestamp_method')
            if not isinstance(method,str) or not method:return None
            track['timestamp_method']=method
            return {'track':track,'position_kind':'timestamp_ms','position':locator['timestamp_ms']}
        if nonnegative('segment_index'):
            return {'track':track,'position_kind':'segment_index','position':locator['segment_index']}
        if locator.get('coordinate_space')!='redacted_variant' and nonnegative('start_char'):
            if isinstance(locator.get('coordinate_space'),str) and locator['coordinate_space']:
                track['coordinate_space']=locator['coordinate_space']
                return {'track':track,'position_kind':'start_char','position':locator['start_char']}
    if kind=='frame' and nonnegative('stream_index'):
        track={'kind':'frame','stream_index':locator['stream_index']}
        if type(locator.get('pts')) is int and isinstance(locator.get('time_base'),str) and re.fullmatch(r'[1-9][0-9]*/[1-9][0-9]*',locator['time_base']):
            track['time_base']=locator['time_base'];return {'track':track,'position_kind':'pts','position':locator['pts']}
        if nonnegative('timestamp_ms') and isinstance(locator.get('timestamp_method'),str) and locator['timestamp_method']:
            track['timestamp_method']=locator['timestamp_method'];return {'track':track,'position_kind':'timestamp_ms','position':locator['timestamp_ms']}
    return None

def _jsonl(path):
    if not path.exists():return []
    return [json.loads(line) for line in path.read_text().split('\n') if line.strip()]

def _put_entity(conn,row,kind,package_id):
    from psycopg.types.json import Jsonb
    row=dict(row)
    entity_id=row.get('id') or 'outcome:'+digest([package_id,row])
    row['id']=entity_id
    corpus=row.get('corpus_id','package-outcome')
    provenance=row.get('provenance_ref')
    if isinstance(provenance,dict):provenance=provenance.get('id')
    if not provenance:provenance='package:'+package_id
    conn.execute('''INSERT INTO kb.entities(id,entity_type,package_id,corpus_id,provenance_ref,scope,payload)
      VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(id) DO NOTHING''',
      (entity_id,kind,package_id,corpus,provenance,Jsonb(row.get('scope',{'kind':'global'})),Jsonb(row)))
    old=conn.execute('SELECT payload FROM kb.entities WHERE id=%s',(entity_id,)).fetchone()
    if old['payload']!=row:raise ValueError('conflicting immutable entity '+entity_id)
    conn.execute('INSERT INTO kb.entity_packages VALUES(%s,%s) ON CONFLICT DO NOTHING',(entity_id,package_id))
    return row
def import_package(package_dir,*,review_receipt=None,release_id=None):
    from .package_io import validate_package
    from psycopg.types.json import Jsonb
    path=Path(package_dir)
    valid=validate_package(path)
    if not valid.get('valid'):raise ValueError('invalid sealed package: '+str(valid.get('errors')))
    raw=(path/'package.json').read_bytes(); manifest=json.loads(raw)
    sha=hashlib.sha256(raw).hexdigest(); package_id=manifest['package_id']
    producer=manifest.get('producer',{})
    if isinstance(producer,dict):producer=producer.get('agent_id') or producer.get('name') or json.dumps(producer,sort_keys=True)
    if isinstance(review_receipt,(str,Path)):review_receipt=json.loads(Path(review_receipt).read_text())
    if review_receipt is not None:validate_review(review_receipt,sha,producer)
    accepted=set((review_receipt or {}).get('accepted_variant_ids',[]))
    from .privacy import parent_dependencies
    ancestry=parent_dependencies(path)
    for parent in ancestry.get('parent_package_dirs',[]):
        if Path(parent).resolve()==path.resolve():raise ValueError('cyclic parent package')
        import_package(parent)  # private originals only; never implicit admission
    with connect() as conn:
        conn.execute('SELECT pg_advisory_xact_lock(hashtext(%s))',('package:'+package_id,))
        old=conn.execute('SELECT manifest_sha256,review_receipt FROM kb.packages WHERE package_id=%s',(package_id,)).fetchone()
        if old and old['manifest_sha256']!=sha:raise ValueError('package id collision')
        conn.execute('INSERT INTO kb.packages(package_id,manifest_sha256,manifest,review_receipt) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',(package_id,sha,Jsonb(manifest),Jsonb(review_receipt) if review_receipt else None))
        if review_receipt and old:
            if old['review_receipt'] and old['review_receipt']!=review_receipt:raise ValueError('acceptance immutable')
            conn.execute('UPDATE kb.packages SET review_receipt=%s WHERE package_id=%s',(Jsonb(review_receipt),package_id))
        private=_jsonl(path/'private/provenance.jsonl')
        for row in private:
            pid=row.get('id') or row.get('provenance_id')
            if not pid:raise ValueError('private provenance needs id')
            conn.execute('INSERT INTO kb_private.provenance VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',(pid,package_id,Jsonb(row)))
            actual=conn.execute('SELECT payload FROM kb_private.provenance WHERE id=%s',(pid,)).fetchone()
            if actual['payload']!=row:raise ValueError('private provenance collision')
            conn.execute('INSERT INTO kb_private.provenance_packages VALUES(%s,%s) ON CONFLICT DO NOTHING',(pid,package_id))
        rows=[]
        for filename,kind in _FILES.items():
            for row in _jsonl(path/filename):rows.append(_put_entity(conn,row,kind,package_id))
        by_id={r['id']:r for r in rows}
        accepted_relation_ids=(review_receipt or {}).get('accepted_relation_ids',[])
        if (not isinstance(accepted_relation_ids,list) or
                any(not isinstance(value,str) or not value for value in accepted_relation_ids) or
                len(accepted_relation_ids)!=len(set(accepted_relation_ids))):
            raise ValueError('accepted_relation_ids must be unique non-empty strings')
        package_relation_ids={row['id'] for row in rows if row.get('entity_type')=='relation'}
        if not set(accepted_relation_ids)<=package_relation_ids:
            raise ValueError('accepted relation absent from package')
        for row in rows:
            for key in ('source_id','source_version_id','artifact_id','parent_id','variant_id','from_id','to_id'):
                target=row.get(key)
                if target and conn.execute('SELECT 1 FROM kb.entities WHERE id=%s',(target,)).fetchone():
                    conn.execute('INSERT INTO kb.entity_dependencies VALUES(%s,%s) ON CONFLICT DO NOTHING',(row['id'],target))
        made=[]
        for vid in sorted(accepted):
            variant=by_id.get(vid)
            if not variant:raise ValueError('accepted variant absent')
            chunk=_project_variant(conn,variant,by_id,package_id,review_receipt,ancestry.get('dependencies',{}).get(vid,[]))
            made.append(chunk)
        if release_id:
            if not review_receipt:raise ValueError('cannot admit unreviewed package')
            _add_members(conn,release_id,[r['chunk_id'] for r in made],package_id=package_id)
            for relation_id in sorted(accepted_relation_ids):
                conn.execute('INSERT INTO kb.release_relation_origins (release_id,relation_id,package_id) VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',
                    (release_id,relation_id,package_id))
            _refresh_release_source_groups(conn,release_id)
            closure=release_closure(release_id,conn)
            conn.execute('UPDATE kb.releases SET closure_sha256=%s WHERE release_id=%s',(closure,release_id))
            conn.execute("UPDATE kb.index_builds SET status='stale' WHERE release_id=%s AND spec->>'closure_sha256' IS DISTINCT FROM %s",(release_id,closure))
    return {'package_id':package_id,'manifest_sha256':sha,'imported_entities':len(rows),'accepted_chunks':len(made),'admitted':bool(release_id),'idempotent':bool(old)}

def _refresh_release_source_groups(conn,release_id):
    from psycopg.types.json import Jsonb
    from .adapters.common import stable_id
    from .relations import _equivalence_evidence,equivalence_groups
    release=conn.execute('SELECT status FROM kb.releases WHERE release_id=%s FOR UPDATE',(release_id,)).fetchone()
    if not release or release['status']!='candidate':raise ValueError('mutable candidate release required')
    source_rows=conn.execute('''SELECT DISTINCT c.source_id FROM kb.release_members m
      JOIN kb.chunks c ON c.chunk_id=m.entity_id WHERE m.release_id=%s ORDER BY c.source_id''',(release_id,)).fetchall()
    source_ids=[row['source_id'] for row in source_rows]
    source_id_set=set(source_ids)
    relation_rows=conn.execute('''SELECT o.relation_id,e.payload FROM kb.read_release_relation_origins o
      JOIN kb.entities e ON e.id=o.relation_id
      WHERE o.release_id=%s AND e.entity_type='relation'
        AND e.payload->>'kind' IN ('same_source','equivalent_source')
        AND e.payload->>'basis'='explicit'
      ORDER BY o.relation_id,o.package_id''',(release_id,)).fetchall()
    edges=[]
    for row in relation_rows:
        edge=row['payload']
        if not _equivalence_evidence(edge.get('evidence_ref')):
            continue
        if edge.get('from_id') in source_id_set and edge.get('to_id') in source_id_set:
            edges.append(dict(edge,id=row['relation_id']))
    groups=equivalence_groups([{'id':source_id} for source_id in source_ids],edges)
    conn.execute('DELETE FROM kb.release_source_groups WHERE release_id=%s',(release_id,))
    for component in groups:
        members=sorted(component)
        member_set=set(members)
        group_id=stable_id('release-source-group',release_id,*members)
        relation_ids=sorted(edge['id'] for edge in edges
                            if edge['from_id'] in member_set and edge['to_id'] in member_set)
        for source_id in members:
            conn.execute('''INSERT INTO kb.release_source_groups
              (release_id,source_id,group_id,relation_ids) VALUES(%s,%s,%s,%s)
              ON CONFLICT(release_id,source_id) DO UPDATE SET
              group_id=excluded.group_id,relation_ids=excluded.relation_ids''',
              (release_id,source_id,group_id,Jsonb(relation_ids)))

def _project_variant(conn,v,by_id,package_id,receipt,dependency_ids=()):
    from psycopg.types.json import Jsonb
    block=by_id.get(v.get('parent_id'),{})
    source_version=by_id.get(block.get('source_version_id'),{})
    source=by_id.get(source_version.get('source_id'),{})
    text=v.get('text',''); state=v.get('privacy_state','unreviewed')
    if state not in ('machine_screened','reviewed_safe') or not text.strip():raise ValueError('accepted variant is not screened safe content')
    locator=safe_locator(v.get('locator') or block.get('locator'))
    source_sha=source_version.get('payload_sha256','')
    if not locator or not _HASH.fullmatch(source_sha):raise ValueError('safe locator/source hash unresolved')
    pref=v.get('provenance_ref') or block.get('provenance_ref')
    if isinstance(pref,dict):pref=pref.get('id')
    private=conn.execute('SELECT payload FROM kb_private.provenance WHERE id=%s',(pref,)).fetchone() if pref else None
    if not private:raise ValueError('private provenance unresolved')
    acquisitions=conn.execute("""SELECT p.id,p.payload FROM kb_private.provenance p
      JOIN kb_private.provenance_packages m ON m.provenance_id=p.id
      WHERE m.package_id=%s AND p.payload->>'binding_ref'=%s AND p.payload->>'variant_id'=%s ORDER BY p.id""",(package_id,pref,v['id'])).fetchall()
    if len(acquisitions)!=1:raise ValueError('exact package variant acquisition required')
    document=acquisitions[0]['payload']['document']
    context_order=_context_order(document) or {}
    metadata=document.get('metadata',{})
    if metadata.get('version_state') in ('superseded','conflict','withdrawn') or metadata.get('privacy_state')=='quarantined':raise ValueError('source variant currently denied')
    if v.get('variant_kind') not in ('original','verbatim') and not v.get('mapping_ref'):raise ValueError('derivative private mapping required')
    sha=hashlib.sha256(text.encode()).hexdigest()
    if sha!=v.get('text_sha256'):raise ValueError('variant text hash mismatch')
    cid='chunk:'+digest([v['id'],'whole-variant-v1',sha])
    scope=v.get('scope',{'kind':'global'})
    group=source['id'] # native source identity, never corpus import ID or similarity
    original=document.get('provenance',{}).get('original_document')
    if locator.get('native_id_format')=='opaque_mapped':
        if not isinstance(original,dict) or not safe_locator(original.get('locator')) or not document.get('provenance',{}).get('privacy_mapping'):raise ValueError('mapped native target lacks validated private original')
        if locator.get('mapping_ref')!=v.get('mapping_ref'):raise ValueError('native mapping reference mismatch')
    if isinstance(original,dict) and original.get('source_key') and document.get('provenance',{}).get('parent_block_id'):
        from .adapters.common import stable_id
        group=stable_id('source',original['corpus_id'],'native-v1',original['source_key'])
    if isinstance(original,dict):
        inherited=original.get('metadata',{})
        if inherited.get('version_state') in ('superseded','conflict','withdrawn'):raise ValueError('inherited source version denied')
        if any(inherited.get(key) is True for key in ('denied','quarantined','withdrawn','revoked')):raise ValueError('inherited current denial cannot be superseded by package review')
    overrides=receipt.get('superseding_policy_decisions',[])
    privacy_override=False
    for decision in overrides:
        expected={'dimension':'internal_retrieval','value':'allow','target_type':'variant','target_id':v['id'],
          'source_version_id':source_version['id'],'manifest_sha256':receipt['manifest_sha256'],'text_sha256':sha,
          'privacy_state':'machine_screened','purpose':'internal_retrieval','scope':'exact_variant_only',
          'reviewer_id':receipt['reviewer_id'],'resolved_model':receipt['resolved_model']}
        if all(decision.get(k)==value for k,value in expected.items()) and all(decision.get(k) for k in ('decision_id','supersedes_decision_refs','privacy_receipt_ref','source_check_refs','limitations')):
            if not any(isinstance(ref,dict) and ref.get('sha256')==_PRIVACY_GUARD_SHA256 for ref in decision['supersedes_decision_refs']):
                raise ValueError('override does not name exact inherited forum guard')
            resolve_review_ref({'path':str(_PRIVACY_GUARD_PATH),'sha256':_PRIVACY_GUARD_SHA256})
            if decision['privacy_receipt_ref']!=receipt.get('privacy_receipt_ref'):raise ValueError('override privacy receipt mismatch')
            resolve_review_ref(decision['privacy_receipt_ref'])
            if any(ref not in receipt['source_check_refs'] for ref in decision['source_check_refs']):raise ValueError('override source checks not in Q03 review')
            for ref in decision['source_check_refs']:resolve_review_ref(ref)
            privacy_override=True
    if any(metadata.get(key) for key in ('pending_markers','pending_privacy_markers','pii_markers_present','retrieval_denied','historical_only')):raise ValueError('source privacy markers still pending')
    is_forum=locator.get('kind')=='forum' or metadata.get('source_type')=='forum_text' or (isinstance(original,dict) and original.get('locator',{}).get('kind')=='forum')
    if is_forum and state=='machine_screened' and not privacy_override:raise ValueError('exact forum guard supersession required')
    chunk={'id':cid,'entity_type':'chunk','variant_id':v['id'],'source_version_id':source_version['id'],'source_id':source['id'],'corpus_id':v['corpus_id'],'scope':scope,'provenance_ref':pref,'review_state':'independently_reviewed'}
    _put_entity(conn,chunk,'chunk',package_id)
    for dep in (v['id'],source_version['id'],source['id']):conn.execute('INSERT INTO kb.entity_dependencies VALUES(%s,%s) ON CONFLICT DO NOTHING',(cid,dep))
    language=v.get('language') or block.get('language') or source.get('language','und')
    modality=v.get('modality') or block.get('modality','text')
    role=v.get('content_role')
    if role not in ('source_content','derived_evidence','source_catalog','product_context','operation_template','process_record','project_fact','generated_draft'):raise ValueError('selected variant semantic role required')
    limits=list(dict.fromkeys(block.get('limitations',[])+v.get('limitations',[])))
    if v.get('variant_kind') not in ('original','verbatim'):limits.append('adapted_or_redacted')
    conn.execute('''INSERT INTO kb.chunks(chunk_id,variant_id,source_version_id,source_id,evidence_source_group_id,context_order,retrieval_text,text_sha256,language,modality,content_role,collection_id,scope,safe_locator,limitations,privacy_state,provenance_ref,source_sha256,technical_ids,cjk_terms)
      VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
      (cid,v['id'],source_version['id'],source['id'],group,Jsonb(context_order),text,sha,language,modality,role,v['corpus_id'],Jsonb(scope),Jsonb(locator),Jsonb(limits),state,pref,source_sha,technical_ids(text),cjk_bigrams(text)))
    origin_dependencies=sorted(set(dependency_ids)|{'package:'+package_id,pref,acquisitions[0]['id']})
    conn.execute('INSERT INTO kb.chunk_origins VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',(cid,package_id,Jsonb(origin_dependencies),privacy_override))
    origin=conn.execute('SELECT dependency_ids,operator_privacy_accepted FROM kb.chunk_origins WHERE chunk_id=%s AND package_id=%s',(cid,package_id)).fetchone()
    if origin['dependency_ids']!=origin_dependencies or origin['operator_privacy_accepted']!=privacy_override:raise ValueError('immutable origin collision')
    # Only the independently admitted derivative's screened cells, never its original_document.
    for index,cell in enumerate(metadata.get('cells',[])):
        if not isinstance(cell,dict):raise ValueError('structured cell object required')
        cell_locator=safe_locator(cell.get('locator'))
        if not cell_locator:raise ValueError('structured cell locator unresolved')
        values={k:cell[k] for k in ('raw_value','parsed_value','parse_state','formula','cached_value','header_path','unit','currency','quantity_break','cell_type') if k in cell}
        cell_id='cell:'+digest([v['id'],index,values,cell_locator])
        row={'id':cell_id,'entity_type':'cell','corpus_id':v['corpus_id'],'scope':scope,'provenance_ref':pref,
          'document_id':cid,'source_version_id':source_version['id'],'variant_id':v['id'],'locator':cell_locator,
          'semantic_review_state':'candidate_unverified',**values}
        _put_entity(conn,row,'cell',package_id)
        conn.execute('INSERT INTO kb.entity_dependencies VALUES(%s,%s) ON CONFLICT DO NOTHING',(cid,cell_id))
        conn.execute('INSERT INTO kb.entity_dependencies VALUES(%s,%s) ON CONFLICT DO NOTHING',(cell_id,v['id']))
    return {'chunk_id':cid}

def _add_members(conn,release_id,chunk_ids,*,package_id=None):
    chunk_ids=list(chunk_ids)
    _lock_release_index(conn,release_id)
    status=conn.execute('SELECT status FROM kb.releases WHERE release_id=%s FOR UPDATE',(release_id,)).fetchone()
    if not status or status['status']!='candidate':raise ValueError('mutable candidate release required')
    for cid in chunk_ids:
        conn.execute('''WITH RECURSIVE closure(id) AS (SELECT %s::text UNION SELECT d.dependency_id FROM kb.entity_dependencies d JOIN closure c ON c.id=d.entity_id)
        INSERT INTO kb.release_members SELECT %s,id FROM closure ON CONFLICT DO NOTHING''',(cid,release_id))
        if package_id and conn.execute('SELECT 1 FROM kb.chunk_origins WHERE chunk_id=%s AND package_id=%s',(cid,package_id)).fetchone():
            conn.execute('INSERT INTO kb.release_chunk_origins VALUES(%s,%s,%s) ON CONFLICT DO NOTHING',(release_id,cid,package_id))
            origin=conn.execute('SELECT dependency_ids FROM kb.chunk_origins WHERE chunk_id=%s AND package_id=%s',(cid,package_id)).fetchone()
            for dependency in origin['dependency_ids']:
                if conn.execute('SELECT 1 FROM kb.entities WHERE id=%s',(dependency,)).fetchone():
                    conn.execute('''WITH RECURSIVE closure(id) AS (SELECT %s::text UNION SELECT d.dependency_id FROM kb.entity_dependencies d JOIN closure c ON c.id=d.entity_id)
                    INSERT INTO kb.release_members SELECT %s,id FROM closure ON CONFLICT DO NOTHING''',(dependency,release_id))
    for cid in chunk_ids:
        conn.execute('''WITH RECURSIVE roots(id) AS (
          SELECT %s::text
          UNION
          SELECT c.evidence_source_group_id FROM kb.chunks c WHERE c.chunk_id=%s
          UNION
          SELECT dep.value FROM kb.release_chunk_origins r
            JOIN kb.chunk_origins o USING(chunk_id,package_id),
            LATERAL jsonb_array_elements_text(o.dependency_ids) dep(value)
            WHERE r.release_id=%s AND r.chunk_id=%s
        ), closure(id) AS (
          SELECT id FROM roots
          UNION
          SELECT d.dependency_id FROM closure c
            JOIN kb.entity_dependencies d ON d.entity_id=c.id
            JOIN kb.release_members m ON m.release_id=%s AND m.entity_id=d.dependency_id
        )
        INSERT INTO kb.release_chunk_dependencies(release_id,chunk_id,dependency_id)
          SELECT %s,%s,id FROM closure
          WHERE EXISTS(SELECT 1 FROM kb.chunks WHERE chunk_id=%s)
          ON CONFLICT DO NOTHING''',
          (cid,cid,release_id,cid,release_id,release_id,cid,cid))
    closure=release_closure(release_id,conn)
    conn.execute('UPDATE kb.releases SET closure_sha256=%s WHERE release_id=%s',(closure,release_id))
    conn.execute("UPDATE kb.index_builds SET status='stale' WHERE release_id=%s AND spec->>'closure_sha256' IS DISTINCT FROM %s",(release_id,closure))

def release_closure(release_id,conn=None):
    if conn is None:
        with connect() as owned:return release_closure(release_id,owned)
    members=[r['entity_id'] for r in conn.execute('SELECT entity_id FROM kb.release_members WHERE release_id=%s ORDER BY entity_id',(release_id,))]
    origins=conn.execute('''SELECT chunk_id,package_id,manifest_sha256 FROM kb.read_release_chunk_origins
      WHERE release_id=%s ORDER BY chunk_id,package_id''',(release_id,)).fetchall()
    relation_origins=conn.execute('''SELECT relation_id,package_id,manifest_sha256 FROM kb.read_release_relation_origins
      WHERE release_id=%s ORDER BY relation_id,package_id''',(release_id,)).fetchall()
    source_groups=conn.execute('SELECT source_id,group_id,relation_ids FROM kb.release_source_groups WHERE release_id=%s ORDER BY source_id',(release_id,)).fetchall()
    return digest({'members':members,'origins':origins,'relation_origins':relation_origins,'source_groups':source_groups})

def build_candidate(package_dirs,release_id=None):
    from psycopg.types.json import Jsonb
    package_dirs=list(package_dirs)
    manifests=[hashlib.sha256((Path(p)/'package.json').read_bytes()).hexdigest() for p in package_dirs]
    release_id=release_id or 'release:'+digest(sorted(manifests))
    with connect() as conn:
        conn.execute('INSERT INTO kb.releases(release_id,status,index_spec) VALUES(%s,\'candidate\',%s) ON CONFLICT DO NOTHING',(release_id,Jsonb({'lexical':{'version':'pg-ru-en-technical-cjk-v1'},'structured':{'version':'cells-links-v1'}})))
    results=[]
    for package in package_dirs:
        receipt_path=Path(package)/'checks/independent-review.json'
        receipt=json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        results.append(import_package(package,review_receipt=receipt,release_id=release_id if receipt else None))
    with connect() as conn:
        ids=[r['entity_id'] for r in conn.execute('SELECT entity_id FROM kb.release_members WHERE release_id=%s ORDER BY entity_id',(release_id,))]
        closure=release_closure(release_id,conn)
        conn.execute('UPDATE kb.releases SET closure_sha256=%s WHERE release_id=%s AND status=\'candidate\'',(closure,release_id))
        for method,version in [('lexical','pg-ru-en-technical-cjk-v1'),('structured','cells-links-v1')]:
            spec={'version':version,'closure_sha256':closure}
            conn.execute('INSERT INTO kb.index_builds(release_id,method,config_hash,spec,status) VALUES(%s,%s,%s,%s,\'built\') ON CONFLICT(release_id,method) DO UPDATE SET config_hash=excluded.config_hash,spec=excluded.spec,status=excluded.status',(release_id,method,digest(spec),Jsonb(spec)))
    return {'release_id':release_id,'status':'candidate','closure_sha256':closure,'packages':results,'members':len(ids)}

def release_info(release_id=None,conn=None):
    if conn is None:
        with connect() as owned:return release_info(release_id,owned)
    if release_id is None:
        pointer=conn.execute('SELECT release_id FROM kb.active_release WHERE singleton').fetchone()
        release_id=pointer['release_id'] if pointer else None
    row=conn.execute('SELECT * FROM kb.releases WHERE release_id=%s',(release_id,)).fetchone()
    if not row:raise LookupError('no active accepted release')
    indexes=conn.execute('SELECT method,config_hash,spec,status FROM kb.index_builds WHERE release_id=%s',(release_id,)).fetchall()
    row['index_spec']={r['method']:{'config_hash':r['config_hash'],**r['spec']} for r in indexes if r['status'] in ('built','accepted')}
    return row

def release_rows(release_id,conn=None,chunk_ids=None):
    if conn is None:
        with connect() as owned:return release_rows(release_id,owned,chunk_ids)
    if chunk_ids is not None:
        chunk_ids=list(dict.fromkeys(chunk_ids))
        if not chunk_ids:return []
        # Aggregate the safe origins once for the bounded set, rather than
        # repeatedly executing their security-barrier view for each hit.
        sql='''WITH selected AS MATERIALIZED (
          SELECT c.*,COALESCE(rsg.group_id,c.evidence_source_group_id) AS effective_evidence_source_group_id
          FROM kb.read_projection c JOIN kb.release_members m ON m.entity_id=c.chunk_id
          LEFT JOIN kb.release_source_groups rsg ON rsg.release_id=m.release_id AND rsg.source_id=c.source_id
          WHERE m.release_id=%s AND c.chunk_id=ANY(%s::text[])
        ), origins AS MATERIALIZED (
          SELECT o.chunk_id,bool_and(o.operator_privacy_accepted) AS operator_privacy_accepted,
            jsonb_agg(DISTINCT jsonb_build_object('package_id',o.package_id,'manifest_sha256',o.manifest_sha256)) AS package_origins,
            bool_and(o.review_accepted) AS review_accepted
          FROM kb.read_release_chunk_origins o JOIN selected s ON s.chunk_id=o.chunk_id
          WHERE o.release_id=%s GROUP BY o.chunk_id
        ), dependencies AS MATERIALIZED (
          SELECT d.chunk_id,jsonb_agg(DISTINCT d.dependency_id) AS dependency_ids
          FROM kb.release_chunk_dependencies d JOIN selected s ON s.chunk_id=d.chunk_id
          WHERE d.release_id=%s GROUP BY d.chunk_id
        )
        SELECT s.*,s.retrieval_text AS text,origin.operator_privacy_accepted,
          dependencies.dependency_ids,origin.package_origins,origin.review_accepted
        FROM selected s JOIN origins origin ON origin.chunk_id=s.chunk_id
        JOIN dependencies ON dependencies.chunk_id=s.chunk_id
        WHERE dependencies.dependency_ids IS NOT NULL AND origin.review_accepted IS TRUE
        ORDER BY s.chunk_id'''
        rows=conn.execute(sql,(release_id,chunk_ids,release_id,release_id)).fetchall()
        for row in rows:
            row['evidence_source_group_id']=row.pop('effective_evidence_source_group_id')
        return rows
    sql='''SELECT c.*,c.retrieval_text AS text,
      origin.operator_privacy_accepted,origin.dependency_ids,origin.package_origins,origin.review_accepted,
      COALESCE(rsg.group_id,c.evidence_source_group_id) AS effective_evidence_source_group_id
      FROM kb.read_projection c JOIN kb.release_members m ON m.entity_id=c.chunk_id
      LEFT JOIN kb.release_source_groups rsg ON rsg.release_id=m.release_id AND rsg.source_id=c.source_id
      JOIN LATERAL (
        SELECT bool_and(o.operator_privacy_accepted) AS operator_privacy_accepted,
          (SELECT jsonb_agg(DISTINCT d.dependency_id) FROM kb.release_chunk_dependencies d
           WHERE d.release_id=m.release_id AND d.chunk_id=c.chunk_id) AS dependency_ids,
          jsonb_agg(DISTINCT jsonb_build_object('package_id',o.package_id,'manifest_sha256',o.manifest_sha256)) AS package_origins,
          bool_and(o.review_accepted) AS review_accepted
        FROM kb.read_release_chunk_origins o
        WHERE o.release_id=m.release_id AND o.chunk_id=c.chunk_id
      ) origin ON origin.dependency_ids IS NOT NULL AND origin.review_accepted IS TRUE
      WHERE m.release_id=%s ORDER BY c.chunk_id'''
    rows=conn.execute(sql,(release_id,)).fetchall()
    for row in rows:
        row['evidence_source_group_id']=row.pop('effective_evidence_source_group_id')
    return rows

def _request_filters(request):
    if request is None:return {},None,None,'explain'
    if not isinstance(request,dict):raise ValueError('search request object required')
    allowed={'query','top_k','operation','languages','modalities','include_neighbors','mode'}
    if set(request)-allowed:raise ValueError('unsupported authorization request fields')
    operation=request.get('operation','explain')
    if operation not in ('explain','rfq','quote_compare'):raise ValueError('unsupported operation')
    filters={}
    for key in ('languages','modalities'):
        value=request.get(key)
        if value is not None:
            if not isinstance(value,list) or not all(isinstance(item,str) and item for item in value):
                raise ValueError(key+' must be a string list')
            if len(value)>64:raise ValueError(key+' filter exceeds 64 values')
            filters[key]=list(dict.fromkeys(value))
    return dict(request),filters.get('languages') or None,filters.get('modalities') or None,operation


def authorized_candidates(context,*,conn,destination=None,include_candidates=False,request=None):
    context=validate_context(context)
    destination=destination or context['purpose']
    if destination not in ('internal_retrieval','external_inference','customer_display') or context['purpose']!=destination:
        raise PermissionError('retrieval destination must match trusted context')
    if type(include_candidates) is not bool:raise ValueError('include_candidates must be boolean')
    request,languages,modalities,operation=_request_filters(request)
    context['operation']=operation
    _assert_restore_ready(conn)
    info=release_info(context.get('release_id'),conn)
    if info['status']!='accepted' and not include_candidates:raise PermissionError('release not accepted')
    revision=_lock_current_policy(conn,shared=True)
    context.update(release_id=info['release_id'],policy_revision=str(revision),policy_current=True,current_denials=[])
    permission_key={'internal_retrieval':'internal_retrieval_allowed',
                    'external_inference':'external_inference_allowed',
                    'customer_display':'customer_display_allowed'}[destination]
    if destination=='internal_retrieval':
        permission_filter='''AND NOT COALESCE(policy_effect.hard_denied,FALSE)
        AND NOT COALESCE(policy_effect.permission_disallowed,FALSE)'''
    else:
        permission_filter='''AND policy_effect.permission_allowed IS TRUE
        AND policy_effect.permission_disallowed IS FALSE
        AND policy_effect.hard_denied IS FALSE'''
    from .search.vector import _ORIGIN_ACCEPTANCE_SQL as origin_acceptance  # one forum rule for vector and candidates
    allow_machine=(destination=='internal_retrieval' and context.get('operator') is True and
                   context.get('allow_machine_screened') is True)
    scope=context['scope']
    sql=f'''WITH origins AS MATERIALIZED (
        SELECT o.release_id,o.chunk_id,
          bool_and(o.operator_privacy_accepted) AS operator_privacy_accepted,
          bool_and(o.review_accepted) AS review_accepted
        FROM kb.read_release_chunk_origins o
        WHERE o.release_id=%s
        GROUP BY o.release_id,o.chunk_id
      ), policy_effects AS MATERIALIZED (
        -- Policy is sparse; use release_dependency_targets instead of probing
        -- every candidate's full dependency closure.
        SELECT d.release_id,d.chunk_id,
          bool_or(pol.denied IS TRUE OR pol.quarantined IS TRUE) AS hard_denied,
          bool_or(pol.permissions ? '{permission_key}' AND
            pol.permissions->'{permission_key}'='true'::jsonb) AS permission_allowed,
          bool_or(pol.permissions ? '{permission_key}' AND
            pol.permissions->'{permission_key}' IS DISTINCT FROM 'true'::jsonb) AS permission_disallowed
        FROM kb.policy pol
        JOIN kb.release_chunk_dependencies d
          ON d.release_id=%s AND d.dependency_id=pol.target_id
        WHERE pol.denied IS TRUE OR pol.quarantined IS TRUE OR pol.permissions ? '{permission_key}'
        GROUP BY d.release_id,d.chunk_id
      )
      SELECT c.*
      FROM kb.read_projection c
      JOIN kb.release_members m ON m.release_id=%s AND m.entity_id=c.chunk_id
      JOIN kb.read_release_accepted_chunk_eligibility eligibility
        ON eligibility.release_id=m.release_id AND eligibility.chunk_id=c.chunk_id
      LEFT JOIN policy_effects policy_effect
        ON policy_effect.release_id=m.release_id AND policy_effect.chunk_id=c.chunk_id
      JOIN origins origin ON origin.release_id=m.release_id AND origin.chunk_id=c.chunk_id
      WHERE origin.operator_privacy_accepted IS NOT NULL AND origin.review_accepted IS TRUE
        AND c.collection_id=ANY(%s::text[])
        AND (c.scope->>'kind'='global' OR
          (%s::text='user' AND c.scope->>'kind'='user' AND c.scope->>'tenant_id'=%s AND
           c.scope->>'owner_user_id'=%s AND %s::text=%s::text) OR
          (%s::text='project' AND c.scope->>'kind'='project' AND c.scope->>'tenant_id'=%s AND
           c.scope->>'project_id'=%s))
        AND (%s::text[] IS NULL OR c.language=ANY(%s::text[]))
        AND (%s::text[] IS NULL OR c.modality=ANY(%s::text[]))
        AND c.content_role NOT IN ('source_catalog','process_record','generated_draft')
        AND (c.content_role NOT IN ('product_context','operation_template') OR %s IN ('rfq','quote_compare'))
        AND (c.privacy_state='reviewed_safe' OR (%s::boolean AND c.privacy_state='machine_screened'))
        AND c.retrieval_text IS NOT NULL AND btrim(c.retrieval_text)<>''
        AND c.safe_locator<>'{{}}'::jsonb AND c.source_sha256 ~ '^[a-f0-9]{{64}}$'
        AND ({origin_acceptance})
        {permission_filter}
      '''
    params=(info['release_id'],info['release_id'],info['release_id'],context['allowed_collections'],scope.get('kind'),scope.get('tenant_id'),
        scope.get('owner_user_id'),context['principal_id'],scope.get('owner_user_id'),scope.get('kind'),scope.get('tenant_id'),
        scope.get('project_id'),languages,languages,modalities,modalities,operation,allow_machine)
    return CandidateSet(sql,params,info['release_id'],context,request,destination,include_candidates),context,info


def authorized_rows(context,*,conn,destination=None,include_candidates=False,chunk_ids=None,request=None):
    from .privacy import eligible
    context=validate_context(context)
    if chunk_ids is not None:
        if not isinstance(chunk_ids,(list,tuple)) or any(not isinstance(value,str) or not value for value in chunk_ids):
            raise ValueError('bounded chunk id list required')
        chunk_ids=list(dict.fromkeys(chunk_ids))
        if len(chunk_ids)>500:raise ValueError('authorized row hydration exceeds 500 rows')
        if not chunk_ids:return [],context,release_info(context.get('release_id'),conn)
    request,languages,modalities,operation=_request_filters(request)
    context['operation']=operation
    _assert_restore_ready(conn)
    info=release_info(context.get('release_id'),conn)
    if info['status']!='accepted' and not include_candidates:raise PermissionError('release not accepted')
    revision=_lock_current_policy(conn,shared=True)
    release_id=info['release_id']
    rows=release_rows(release_id,conn,chunk_ids)
    if not rows:
        context.update(release_id=release_id,policy_revision=str(revision),policy_current=True,current_denials=[])
        return [],context,info
    chunk_list=[row['chunk_id'] for row in rows]
    edges=conn.execute('SELECT chunk_id,dependency_id FROM kb.release_chunk_dependencies WHERE release_id=%s AND chunk_id=ANY(%s::text[])',
        (release_id,chunk_list)).fetchall()
    dependencies={}
    for edge in edges:dependencies.setdefault(edge['chunk_id'],set()).add(edge['dependency_id'])
    targets=set()
    for row in rows:
        targets.update(str(row[key]) for key in ('chunk_id','variant_id','source_version_id','source_id','evidence_source_group_id') if row.get(key) is not None)
        values=row.get('dependency_ids') or []
        if isinstance(values,str):values=json.loads(values)
        targets.update(value for value in values if isinstance(value,str))
        targets.update(dependencies.get(row['chunk_id'],set()))
    policies={row['target_id']:row for row in conn.execute('SELECT * FROM kb.policy WHERE target_id=ANY(%s::text[])',(sorted(targets),))}
    current_denials=sorted(key for key,value in policies.items() if value['denied'] or value['quarantined'])
    context.update(release_id=release_id,policy_revision=str(revision),policy_current=True,current_denials=current_denials)
    result=[]
    for row in rows:
        closure={str(row[key]) for key in ('chunk_id','variant_id','source_version_id','source_id','evidence_source_group_id') if row.get(key) is not None}
        values=row.get('dependency_ids') or []
        if isinstance(values,str):values=json.loads(values)
        closure.update(value for value in values if isinstance(value,str))
        closure.update(dependencies.get(row['chunk_id'],set()))
        selected=[policies[key] for key in closure if key in policies]
        row.update(release_id=release_id,independently_reviewed=True,review_state='independently_reviewed',
            provenance_verified=True,denied=any(policy['denied'] for policy in selected),
            quarantined=any(policy['quarantined'] for policy in selected))
        permissions={'internal_retrieval_allowed':True,'external_inference_allowed':False,'customer_display_allowed':False}
        for key in permissions:
            decisions=[policy['permissions'][key] for policy in selected if key in policy['permissions']]
            if decisions:permissions[key]=all(value is True for value in decisions)
        row['permissions']=permissions
        if row['content_role'] in ('source_catalog','process_record','generated_draft'):continue
        if row['content_role'] in ('product_context','operation_template') and operation not in ('rfq','quote_compare'):continue
        if row['collection_id'] not in context['allowed_collections'] or not scope_allows(row['scope'],context['scope']):continue
        if languages and row['language'] not in languages:continue
        if modalities and row['modality'] not in modalities:continue
        if eligible(row,context,destination=destination or context['purpose']):
            result.append(row)
    if result:
        eligible_chunk_ids=[row['chunk_id'] for row in result]
        cells=conn.execute('''SELECT payload->>'document_id' AS document_id,payload
          FROM kb.read_release_structured_entities
          WHERE release_id=%s AND entity_type='cell'
            AND payload->>'document_id'=ANY(%s::text[])
          ORDER BY id''',(release_id,eligible_chunk_ids)).fetchall()
        cells_by_document={}
        for cell in cells:cells_by_document.setdefault(cell['document_id'],[]).append(cell['payload'])
        keys=('raw_value','parsed_value','parse_state','formula','cached_value','header_path','unit','currency','quantity_break','locator','semantic_review_state')
        for row in result:
            row['structured_cells']=[{key:cell[key] for key in keys if key in cell}
                                     for cell in cells_by_document.get(row['chunk_id'],())]
    return result,context,info

def _operation_private_origins(conn,release_id,rows):
    chunk_ids=list(dict.fromkeys(row['chunk_id'] for row in rows))
    records=conn.execute('''SELECT c.chunk_id,c.provenance_ref,c.source_sha256,c.text_sha256,
          c.variant_id,c.source_version_id,o.package_id,p.manifest_sha256,
          bp.package_id AS binding_package_id,b.payload AS binding_payload,
          a.id AS acquisition_id,a.payload AS acquisition_payload,
          a.payload->>'binding_ref' AS acquisition_binding_ref,
          a.payload->>'variant_id' AS acquisition_variant_id,
          a.payload->>'source_version_id' AS acquisition_source_version_id
        FROM kb.chunks c
        JOIN kb.release_members m ON m.entity_id=c.chunk_id AND m.release_id=%s
        JOIN kb.read_release_chunk_origins o ON o.release_id=m.release_id AND o.chunk_id=c.chunk_id
        JOIN kb.chunk_origins co ON co.chunk_id=o.chunk_id AND co.package_id=o.package_id
        JOIN kb.packages p ON p.package_id=o.package_id
        JOIN kb_private.provenance_packages bp ON bp.provenance_id=c.provenance_ref AND bp.package_id=o.package_id
        JOIN kb_private.provenance b ON b.id=c.provenance_ref
        JOIN LATERAL jsonb_array_elements_text(co.dependency_ids) dep(value) ON TRUE
        -- The native acquisition must be an exact dependency of this origin.
        -- Keep its primary-key lookup bounded before examining private payloads.
        JOIN LATERAL (
          SELECT id,payload FROM kb_private.provenance
          WHERE id=dep.value OFFSET 0
        ) a ON a.payload->>'binding_ref'=c.provenance_ref
          AND a.payload->>'variant_id'=c.variant_id
          AND a.payload->>'source_version_id'=c.source_version_id
        JOIN kb_private.provenance_packages ap
          ON ap.provenance_id=a.id AND ap.package_id=o.package_id
        WHERE c.chunk_id=ANY(%s::text[])
        ORDER BY c.chunk_id,o.package_id,a.id''',(release_id,chunk_ids)).fetchall()
    by_chunk={}
    for record in records:by_chunk.setdefault(record['chunk_id'],[]).append(record)
    result={}
    for row in rows:
        chunk_id=row['chunk_id']
        origins=row.get('package_origins') or []
        if isinstance(origins,str):origins=json.loads(origins)
        if not isinstance(origins,list) or not origins or any(not isinstance(origin,dict) for origin in origins):
            raise PermissionError('candidate package origins unavailable')
        expected=[]
        for origin in origins:
            package_id=origin.get('package_id'); manifest_sha256=origin.get('manifest_sha256')
            if (not isinstance(package_id,str) or not package_id or
                    not isinstance(manifest_sha256,str) or not _HASH.fullmatch(manifest_sha256)):
                raise PermissionError('candidate package origins unavailable')
            expected.append({'package_id':package_id,'manifest_sha256':manifest_sha256})
        expected.sort(key=lambda origin:(origin['package_id'],origin['manifest_sha256']))
        if len({origin['package_id'] for origin in expected})!=len(expected):
            raise PermissionError('candidate package origins unavailable')
        actual=by_chunk.get(chunk_id,[])
        actual_origins=[]; locators=[]
        for record in actual:
            package_id=record['package_id']; manifest_sha256=record['manifest_sha256']
            payload=record['acquisition_payload']; binding=record['binding_payload']
            if (record['provenance_ref']!=row.get('provenance_ref') or
                    record['binding_package_id']!=package_id or
                    not isinstance(binding,dict) or binding.get('id')!=row.get('provenance_ref') or
                    not isinstance(payload,dict) or payload.get('id')!=record['acquisition_id'] or
                    record['acquisition_binding_ref']!=row.get('provenance_ref') or
                    record['acquisition_variant_id']!=row.get('variant_id') or
                    record['acquisition_source_version_id']!=row.get('source_version_id')):
                raise PermissionError('candidate native acquisition binding unavailable')
            document=payload.get('document'); provenance=document.get('provenance') if isinstance(document,dict) else None
            source_sha=(provenance.get('source_sha256') or provenance.get('source_payload_sha256')
                        if isinstance(provenance,dict) else None)
            private_locator=document.get('locator') if isinstance(document,dict) else None
            if (not isinstance(private_locator,dict) or source_sha!=row.get('source_sha256') or
                    safe_locator(private_locator)!=safe_locator(row.get('safe_locator'))):
                raise PermissionError('candidate native locator or source hash unavailable')
            if (not isinstance(package_id,str) or not package_id or
                    not isinstance(manifest_sha256,str) or not _HASH.fullmatch(manifest_sha256)):
                raise PermissionError('candidate package origin unavailable')
            actual_origins.append({'package_id':package_id,'manifest_sha256':manifest_sha256})
            locators.append(private_locator)
        actual_origins.sort(key=lambda origin:(origin['package_id'],origin['manifest_sha256']))
        if actual_origins!=expected or not locators or any(locator!=locators[0] for locator in locators[1:]):
            raise PermissionError('candidate native package provenance mismatch')
        text=row.get('retrieval_text'); source_sha=row.get('source_sha256'); text_sha=row.get('text_sha256')
        if (not isinstance(text,str) or not text.strip() or not isinstance(source_sha,str) or
                not _HASH.fullmatch(source_sha) or not isinstance(text_sha,str) or
                not _HASH.fullmatch(text_sha) or hashlib.sha256(text.encode()).hexdigest()!=text_sha):
            raise PermissionError('candidate integrity unavailable')
        result[chunk_id]={'package_origins':expected,'private_locator':locators[0]}
    return result


def operation_inputs(candidate_refs,context,*,destination='internal_retrieval'):
    context=validate_context(context)
    if context.get('operator') is not True or context.get('purpose')!='internal_retrieval':
        raise PermissionError('server-created internal operator context required')
    if destination!='internal_retrieval' or context['purpose']!=destination:
        raise PermissionError('operation inputs require internal retrieval context')
    from .search.hybrid import _internal_refs
    parents,refs=_internal_refs(candidate_refs)
    empty={'selected_inputs':[],'evidence_provenance':[],'input_revision_refs':[]}
    if not refs:return empty
    operation=parents[0]['operation']
    release_id=parents[0]['release_id']
    if context.get('operation') and context['operation']!=operation:
        raise PermissionError('candidate operation mismatch')
    if context['grant_fingerprint']!=parents[0]['grant_fingerprint']:
        raise PermissionError('internal candidate grant mismatch')
    if context.get('release_id') and context['release_id']!=release_id:
        raise PermissionError('candidate release mismatch')
    scoped=dict(context,release_id=release_id,operation=operation)
    filters=parents[0]['request_filters']
    request={'operation':operation,**filters}
    with connect() as conn:
        candidates,current,info=authorized_candidates(scoped,conn=conn,destination=destination,request=request)
        if info['release_id']!=release_id:
            raise PermissionError('candidate release changed')
        policy_revision=str(current['policy_revision'])
        if any(ref['policy_revision']!=policy_revision for ref in refs):
            raise PermissionError('candidate policy revision is stale')
        citation_ids=[ref['citation_id'] for ref in refs]
        citations=conn.execute('''SELECT citation_id,release_id,chunk_id,grant_fingerprint,purpose,operation,context_relation
          FROM kb.citations WHERE citation_id=ANY(%s::text[])''',(citation_ids,)).fetchall()
        by_citation={row['citation_id']:row for row in citations}
        invalid_support_citations=set()
        for ref in refs:
            citation=by_citation.get(ref['citation_id'])
            if citation is None:
                if ref.get('context_relation')=='same_source_passage':
                    invalid_support_citations.add(ref['citation_id'])
                    continue
                raise LookupError('candidate citation unavailable')
            if (citation['release_id']!=ref['release_id'] or citation['chunk_id']!=ref['chunk_id'] or
                    citation['grant_fingerprint']!=ref['grant_fingerprint'] or
                    citation['purpose']!=ref['purpose'] or citation['operation']!=ref['operation'] or
                    citation.get('context_relation')!=ref.get('context_relation')):
                if ref.get('context_relation')=='same_source_passage':
                    invalid_support_citations.add(ref['citation_id'])
                    continue
                raise PermissionError('candidate citation binding mismatch')
        from .search import structured
        fresh_neighbors=structured.neighbors(conn,candidates,[parent['chunk_id'] for parent in parents],limit=4)
        rows=candidates.fetch_rows(conn,[ref['chunk_id'] for ref in refs
                                         if ref['citation_id'] not in invalid_support_citations])
        by_chunk={row['chunk_id']:row for row in rows}
        primary_chunk_ids={parent['chunk_id'] for parent in parents}
        selected=[]
        for parent in parents:
            primary=by_chunk.get(parent['chunk_id'])
            if primary is None or primary['evidence_source_group_id']!=parent['evidence_source_group_id']:
                continue
            fresh={item['chunk_id']:item['relation_kind'] for item in fresh_neighbors.get(parent['chunk_id'],[])}
            requested={ref['chunk_id']:ref for ref in parent['neighbors']
                       if ref['context_relation']!='same_source_passage'}
            if any(ref['required_context'] and
                   (ref['chunk_id'] not in fresh or fresh[ref['chunk_id']]!=ref['context_relation'] or
                    ref['chunk_id'] not in by_chunk) for ref in parent['neighbors']):
                continue
            selected.append((parent,primary,None))
            for item in fresh_neighbors.get(parent['chunk_id'],[]):
                ref=requested.get(item['chunk_id']); neighbor=by_chunk.get(item['chunk_id'])
                if (ref is None or neighbor is None or item['relation_kind']!=ref['context_relation'] or
                        neighbor['evidence_source_group_id']!=ref['evidence_source_group_id']):
                    continue
                selected.append((ref,neighbor,item['relation_kind']))
            structural_chunk_ids={ref['chunk_id'] for ref in parent['neighbors']
                                  if ref['context_relation']!='same_source_passage'}
            for ref in parent['neighbors']:
                if (ref['context_relation']!='same_source_passage' or
                        ref['citation_id'] in invalid_support_citations):
                    continue
                support=by_chunk.get(ref['chunk_id'])
                if (support is None or ref['chunk_id'] in primary_chunk_ids or
                        ref['chunk_id'] in structural_chunk_ids or
                        support['content_role'] in ('source_catalog','process_record','generated_draft') or
                        ref['evidence_source_group_id']!=primary['evidence_source_group_id'] or
                        support['evidence_source_group_id']!=ref['evidence_source_group_id'] or
                        support['evidence_source_group_id']!=primary['evidence_source_group_id'] or
                        support['source_version_id']!=primary['source_version_id']):
                    continue
                selected.append((ref,support,'same_source_passage'))
        if not selected:return empty
        private_rows=list({row['chunk_id']:row for _,row,_ in selected}.values())
        private_by_chunk=_operation_private_origins(conn,info['release_id'],private_rows)
        from .search.hybrid import _citation
        envelope={'selected_inputs':[],'evidence_provenance':[],'input_revision_refs':[]}
        for ref,row,relation_kind in selected:
            source_id=ref['citation_id']
            citation_id=_citation(conn,row,current,context_relation=relation_kind)
            limitations=row.get('limitations') or []
            if not isinstance(limitations,list) or not all(isinstance(item,str) for item in limitations):
                raise PermissionError('candidate limitations unavailable')
            labels={'content_role':row['content_role'],'context_relation':relation_kind,
                    'required_context':ref.get('required_context',False)}
            envelope['selected_inputs'].append({
                'citation_id':citation_id,'text':row['retrieval_text'],
                'safe_locator':row['safe_locator'],'limitations':list(limitations),
                'semantic_labels':labels})
            binding={
                'citation_id':citation_id,'source_citation_id':source_id,
                'candidate_set_id':parents[0]['candidate_set_id'],
                'request_binding':parents[0]['request_binding'],
                'purpose':destination,'grant_fingerprint':ref['grant_fingerprint'],
                'candidate_ref':copy.deepcopy(ref),'chunk_id':row['chunk_id'],
                'evidence_source_group_id':row['evidence_source_group_id'],
                'context_relation':relation_kind,'required_context':ref.get('required_context',False),
                'operation':operation,'source_id':row['source_id'],
                'source_version_id':row['source_version_id'],'variant_id':row['variant_id'],
                'source_sha256':row['source_sha256'],'text_sha256':row['text_sha256'],
                'private_locator':private_by_chunk[row['chunk_id']]['private_locator'],
                'safe_locator':row['safe_locator'],
                'package_origins':private_by_chunk[row['chunk_id']]['package_origins'],
                'release_id':info['release_id'],'policy_revision':policy_revision}
            envelope['evidence_provenance'].append(binding)
            envelope['input_revision_refs'].append(copy.deepcopy(binding))
        return envelope

def set_policy(target_id,*,denied=False,quarantined=False,permissions=None,reason):
    from psycopg.types.json import Jsonb
    if not reason:raise ValueError('decision reason required')
    with connect() as conn:
        _lock_current_policy(conn,shared=False)
        revision=conn.execute('UPDATE kb.policy_state SET revision=revision+1 WHERE singleton RETURNING revision').fetchone()['revision']
        policy={'denied':bool(denied),'quarantined':bool(quarantined),'permissions':permissions or {},'reason':reason}
        conn.execute('INSERT INTO kb.policy VALUES(%s,%s,%s,%s,%s) ON CONFLICT(target_id) DO UPDATE SET revision=excluded.revision,denied=excluded.denied,quarantined=excluded.quarantined,permissions=excluded.permissions',(target_id,revision,denied,quarantined,Jsonb(permissions or {})))
        conn.execute('INSERT INTO kb.revocations(target_id,decision) VALUES(%s,%s)',(target_id,Jsonb(policy)))
    return {'policy_revision':str(revision),'target_id':target_id}
def import_cards(card_dir,*,review_receipt,release_id,trusted_reviewer_id,trusted_author_ids_by_card):
    """Admit Q04 cards using reviewer and source-author identities from trusted caller context."""
    from psycopg.types.json import Jsonb
    from .knowledge_cards import approval_status
    if not isinstance(trusted_reviewer_id,str) or not trusted_reviewer_id.strip():raise ValueError('trusted reviewer identity required')
    if not isinstance(trusted_author_ids_by_card,Mapping):raise ValueError('trusted source-author identities required')
    path=Path(card_dir)
    seal=json.loads((path/'receipt.json').read_text())
    raw=(path/'cards.jsonl').read_bytes()
    sha=hashlib.sha256(raw).hexdigest()
    descriptor=seal['files']['cards.jsonl']
    cards=[json.loads(line) for line in raw.split(b'\n') if line.strip()]
    if descriptor!={'sha256':sha,'count':len(cards),'size_bytes':len(raw)}:raise ValueError('card seal mismatch')
    if isinstance(review_receipt,(str,Path)):review_receipt=json.loads(Path(review_receipt).read_text())
    approvals=review_receipt if isinstance(review_receipt,list) else review_receipt.get('approvals',[review_receipt])
    approved={a.get('card_version_id'):a for a in approvals}
    admitted=[]
    package_id='cards:'+sha
    with connect() as conn:
        _lock_release_index(conn,release_id)
        state=conn.execute('SELECT status FROM kb.releases WHERE release_id=%s FOR UPDATE',(release_id,)).fetchone()
        if not state or state['status']!='candidate':raise ValueError('candidate required for card admission')
        _lock_current_policy(conn,shared=True)
        policies={r['target_id']:r for r in conn.execute('SELECT * FROM kb.policy')}
        for card in cards:
            approval=approved.get(card['card_version_id'])
            if not approval:continue
            if approval.get('cards_sha256')!=sha or approval.get('purpose')!='internal_retrieval':raise ValueError('card approval seal/purpose mismatch')
            if approval.get('reviewer_id')==card.get('producer'):raise ValueError('card self-review')
            trusted_authors=trusted_author_ids_by_card.get(card['card_version_id'])
            if approval_status(card,approval,trusted_reviewer_id=trusted_reviewer_id,
                               trusted_author_ids=trusted_authors)!='accepted':raise ValueError('unaccepted card version or dependency signature')
            evidence=card.get('evidence',[])
            if not evidence or card.get('operation') not in ('rfq','quote_compare'):raise ValueError('card evidence/operation required')
            chunk_ids=[];dependencies=set()
            for support in evidence:
                rows=conn.execute('''SELECT c.*,p.manifest_sha256 FROM kb.chunks c
                  JOIN kb.release_members m ON m.entity_id=c.chunk_id
                  JOIN kb.release_chunk_origins o ON o.release_id=m.release_id AND o.chunk_id=c.chunk_id JOIN kb.packages p ON p.package_id=o.package_id
                  WHERE m.release_id=%s AND c.variant_id=%s''',(release_id,support['variant_id'])).fetchall()
                if not rows:raise ValueError('card evidence is not an accepted candidate member')
                match=next((r for r in rows if r['source_version_id']==support['source_version_id'] and r['source_id']==support['source_id'] and r['text_sha256']==support['variant_text_sha256'] and r['source_sha256']==support['source_payload_sha256'] and r['manifest_sha256']==support['manifest_sha256']),None)
                if not match or match['scope']!=card['scope']:raise ValueError('card evidence version/scope mismatch')
                start,end=support.get('start_char'),support.get('end_char')
                if type(start) is not int or type(end) is not int or not 0<=start<=end<=len(match['retrieval_text']) or match['retrieval_text'][start:end]!=support.get('excerpt'):raise ValueError('card evidence excerpt mismatch')
                chunk_ids.append(match['chunk_id'])
                deps=conn.execute('''WITH RECURSIVE deps(id) AS (SELECT %s::text UNION SELECT d.dependency_id FROM kb.entity_dependencies d JOIN deps ON deps.id=d.entity_id) SELECT id FROM deps''',(match['chunk_id'],)).fetchall()
                dependencies.update(d['id'] for d in deps)
                dependencies.update(support.get('required_dependency_ids',[]))
            dependencies.update((card['id'],card['card_version_id']))
            if any(policies.get(d,{}).get('denied') or policies.get(d,{}).get('quarantined') or policies.get(d,{}).get('permissions',{}).get('internal_retrieval_allowed') is False for d in dependencies):raise PermissionError('card evidence currently denied')
            conn.execute('INSERT INTO kb.packages(package_id,manifest_sha256,manifest,review_receipt) VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING',(package_id,sha,Jsonb(seal),Jsonb(review_receipt)))
            row=dict(card,logical_card_id=card['id'],id=card['card_version_id'],review_state='independently_reviewed',status='accepted',approval_ref=digest(approval))
            _put_entity(conn,row,'knowledge_card',package_id)
            for chunk_id in chunk_ids:conn.execute('INSERT INTO kb.entity_dependencies VALUES(%s,%s) ON CONFLICT DO NOTHING',(row['id'],chunk_id))
            _add_members(conn,release_id,[row['id']])
            admitted.append(row['id'])
        if set(approved)-{c['card_version_id'] for c in cards}:raise ValueError('approved card absent from seal')
    return {'release_id':release_id,'cards_sha256':sha,'admitted_card_versions':admitted}