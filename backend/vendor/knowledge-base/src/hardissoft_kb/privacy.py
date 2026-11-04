"""Machine-screened variants and live, destination-specific access control.

This is not a person-name detector or a safety approval. Exact names come from
source author fields/private provenance, plus identifiers explicitly named by
the approved removal request. Image and voice privacy remain unreviewed.

Operator release policy: immutable machine-screened text may be admitted only
with independent non-author acceptance of its exact manifest/variants. Serving also
requires a current policy snapshot, explicit internal permission and a trusted
operator opting into machine-screened limitations. Customer display and model
egress instead require independently reviewed_safe text and destination grants.
Owner permission is not privacy approval; no legal/territory re-audit is done.
"""
import copy
import hashlib
import json
import re
from fractions import Fraction
from functools import lru_cache
from pathlib import Path

TRANSFORM_VERSION = 'privacy-redaction-v1'
# Records de-identified before KB intake; no original text is held in the KB.
DEIDENTIFIED_EXPORT_VERSION = 'deidentified-export-v1'
# Explicit removal-request targets name people, so they are deployment data, not source.
# They live in the private KB configuration beside the other privacy policy inputs.
REQUEST_IDENTIFIERS_CONFIG = 'privacy-request-identifiers.json'
_PATTERNS = (
    ('email', re.compile(r'(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+', re.UNICODE)),
    ('url', re.compile(r'(?i)\b(?:https?://|ftp://|www\.)[^\s<>"\[\]]+')),
    ('path', re.compile(r'(?i)(?:\bfile://[^\s<>"\[\]]+|(?<![\w/])/(?:srv|home|root|tmp|var|mnt|opt|etc|Users|private|data|media|workspace)(?:/[^\s<>"\[\]]*)?|\b[A-Z]:\\[^\s<>"\[\]]+|\\\\[^\s<>"\[\]]+)')),
    ('contact', re.compile(r'(?i)\b(?:tel|phone|mobile|fax|whatsapp|telegram|skype|discord)\s*[:=]\s*[^\s,;]+(?:[ -]\d+)*')),
    ('contact', re.compile(r'(?i)\bsignal(?:\s+(?:messenger|contact|username|phone)\s*[:=]\s*[^\s,;]+|\s*[:=]\s*@[\w.+-]+)')),
    ('phone', re.compile(r'(?<![\w])\+\d{1,3}[ .()-]*(?:\d[ .()-]*){7,14}\d(?![\w])')),
    ('credential', re.compile(r'(?i)\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+')),
    ('identifier', re.compile(r'(?i)\b(?:user[_ -]?id|author[_ -]?id|account[_ -]?id|member[_ -]?id|profile[_ -]?id)\s*[:=#]\s*[^\s,;]+')),
)
_PRIVATE_KEYS = {'author','authors','author_name','author_id','author_url','creator','created_by','username','user_name','user_id','owner_name','speaker_name','email','contact','phone','url','uri','origin_path','path','server_path','filename','file_name','source_url','profile_url','private','provenance','native_id','post_id','topic_id','answer_id','question_id','video_id','attachment_id','handle','person','person_name','people','person_names','author_names','private_identifiers','source_key','unit_key'}
_NAME_KEYS = {'author','authors','author_name','creator','created_by','username','user_name','speaker_name','owner_name','person','person_name','people','person_names','author_names'}
_IDENTIFIER_KEYS = {'author_id','user_id','handle','author_url','profile_url','private_identifiers'}
_PERMISSIONS = {'processing':'processing_allowed','internal_retrieval':'internal_retrieval_allowed','external_inference':'external_inference_allowed','customer_display':'customer_display_allowed'}
_PUBLIC_LOCATOR_FIELDS = frozenset({
    "kind", "precision", "coordinate_space", "fallback_reason", "adapted",
    "mapping_ref", "namespace", "native_id_format", "artifact_sha256", "source_artifact_sha256",
    "media_sha256", "frame_artifact_sha256", "encoding", "section_path", "start_char",
    "end_char", "page_index", "page_label", "block_index", "bbox",
    "coordinate_system", "sheet_name", "row_index", "column_index", "a1_ref",
    "header_path", "stream_index", "start_ms", "end_ms", "time_basis",
    "segment_id", "pts", "time_base", "timestamp_ms", "timestamp_method",
    "topic_id", "post_id", "question_id", "answer_id", "site",
    "content_field", "source_span", "quote_kind", "page_end_index", "source_window_start_seconds",
    "estimated_window_start_seconds", "estimated_window_end_seconds", "estimated_media_start_seconds", "estimated_media_end_seconds", "audio_window_index",
    "segment_index", "source_window_pts", "source_window_time_base", "timestamp_accuracy",
})
_ASR_ESTIMATE_FIELDS = ('source_window_start_seconds','estimated_window_start_seconds','estimated_window_end_seconds')


@lru_cache(maxsize=4)
def _load_request_identifiers(path):
    """Return configured request targets; a missing file means no request applies.

    An unreadable or malformed file fails closed instead of serving unredacted text.
    """
    try:
        raw = path.read_text(encoding='utf-8')
    except FileNotFoundError:
        return ()
    values = json.loads(raw)
    if not isinstance(values, list) or not all(isinstance(value, str) and value.strip() for value in values):
        raise ValueError('privacy request identifiers must be a JSON array of non-empty strings')
    return tuple(value.strip() for value in values)


def request_identifiers():
    from .catalog import ROOT
    return _load_request_identifiers(ROOT / 'config' / REQUEST_IDENTIFIERS_CONFIG)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()


def _privacy_mapping_ref(parent_hash, original, text, mappings):
    text_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
    return 'private:privacy-mapping:' + _digest([parent_hash,original.get('source_key'),original.get('unit_key'),text_hash,mappings,original.get('locator')])


def redact(text, *, persons=(), identifiers=()):
    """Return text and a complete Unicode-codepoint mapping (half-open spans).

    No original values are included in findings. Unknown names are not guessed;
    unchanged text is not proof of privacy. MPN/units have no generic ID regex.
    """
    if not isinstance(text, str):
        raise TypeError('redact requires Unicode text')
    spans = []
    for kind, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            # A signed engineering quantity is not a telephone number.
            if kind == 'phone' and re.match(r'\s*(?:[kMGTmunpµμ]?(?:Hz|V|A|W|F|H|Ω|Ohm|s|m|g)|rpm)\b',text[match.end():]):
                continue
            spans.append((match.start(),match.end(),kind))
    for kind, values in (('person', persons), ('identifier', tuple(identifiers) + request_identifiers())):
        for value in sorted({value.strip() for value in values if isinstance(value,str) and value.strip()}, key=lambda value:(-len(value),value)):
            pattern = re.compile(r'(?<!\w)' + re.escape(value.strip()) + r'(?!\w)', re.IGNORECASE)
            spans.extend((match.start(),match.end(),kind) for match in pattern.finditer(text))
    # Merge overlaps, not adjacent contacts: mappings remain unambiguous.
    merged = []
    for start, end, kind in sorted(spans, key=lambda value:(value[0],-value[1],value[2])):
        if merged and start < merged[-1][1]:
            previous = merged[-1]
            merged[-1] = (previous[0], max(end, previous[1]), previous[2] | {kind})
        else:
            merged.append((start, end, {kind}))
    pieces, mapping, findings = [], [], []
    source_cursor = output_cursor = 0
    for start, end, kinds in merged:
        if start > source_cursor:
            segment = text[source_cursor:start]
            pieces.append(segment)
            mapping.append(dict(source_start=source_cursor,source_end=start,output_start=output_cursor,output_end=output_cursor+len(segment),exact=True))
            output_cursor += len(segment)
        kind = '+'.join(sorted(kinds))
        replacement = '[REDACTED:' + kind + ']'
        pieces.append(replacement)
        mapping.append(dict(source_start=start,source_end=end,output_start=output_cursor,output_end=output_cursor+len(replacement),exact=False))
        findings.append(dict(kind=kind,source_start=start,source_end=end,output_start=output_cursor,output_end=output_cursor+len(replacement)))
        source_cursor, output_cursor = end, output_cursor + len(replacement)
    if source_cursor < len(text) or not mapping:
        segment = text[source_cursor:]
        pieces.append(segment)
        mapping.append(dict(source_start=source_cursor,source_end=len(text),output_start=output_cursor,output_end=output_cursor+len(segment),exact=True))
    return dict(text=''.join(pieces),mapping=mapping,findings=findings,state='machine_screened',all_person_names_removed=False,
                limitations=['Exact source-author/request identifiers and contact patterns only; unknown personal names may remain.', 'Source images and voices are unreviewed.'])


def map_span(mapping, start, end):
    """Map an original span into the redacted coordinate space.

    A span touching replacement text is adapted, never an exact source quote.
    """
    if not mapping or start < 0 or end < start or end > mapping[-1]['source_end']:
        raise ValueError('Span outside source coordinate space')
    if start == end:
        for item in mapping:
            if item['source_start'] <= start <= item['source_end']:
                position = item['output_start'] + start - item['source_start'] if item['exact'] else item['output_start']
                return dict(start=position,end=position,exact=item['exact'])
    touched = [item for item in mapping if item['source_end'] > start and item['source_start'] < end]
    if not touched:
        raise ValueError('Span has no mapping')
    first, last = touched[0], touched[-1]
    out_start = first['output_start'] + max(0,start-first['source_start']) if first['exact'] else first['output_start']
    out_end = last['output_start'] + min(end,last['source_end'])-last['source_start'] if last['exact'] else last['output_end']
    return dict(start=out_start,end=out_end,exact=all(item['exact'] for item in touched))


def _private_terms(value, persons, identifiers, key=''):
    if isinstance(value, dict):
        for child_key, child in value.items():
            child_name = str(child_key).lower()
            semantic_key = key if child_name in {'name','display_name','full_name','value'} and key in _NAME_KEYS | _IDENTIFIER_KEYS else child_name
            _private_terms(child, persons, identifiers, semantic_key)
    elif isinstance(value, (list, tuple)):
        for child in value:
            _private_terms(child, persons, identifiers, key)
    elif isinstance(value, str) and value.strip():
        if key in _NAME_KEYS:
            persons.add(value.strip())
            display = re.fullmatch(r'\s*([^<>]+?)\s*<[^<>]+>\s*', value)
            if display:
                persons.add(display.group(1).strip())
        elif key in _IDENTIFIER_KEYS and not value.strip().isdecimal():
            identifiers.add(value.strip())


def _screening_terms(documents):
    persons, identifiers = set(), set(request_identifiers())
    for document in documents:
        _private_terms(document.get('metadata',{}),persons,identifiers)
        _private_terms(document.get('provenance',{}),persons,identifiers)
    return persons, identifiers


def _screen_tree(value, persons, identifiers, mappings, path=''):
    if isinstance(value, str):
        result = redact(value, persons=persons, identifiers=identifiers)
        mappings[path] = {key: result[key] for key in ('mapping','findings')}
        return result['text']
    if isinstance(value, list):
        return [_screen_tree(child,persons,identifiers,mappings,path+'/'+str(index)) for index,child in enumerate(value)]
    if isinstance(value, dict):
        result = {}
        for key, child in value.items():
            key_name = str(key).lower()
            if key_name in _PRIVATE_KEYS or key_name == 'id' or key_name.endswith(('_id','_ids')) or key_name in {'display_name','full_name','provenance_ref'}:
                continue
            safe_key = redact(str(key),persons=persons,identifiers=identifiers)['text']
            # Refuse ambiguity after two sensitive keys collapse to one marker.
            if safe_key in result:
                continue
            result[safe_key] = _screen_tree(child,persons,identifiers,mappings,path+'/'+str(key))
        return result
    return copy.deepcopy(value)


def _privacy_constraints(value):
    """Inherit version-bound deny markers, not unrelated retained history."""
    constraints = {'quarantined':False, 'pending_privacy_markers':False, 'retrieval_denied':False}
    provenance = value.get('provenance',{}) if isinstance(value,dict) else {}
    current_sha = provenance.get('source_payload_sha256') or provenance.get('source_sha256')
    current_version = value.get('source_version_id') or provenance.get('source_version_id')
    def visit(item, parent_key=''):
        if isinstance(item,dict):
            if item.get('canonical_source_hash_matches') is False:
                return
            if parent_key == 'stage_reconciliation' and (item.get('canonical_source_hash_matches') is not True or not current_sha or item.get('source_sha256') != current_sha):
                return
            if current_sha and item.get('source_sha256') and item['source_sha256'] != current_sha:
                return
            if current_version and item.get('source_version_id') and item['source_version_id'] != current_version:
                return
            for key, child in item.items():
                name = str(key).lower()
                if name in {'pending_markers','pending_privacy_markers','pii_markers_present'} and child:
                    constraints['pending_privacy_markers'] = True
                if name in {'quarantined','privacy_quarantined'} and child is True:
                    constraints['quarantined'] = True
                if (name == 'privacy_state' or (parent_key == 'privacy' and name == 'state')) and child == 'quarantined':
                    constraints['quarantined'] = True
                if name == 'retrieval_denied' and child is True:
                    constraints['retrieval_denied'] = True
                visit(child,name)
        elif isinstance(item,list):
            for child in item:
                visit(child,parent_key)
    visit(value)
    return constraints



def _rational_seconds(value):
    if isinstance(value,bool) or not isinstance(value,(str,int,float)):
        return None
    try:
        result = Fraction(str(value))
    except (TypeError,ValueError,ZeroDivisionError,OverflowError):
        return None
    return result if result >= 0 else None


def _asr_estimate_fields(source):
    if source.get('kind') != 'audio' or source.get('time_basis') != 'asr_window_relative_estimate':
        return {}
    values = {key:_rational_seconds(source.get(key)) for key in _ASR_ESTIMATE_FIELDS}
    if any(value is None for value in values.values()):
        return {}
    if values['estimated_window_end_seconds'] < values['estimated_window_start_seconds']:
        return {}
    return {'time_basis':'asr_window_relative_estimate',
            **{key:str(value) for key,value in values.items()}}


def _native_frame_pts(original, source, source_version):
    provenance = original.get('provenance',{})
    proof = provenance.get('original_locator') if isinstance(provenance,dict) else None
    if not isinstance(proof,dict) or proof.get('kind') != 'frame':
        return None
    # Bind typed PTS to the explicit media identity in the pinned source version.
    media_sha = provenance.get('media_sha256')
    version_sha = source_version.get('payload_sha256') if isinstance(source_version,dict) else None
    if (not isinstance(media_sha,str) or not re.fullmatch('[0-9a-f]{64}',media_sha)
            or version_sha != media_sha
            or source.get('media_sha256') != media_sha
            or proof.get('media_sha256') != media_sha):
        return None
    if proof.get('time_basis') != 'source_pts' or source.get('time_basis') not in (None,'source_pts'):
        return None
    if any(locator.get('timestamp_accuracy') not in (None,'exact') for locator in (source,proof)):
        return None
    if any(source.get(key) != proof.get(key) for key in ('stream_index','pts','time_base')):
        return None
    stream,pts,time_base = proof.get('stream_index'),proof.get('pts'),proof.get('time_base')
    if (type(stream) is int and stream >= 0 and type(pts) is int
            and isinstance(time_base,str)
            and re.fullmatch(r'[1-9][0-9]*/[1-9][0-9]*',time_base)):
        return stream,pts,time_base
    return None


def _public_redacted_locator(original, text, persons, identifiers, mappings, source_version=None):
    """Project to frozen selected-text or evidence-backed typed locator profiles."""
    source = original.get('locator',{})
    if not isinstance(source,dict):
        source = {}
    screened = _screen_tree(source,persons,identifiers,mappings,'/locator')
    selected_sha = hashlib.sha256(text.encode('utf-8')).hexdigest()
    common = {'artifact_sha256':selected_sha,'adapted':True,
              'coordinate_space':'redacted_variant','quote_kind':'adapted_redacted'}
    kind = source.get('kind')

    def valid_native(value):
        return (type(value) is int and value > 0) or (isinstance(value,str) and bool(value.strip()))

    def selected_text_locator():
        return dict(kind='text',start_char=0,end_char=len(text),**common)

    def coarse_source_locator(fallback='unverified_original_mapping'):
        allowed = {'original_coordinates_unavailable','no_safe_exact_span','source_record_only','unverified_original_mapping'}
        reason = source.get('fallback_reason')
        if reason not in allowed:
            reason = fallback
        locator = {'kind':'source_record','precision':'coarse','coordinate_space':'source_record',
                   'fallback_reason':reason,'adapted':True}
        if text:
            locator['artifact_sha256'] = selected_sha
            locator['quote_kind'] = 'adapted_redacted'
        return locator

    if kind == 'forum' and valid_native(source.get('topic_id')) and valid_native(source.get('post_id')):
        locator = dict(kind='forum',
            topic_id='private-target:' + _digest([original.get('corpus_id'),original.get('source_key'),'topic_id',source['topic_id']]),
            post_id='private-target:' + _digest([original.get('corpus_id'),original.get('source_key'),'post_id',source['post_id']]),
            native_id_format='opaque_mapped',source_span={'start':0,'end':len(text)},**common)
    elif kind in {'qa_answer','qa_question'}:
        required = ('question_id','answer_id') if kind == 'qa_answer' else ('question_id',)
        if all(valid_native(source.get(key)) for key in required):
            locator = dict(kind=kind,native_id_format='opaque_mapped',**common,
                **{key:'private-target:' + _digest([original.get('corpus_id'),original.get('source_key'),key,source[key]]) for key in required},
                start_char=0,end_char=len(text))
            if isinstance(screened.get('site'),str) and re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)*',screened['site']):
                locator['site'] = screened['site']
        else:
            locator = selected_text_locator()
    elif kind == 'frame':
        native = _native_frame_pts(original,source,source_version)
        if native is not None:
            stream,pts,time_base = native
            locator = {'kind':'frame','artifact_sha256':selected_sha,
                       'stream_index':stream,'pts':pts,'time_base':time_base,
                       'adapted':True,'quote_kind':'adapted_redacted'}
        else:
            locator = coarse_source_locator()
    elif kind == 'source_record':
        locator = coarse_source_locator('source_record_only')
    else:
        locator = selected_text_locator()
        if kind == 'audio':
            locator.update(_asr_estimate_fields(source))
        # Caption timestamps remain private; source bytes are not pinned here.
    return {key:value for key,value in locator.items() if key in _PUBLIC_LOCATOR_FIELDS}


def _native_relation_history(entries):
    """Recognize only SDK receipts from an already validated sealed package."""
    from .adapters.common import stable_id
    private = {row['id']:row for row in entries}
    bindings = {}
    for row in entries:
        if isinstance(row.get('document'),dict):
            bindings.setdefault(row.get('binding_ref',row.get('provenance_ref')),[]).append(row)
    history, generated = {}, set()
    reasons = {'ambiguous_native_target','unresolved_native_target','unresolved_relation_source','unresolved_relation_evidence'}
    for row in entries:
        outcome = row.get('outcome')
        if not isinstance(outcome,dict) or ('_generated_by' not in outcome and 'generated_by' not in row):
            continue
        resolution_ref = outcome.get('relation_resolution_ref')
        resolution = private.get(resolution_ref,{}).get('relation_resolution')
        outcome_id = stable_id('outcome',outcome)
        if (outcome.get('_generated_by') != 'native-relation-v1' or row.get('generated_by') != 'native-relation-v1'
                or outcome.get('input_id') != 'relation-prerequisite:'+str(resolution_ref)
                or outcome.get('status') != 'quarantined' or outcome.get('unit_count') != 0
                or outcome.get('reason') not in reasons or not isinstance(resolution,dict)
                or resolution.get('state') != 'unresolved' or resolution.get('reason') != outcome.get('reason')
                or row.get('id') != stable_id('provenance',outcome_id)):
            raise ValueError('Unsupported or mismatched generated native-relation receipt')
        binding = resolution.get('binding_ref')
        originals = bindings.get(binding,[])
        if not originals or any(item['document']['source_key'] != outcome.get('source_key') for item in originals):
            raise ValueError('Generated native-relation receipt has no exact source acquisition')
        history.setdefault(binding,[]).append({'outcome_id':outcome_id,'outcome_provenance_ref':row['id'],
            'relation_resolution_ref':resolution_ref})
        generated.add(row['id'])
    return history, generated


def _native_relation_targets(originals, versions):
    targets = {}
    for entry, document in originals:
        version = versions[entry['source_version_id']]
        descriptor = {'target_corpus_id':document['corpus_id'],'target_source_key':document['source_key'],
            'target_unit_key':document['unit_key'],'target_payload_sha256':version['payload_sha256']}
        for endpoint in (entry.get('block_id'),entry.get('variant_id')):
            if endpoint is not None:
                previous = targets.setdefault(endpoint,descriptor)
                if previous != descriptor:
                    targets[endpoint] = None
    return targets


def _translated_relations(original, entry, targets):
    """Re-resolve private native selectors; never inherit relation acceptance."""
    translated = []
    own_endpoints = {entry.get(key) for key in ('block_id','variant_id','raw_artifact_id','source_version_id')} - {None}
    own_binding = entry.get('binding_ref',entry.get('provenance_ref'))
    for old in original.get('relations',[]):
        relation = copy.deepcopy(old)
        if isinstance(relation.get('from_id'),str) and relation['from_id'] in own_endpoints:
            relation.pop('from_id')
        if relation.get('evidence_ref') == own_binding:
            relation.pop('evidence_ref')
        old_target = relation.get('to_id')
        target = targets.get(old_target) if isinstance(old_target,str) else None
        if target is not None:
            relation.pop('to_id')
            relation.update(target)
        if relation.get('kind') == 'exact_quote':
            relation['kind'] = 'derived_from'
            relation['basis'] = 'derived'
        relation['review_state'] = 'unreviewed'
        translated.append(relation)
    return translated


def scan_package(package_dir, output_dir=None):
    """Emit a separate immutable redacted package, with mappings kept private.

    The accepted original is only read. Validation failures affect this package
    alone, not other corpora. Output never receives a self-issued safe review.
    """
    from .package_io import emit_package
    source = Path(package_dir).resolve()
    output = Path(output_dir).resolve() if output_dir is not None else source.with_name(source.name + '-privacy-v1')
    if source == output or source in output.parents or output in source.parents:
        raise ValueError('Privacy variant must be separate from the immutable input tree')
    parent_dependencies(source)
    manifest_bytes = (source/'package.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    parent_hash = hashlib.sha256(manifest_bytes).hexdigest()
    private_path = source/'private'/'provenance.jsonl'
    entries = [json.loads(line) for line in private_path.read_text(encoding='utf-8').split('\n') if line.strip()]
    originals = [(entry,entry['document']) for entry in entries if isinstance(entry.get('document'),dict)]
    if not originals and manifest.get('counts',{}).get('blocks.jsonl',0):
        raise ValueError('Private normalized source documents unavailable; cannot prove complete screening')
    version_rows = [json.loads(line) for line in (source/'source-versions.jsonl').read_text(encoding='utf-8').split('\n') if line.strip()]
    parent_versions = {row['id']:row for row in version_rows}
    parent_variants = {row['id']:row for row in (json.loads(line) for line in (source/'variants.jsonl').read_text(encoding='utf-8').split('\n') if line.strip())}
    relation_history, generated_outcomes = _native_relation_history(entries)
    relation_targets = _native_relation_targets(originals,parent_versions)
    version_provenance = {(row.get('source_id'),row.get('payload_sha256')):row for row in entries if row.get('source_id') and row.get('payload_sha256')}
    persons, identifiers = _screening_terms(document for _,document in originals)
    documents = []
    for entry, original in originals:
        mappings = {}
        constraints = _privacy_constraints(original)
        if parent_variants.get(entry.get('variant_id'),{}).get('privacy_state') == 'quarantined':
            constraints['quarantined'] = True
        parent_history = relation_history.get(entry.get('binding_ref',entry.get('provenance_ref')),[])
        if parent_history:
            constraints['quarantined'] = True
        doc = _screen_tree(original,persons,identifiers,mappings)
        # P03 exposes only opaque hashed IDs. Native keys remain private so
        # screening creates a new text variant, never a new logical source.
        doc['source_key'] = original['source_key']
        doc['unit_key'] = original['unit_key']
        doc['corpus_id'] = original['corpus_id']
        doc['locator'] = _public_redacted_locator(
            original,doc['text'],persons,identifiers,mappings,
            parent_versions.get(entry.get('source_version_id')))
        doc['scope'] = copy.deepcopy(original.get('scope',{'kind':'global','tenant_id':None,'owner_user_id':None,'project_id':None}))
        doc['relations'] = _translated_relations(original,entry,relation_targets)
        # Availability history is not a permission/privacy grant. Native
        # selectors and historical evidence remain private SDK inputs.
        doc['decisions'] = [copy.deepcopy(item) for item in original.get('decisions',[])
                            if item.get('dimension') == 'acquisition' and item.get('target_kind','source') == 'source']
        quarantined = constraints['quarantined']
        doc['privacy_state'] = 'quarantined' if quarantined else 'machine_screened'
        doc['variant_kind'] = 'redacted'
        doc['transform_version'] = TRANSFORM_VERSION
        doc['mapping_ref'] = _privacy_mapping_ref(parent_hash,original,doc['text'],mappings)
        doc['locator']['mapping_ref'] = doc['mapping_ref']
        doc.setdefault('limitations',[]).extend(['Machine redaction is not independent privacy approval; unknown names may remain.','Source image and voice privacy unreviewed.','Adapted text; not an exact quote of original.'])
        doc.setdefault('metadata',{})['privacy_state'] = doc['privacy_state']
        doc['metadata']['exact_quote'] = False
        doc['metadata'].update(constraints)
        parent_version = parent_versions.get(entry.get('source_version_id'),{})
        doc['provenance'] = {'source_sha256': original.get('provenance',{}).get('source_payload_sha256') or original.get('provenance',{}).get('source_sha256') or parent_version.get('payload_sha256'),
            'origin_path':original['provenance']['origin_path'],
            'payload_encoding_version':parent_version.get('payload_encoding_version','native-bytes-v1'),
            'canonical_payload':version_provenance.get((parent_version.get('source_id'),parent_version.get('payload_sha256')),{}).get('canonical_payload'),
            'extractor':TRANSFORM_VERSION,'extractor_config':{'parent_package_sha256':parent_hash,'transform_version':TRANSFORM_VERSION},
            'parent_package_path':str(source),'parent_package_id':manifest['package_id'],
            'parent_acquisition_id':entry['id'],'parent_binding_ref':entry.get('binding_ref',entry.get('provenance_ref')),
            'parent_package_sha256':parent_hash,'parent_block_id':entry.get('block_id'),'parent_variant_id':entry.get('variant_id'),
            'parent_source_id':parent_version.get('source_id'),'parent_source_version_id':entry.get('source_version_id'),
            'parent_relation_history':copy.deepcopy(parent_history),
            'original_document':original,'privacy_mapping':mappings,'exact_person_terms':sorted(persons),'exact_identifier_terms':sorted(identifiers),
            'privacy_decision':{'state':doc['privacy_state'],'independently_safe':False,'transform_version':TRANSFORM_VERSION,'source_media_state':'unreviewed'}}
        if isinstance(original.get('provenance',{}).get('artifact'),dict):
            doc['provenance']['artifact'] = copy.deepcopy(original['provenance']['artifact'])
        documents.append(doc)
    outcomes = []
    for entry in entries:
        if not isinstance(entry.get('outcome'),dict):
            continue
        if entry['id'] in generated_outcomes:
            continue
        old = entry['outcome']
        new = _screen_tree(old,persons,identifiers,{},'/outcome')
        new['input_id'] = 'redacted-input:' + _digest(old.get('input_id'))
        new['source_key'] = old.get('source_key')
        outcomes.append(new)
    receipt = emit_package(output,documents,outcomes,package_id='privacy-'+parent_hash[:24],run_id=manifest.get('run_id','privacy'),producer='hardissoft_kb.privacy:'+TRANSFORM_VERSION)
    return dict(receipt,privacy_state='machine_screened',independently_safe=False,input_document_count=len(originals),output_document_count=len(documents),outcome_count=len(outcomes),parent_package_sha256=parent_hash)

def deidentified_mapping_ref(mapping):
    from .adapters.common import canonical_json
    return 'private:privacy-mapping:' + hashlib.sha256(canonical_json(mapping).encode('utf-8')).hexdigest()


def _verify_deidentified_export(document):
    """Bind a pre-intake de-identified record to its private mapping; not safety approval."""
    provenance = document.get('provenance', {})
    mapping = provenance.get('privacy_mapping')
    if not isinstance(mapping, dict) or mapping.get('kind') != 'deidentified_record':
        raise ValueError('De-identified record lacks private mapping')
    text = document.get('text')
    if not isinstance(text, str) or mapping.get('sanitized_text_sha256') != hashlib.sha256(text.encode('utf-8')).hexdigest():
        raise ValueError('De-identified text differs from private mapping')
    expected = deidentified_mapping_ref(mapping)
    if any(value != expected for value in (document.get('mapping_ref'), provenance.get('mapping_ref'),
                                           document.get('locator', {}).get('mapping_ref'))):
        raise ValueError('De-identified mapping reference mismatch')
    if document.get('privacy_state') != 'machine_screened' or provenance.get('privacy_decision', {}).get('independently_safe') is not False:
        raise ValueError('De-identified record asserted unreviewed safety')
    source_sha = mapping.get('source_sha256')
    if not isinstance(source_sha, str) or not re.fullmatch(r'[0-9a-f]{64}', source_sha) or provenance.get('source_sha256') != source_sha:
        raise ValueError('De-identified record source hash mismatch')
    return source_sha


def _verify_captured_redaction(document, cache):
    """Validate External185's native captured-span protocol, not a KB parent."""
    from .adapters.common import file_sha256
    from .adapters.external import _locator
    if document.get('corpus_id') != 'external185-corrected':
        raise ValueError('Captured External185 redaction has a different native corpus')
    provenance = document['provenance']
    mapping = provenance.get('variant_mapping')
    original = provenance.get('private_original_record')
    selected = provenance.get('selected_record')
    acquisition_snapshot = provenance.get('acquisition_record')
    if not all(isinstance(value,dict) for value in (mapping,original,selected,acquisition_snapshot)):
        raise ValueError('Captured redaction lacks explicit original/selected/acquisition mapping')
    source_id, unit_id = document['source_key'], document['unit_key']
    native_sha = provenance.get('source_payload_sha256') or provenance.get('source_sha256')
    if not re.fullmatch('[0-9a-f]{64}',str(native_sha)):
        raise ValueError('Captured redaction lacks native byte hash')
    if any(provenance.get(key,native_sha) != native_sha for key in ('source_sha256','source_payload_sha256')):
        raise ValueError('Captured redaction native source hashes disagree')
    start, end = mapping.get('source_char_start'), mapping.get('source_char_end')
    if type(start) is not int or type(end) is not int or not 0 <= start < end:
        raise ValueError('Captured redaction span is invalid')
    raw_text = provenance.get('original_text')
    if not isinstance(raw_text,str) or mapping.get('kind') != 'derived_from' or mapping.get('exact_quote') is not False:
        raise ValueError('Captured redaction is not an adapted original span')
    raw_sha = hashlib.sha256(raw_text.encode('utf-8')).hexdigest()
    selected_sha = hashlib.sha256(document['text'].encode('utf-8')).hexdigest()
    if mapping.get('original_sha256') != raw_sha or mapping.get('selected_sha256') != selected_sha:
        raise ValueError('Captured redaction original/selected text hash mismatch')
    for record in (original,selected):
        if any(record.get(key) != expected for key,expected in (('source_id',source_id),('chunk_id',unit_id),('source_sha256',native_sha),('source_char_start',start),('source_char_end',end))):
            raise ValueError('Captured redaction identity/source/span mismatch')
    if original.get('raw_text') != raw_text or original.get('chunk_text_sha256') != raw_sha or selected.get('text') != document['text']:
        raise ValueError('Captured redaction snapshot text mismatch')
    acquisition_path = Path(provenance['acquisition_path'])
    if not acquisition_path.is_absolute():
        raise ValueError('Captured acquisition path must be an exact private absolute path')
    captures = cache.setdefault('acquisitions',{})
    if acquisition_path not in captures:
        index = {}
        with acquisition_path.open(encoding='utf-8') as stream:
            for line in stream:
                if not line.strip():
                    continue
                row = json.loads(line)
                key = row['source_id']
                if key in index:
                    raise ValueError('Captured source acquisition identity is ambiguous')
                index[key] = row
        captures[acquisition_path] = index
    capture = captures[acquisition_path].get(source_id)
    if capture is None:
        raise ValueError('Captured source acquisition identity is missing')
    if ({key:value for key,value in capture.items() if key != 'text'} != acquisition_snapshot
            or capture.get('source_sha256') != native_sha or capture.get('status') != 'extracted'):
        raise ValueError('Captured acquisition snapshot changed or mismatched')
    full_text = capture.get('text')
    if not isinstance(full_text,str) or end > len(full_text) or full_text[start:end] != raw_text:
        raise ValueError('Captured original source span changed or mismatched')
    artifact = (acquisition_path.parent/capture['artifact_path']).resolve()
    original_artifact = (acquisition_path.parent/original['artifact_path']).resolve()
    raw_root = (acquisition_path.parent.parent/'raw').resolve()
    if not artifact.is_relative_to(raw_root) or artifact != original_artifact or artifact != Path(provenance['artifact_path']).resolve():
        raise ValueError('Captured artifact path escapes or mismatches native mapping')
    artifacts = cache.setdefault('artifacts',{})
    if artifact not in artifacts:
        artifacts[artifact] = file_sha256(artifact)
    if artifacts[artifact] != native_sha:
        raise ValueError('Captured native artifact bytes changed')
    original_locator = _locator(native_sha,full_text,start,end,artifact.suffix.lower()=='.pdf')
    if mapping.get('original_locator') != original_locator or provenance.get('original_document') != {'text':raw_text,'locator':original_locator}:
        raise ValueError('Captured original locator mapping mismatch')
    expected_ref = 'private:'+hashlib.sha256(json.dumps(mapping,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()
    if any(value != expected_ref for value in (document.get('mapping_ref'),provenance.get('mapping_ref'),document.get('locator',{}).get('mapping_ref'))):
        raise ValueError('Captured redaction mapping receipt mismatch')
    expected_locator = dict(kind='text',artifact_sha256=selected_sha,
        start_char=0,end_char=len(document['text']),
        coordinate_space='redacted_variant',quote_kind='adapted_redacted',
        adapted=True,mapping_ref=expected_ref)
    if document.get('locator') != expected_locator:
        raise ValueError('Captured selected locator does not describe its adapted text')
    return native_sha



def _selected_dependencies(entry, versions, blocks, variants, manifest):
    """Bind one private acquisition to its exact materialized selected graph."""
    document = entry['document']
    version_id, selected = entry.get('source_version_id'), entry.get('variant_id')
    version = versions.get(version_id)
    if not version or version.get('corpus_id') != document.get('corpus_id'):
        raise ValueError('Private acquisition has no exact source version')
    binding = entry.get('binding_ref',entry.get('provenance_ref'))
    ids = {entry['id'],version_id,version['source_id'],'package:'+manifest['package_id']}
    for value in (binding,entry.get('raw_artifact_id')):
        if value:
            ids.add(value)
    block = blocks.get(entry.get('block_id'))
    if selected is None:
        if entry.get('block_id') is not None:
            raise ValueError('Preparation-only acquisition unexpectedly has a public block')
        return ids
    variant = variants.get(selected)
    if (not block or not variant or block.get('source_version_id') != version_id
            or variant.get('parent_id') != block['id']
            or block.get('provenance_ref') != binding or variant.get('provenance_ref') != binding
            or block.get('content') != document['text'] or variant.get('text') != document['text']
            or variant.get('variant_kind') != document.get('variant_kind','original')
            or variant.get('transform_version') != document.get('transform_version','identity-v1')
            or variant.get('mapping_ref') != document.get('mapping_ref')):
        raise ValueError('Selected variant/block/source/acquisition graph mismatch')
    ids.update((selected,block['id'],block['artifact_id']))
    return ids


def parent_dependencies(package_dir):
    """Verify provenance protocols and exact transitive selected ancestry.

    Native External185 redactions bind captured bytes and extracted spans.
    Scanner redactions bind sealed parent package/acquisition graphs.
    Pre-intake de-identified exports bind text to a private mapping. None
    establishes independent safety; unknown protocols and changed parents fail.
    """
    from .adapters.common import GLOBAL_SCOPE
    from .package_io import validate_package
    cache, visiting, captured = {}, set(), {}

    def rows(root, name):
        return [json.loads(line) for line in (root/name).read_text(encoding='utf-8').split('\n') if line.strip()]

    def load(root):
        root = Path(root).resolve()
        if root in visiting:
            raise ValueError('Cyclic privacy package ancestry')
        if root in cache:
            return cache[root]
        if not validate_package(root).get('valid'):
            raise ValueError('Invalid sealed privacy dependency package')
        visiting.add(root)
        manifest_bytes = (root/'package.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        private = rows(root,'private/provenance.jsonl')
        versions = {row['id']:row for row in rows(root,'source-versions.jsonl')}
        blocks = {row['id']:row for row in rows(root,'blocks.jsonl')}
        variants = {row['id']:row for row in rows(root,'variants.jsonl')}
        relation_rows = {row['id']:row for row in rows(root,'relations.jsonl')}
        relation_endpoints = {}
        for relation in relation_rows.values():
            binding, endpoint = relation.get('provenance_ref'), relation.get('from_id')
            if isinstance(binding,str) and binding and isinstance(endpoint,str) and endpoint:
                relation_endpoints.setdefault((binding,endpoint),[]).append(relation['id'])
        relation_ids = {}
        for item in private:
            if isinstance(item.get('document'),dict):
                binding = item.get('binding_ref',item.get('provenance_ref'))
                block = item.get('block_id')
                if isinstance(binding,str) and binding and isinstance(block,str) and block:
                    relation_ids[binding] = sorted(relation_endpoints.get((binding,block),[]))
        documents = {row['id']:row for row in private if isinstance(row.get('document'),dict)}
        originals = [(row,row['document']) for row in documents.values()]
        relation_history, _ = _native_relation_history(private)
        relation_targets = _native_relation_targets(originals,versions)
        screening_persons,screening_identifiers = _screening_terms(row['document'] for row in documents.values())
        dependencies, parents, immediate = {}, set(), set()
        for item, doc in originals:
            if doc.get('variant_kind') != 'redacted':
                continue
            ids = _selected_dependencies(item,versions,blocks,variants,manifest)
            binding = item.get('binding_ref',item.get('provenance_ref'))
            ids.update(relation_ids.get(binding,[]))
            provenance = doc['provenance']
            transform = doc.get('transform_version')
            selected = item.get('variant_id')
            if transform == 'external185-v3-privacy-correction-v1':
                native_sha = _verify_captured_redaction(doc,captured)
                if versions[item['source_version_id']]['payload_sha256'] != native_sha:
                    raise ValueError('Captured source version does not bind native byte hash')
                ids.add(native_sha)
                if selected is not None:
                    dependencies[selected] = sorted(ids)
                continue
            if transform == DEIDENTIFIED_EXPORT_VERSION:
                ids.add(_verify_deidentified_export(doc))
                if selected is not None:
                    dependencies[selected] = sorted(ids)
                continue
            if transform != TRANSFORM_VERSION:
                raise ValueError('Unsupported redaction provenance protocol')
            parent_path = provenance.get('parent_package_path')
            if not isinstance(parent_path,str) or not Path(parent_path).is_absolute():
                raise ValueError('Redacted variant lacks exact private parent package path')
            parent = load(parent_path)
            if (parent['manifest_sha256'] != provenance.get('parent_package_sha256')
                    or parent['manifest']['package_id'] != provenance.get('parent_package_id')):
                raise ValueError('Parent manifest identity changed or mismatched')
            immediate.add(str(parent['root']))
            parents.add(str(parent['root']))
            parents.update(parent['result']['parent_package_dirs'])
            version_id = provenance.get('parent_source_version_id')
            version = parent['versions'].get(version_id)
            original = provenance.get('original_document')
            if (not version or version.get('source_id') != provenance.get('parent_source_id')
                    or item.get('source_version_id') != version_id or versions.get(version_id) != version
                    or not isinstance(original,dict)
                    or any(doc.get(key) != original.get(key) for key in ('corpus_id','source_key','unit_key'))
                    or doc.get('scope',GLOBAL_SCOPE) != original.get('scope',GLOBAL_SCOPE)):
                raise ValueError('Redaction changed logical source/version/scope identity')
            old_document = parent['documents'].get(provenance.get('parent_acquisition_id'))
            old_variant_id, old_block_id = provenance.get('parent_variant_id'), provenance.get('parent_block_id')
            if (not old_document or old_document.get('variant_id') != old_variant_id
                    or old_document.get('block_id') != old_block_id
                    or old_document.get('source_version_id') != version_id
                    or old_document.get('document') != original
                    or old_document.get('binding_ref',old_document.get('provenance_ref')) != provenance.get('parent_binding_ref')):
                raise ValueError('Parent variant/block/source/private-document graph mismatch')
            screening_mapping = {}
            screening_original = _screen_tree(original,parent['screening_persons'],parent['screening_identifiers'],screening_mapping)
            screening_text = screening_original.get('text')
            if not isinstance(screening_text,str) or doc.get('text') != screening_text:
                raise ValueError('Redacted text differs from pinned parent screening')
            expected_locator = _public_redacted_locator(
                original,screening_text,parent['screening_persons'],
                parent['screening_identifiers'],screening_mapping,version)
            stored_mapping = provenance.get('privacy_mapping')
            if stored_mapping != screening_mapping:
                raise ValueError('Redaction mapping differs from pinned parent screening')
            if (provenance.get('exact_person_terms') != sorted(parent['screening_persons'])
                    or provenance.get('exact_identifier_terms') != sorted(parent['screening_identifiers'])):
                raise ValueError('Stored screening terms differ from pinned parent package')
            expected_ref = _privacy_mapping_ref(parent['manifest_sha256'],original,screening_text,stored_mapping)
            expected_locator['mapping_ref'] = expected_ref
            if doc.get('mapping_ref') != expected_ref or doc.get('locator') != expected_locator:
                raise ValueError('Redacted mapping reference or locator differs from pinned parent screening')
            ids.update(_selected_dependencies(old_document,parent['versions'],parent['blocks'],parent['variants'],parent['manifest']))
            old_binding = old_document.get('binding_ref',old_document.get('provenance_ref'))
            ids.update(parent['relation_ids'].get(old_binding,[]))
            history = parent['relation_history'].get(old_binding,[])
            if provenance.get('parent_relation_history',[]) != history:
                raise ValueError('Parent generated relation history was changed or omitted')
            for receipt in history:
                ids.update(receipt.values())
            if doc.get('relations',[]) != _translated_relations(original,old_document,parent['relation_targets']):
                raise ValueError('Redaction dropped or changed native relation selectors')
            decisions = [decision for decision in original.get('decisions',[])
                         if decision.get('dimension') == 'acquisition' and decision.get('target_kind','source') == 'source']
            if doc.get('decisions',[]) != decisions:
                raise ValueError('Redaction changed private acquisition decisions')
            constraints = _privacy_constraints(original)
            if history or parent['variants'].get(old_variant_id,{}).get('privacy_state') == 'quarantined':
                constraints['quarantined'] = True
            if (doc.get('privacy_state') not in {'machine_screened','quarantined'}
                    or any(required and doc.get('metadata',{}).get(key) is not True for key,required in constraints.items())
                    or (constraints['quarantined'] and doc.get('privacy_state') != 'quarantined')):
                raise ValueError('Redaction dropped an inherited privacy restriction or asserted safety')
            ids.update(parent['result']['dependencies'].get(old_variant_id,[]))
            if selected is not None:
                dependencies[selected] = sorted(ids)
        result = {'parent_package_dir':next(iter(immediate)) if len(immediate) == 1 else None,
                  'parent_package_dirs':sorted(parents),'dependencies':dependencies}
        value = dict(root=root,manifest=manifest,manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
                     versions=versions,blocks=blocks,variants=variants,documents=documents,
                     screening_persons=screening_persons,screening_identifiers=screening_identifiers,
                     relation_history=relation_history,relation_targets=relation_targets,relation_ids=relation_ids,result=result)
        cache[root] = value
        visiting.remove(root)
        return value

    try:
        return load(package_dir)['result']
    except (OSError,KeyError,TypeError,json.JSONDecodeError) as error:
        raise ValueError('Privacy dependency is unavailable or malformed') from error


def _scope_allowed(scope, context):
    trusted = context.get('scope')
    if not isinstance(scope,dict) or not isinstance(trusted,dict):
        return False
    kind = scope.get('kind')
    if kind == 'global':
        return all(scope.get(key) is None for key in ('tenant_id','owner_user_id','project_id'))
    if kind not in {'user','project'} or trusted.get('kind') != kind:
        return False
    if not scope.get('tenant_id') or scope.get('tenant_id') != trusted.get('tenant_id'):
        return False
    if kind == 'user':
        return bool(scope.get('owner_user_id') and scope['owner_user_id'] == trusted.get('owner_user_id') == context.get('principal_id') and not scope.get('project_id'))
    return bool(scope.get('project_id') and scope['project_id'] == trusted.get('project_id'))


def eligible(record, context, destination='internal_retrieval'):
    """Only accept a trusted context constructed outside user request/document.

    Callers load current live deny overlays before every retrieval, citation,
    cache return and egress. Unavailable live policy fails closed; a historical
    release/grant or restored backup cannot override withdrawal/quarantine.
    """
    if destination not in _PERMISSIONS or not isinstance(record,dict) or not isinstance(context,dict):
        return False
    required = ('principal_id','grant_fingerprint','purpose','policy_revision')
    if not all(context.get(key) for key in required):
        return False
    if context.get('policy_current') is not True or not isinstance(context.get('current_denials'),(list,tuple,set,frozenset)):
        return False
    metadata = record.get('metadata') if isinstance(record.get('metadata'),dict) else {}
    if any(value.get(key) is True for value in (record,metadata) for key in ('denied','current_denied','quarantined','withdrawn','revoked','superseded')):
        return False
    if any(value.get('privacy_state') == 'quarantined' or value.get('version_state') in {'superseded','conflict','withdrawn'} for value in (record,metadata)):
        return False
    identifiers = {str(record.get(key)) for key in ('id','chunk_id','variant_id','source_version_id','source_id','evidence_source_group_id','artifact_id','package_id') if record.get(key) is not None}
    dependencies = record.get('dependency_ids',[])
    if not isinstance(dependencies,(list,tuple,set,frozenset)) or any(not isinstance(value,str) for value in dependencies):
        return False
    identifiers.update(dependencies)
    if identifiers.intersection(str(value) for value in context['current_denials']):
        return False
    if not _scope_allowed(record.get('scope'),context):
        return False
    collection = record.get('collection_id') or record.get('corpus_id')
    if not collection or collection not in context.get('allowed_collections',[]):
        return False
    permissions = record.get('permissions',{})
    if not isinstance(permissions,dict) or permissions.get(_PERMISSIONS[destination]) is not True:
        return False
    purposes = record.get('allowed_purposes')
    if purposes is not None and context['purpose'] not in purposes:
        return False
    if destination == 'processing':
        return True
    if any(value.get(key) for value in (record,metadata) for key in ('pending_markers','pending_privacy_markers','pii_markers_present','retrieval_denied','historical_only')):
        return False
    locator = record.get('safe_locator',{})
    is_forum = isinstance(locator,dict) and locator.get('kind') == 'forum'
    is_forum = is_forum or record.get('source_type') == 'forum_text' or metadata.get('source_type') == 'forum_text'
    if is_forum and record.get('privacy_state') == 'machine_screened' and record.get('operator_privacy_accepted') is not True:
        return False
    if context.get('purpose') != destination or not context.get('release_id'):
        return False
    role = record.get('content_role')
    if role in {'source_catalog','process_record','generated_draft'}:
        return False
    if role in {'operation_template','product_context'} and context.get('operation') not in {'rfq','quote_compare'}:
        return False
    if record.get('release_id') != context['release_id']:
        return False
    if record.get('independently_reviewed') is not True or record.get('provenance_verified') is not True:
        return False
    if not re.fullmatch('[0-9a-f]{64}', str(record.get('source_sha256',''))) or not isinstance(record.get('safe_locator'),dict) or not record['safe_locator']:
        return False
    state = record.get('privacy_state')
    if state != 'reviewed_safe':
        if not (destination == 'internal_retrieval' and state == 'machine_screened' and context.get('operator') is True and context.get('allow_machine_screened') is True):
            return False
    is_selected_text = record.get('variant_kind') == 'redacted' and isinstance(record.get('text'),str)
    if record.get('modality') in {'image','audio','video','frame','voice'} and not is_selected_text and record.get('media_privacy_reviewed') is not True:
        return False
    return True

