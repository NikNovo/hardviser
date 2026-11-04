"""Process-level cache of the authorized release subset for fast hybrid retrieval.

`hybrid.search` re-derives the authorized subset of the pinned release on every query: ~3.4 s for the
lexical candidate relation, ~8 s of the vector query re-verifying embedding coverage, and ~1.5 s per
row hydration. All of that depends only on the release, the current policy, and the grant, never on the
query. This module derives it once per key (release, policy revision, policy-table fingerprint, grant,
vector config) through the KB's own authorization functions, then answers queries with the same
lexical, structured, and vector rankings, the same fusion, and the same selection as `hybrid.search`.

Every search re-reads the policy revision under the KB's shared policy lock and fingerprints the
policy table; any change makes the cached index stale, and searches fall back to `hybrid.search`
while a background build replaces it. A built index is installed only after its in-memory vector
ranking reproduces the SQL vector ranking for a probe query.
"""
import logging
import threading

import numpy as np

from hardissoft_kb import catalog
from hardissoft_kb.search import hybrid, lexical, structured, vector

TOP_K = 5
_RANK_LIMIT = 100  # hybrid._search: min(_MAX_CANDIDATES, max(100, top_k * 8))
_EXCLUDED_ROLES = ('source_catalog', 'process_record', 'generated_draft')
_PROBE_QUERY = 'fast retrieval index verification probe'
_REQUEST = {'top_k': TOP_K, 'operation': 'explain', 'mode': 'hybrid'}
_LOG = logging.getLogger(__name__)


class Unavailable(RuntimeError):
    """No verified index for the current key; use hybrid.search."""


class _Index:
    def __init__(self, key, candidates, rows, chunk_ids, segment_starts, matrix, structured_present=True):
        self.key = key
        self.candidates = candidates          # authorized CandidateSet chunk ids (ranking universe)
        self.rows = rows                      # chunk_id -> authorized hydrated row at this key
        self.chunk_ids = chunk_ids            # chunk ids, one per contiguous segment group
        self.segment_starts = segment_starts  # first matrix row of each chunk's segments
        self.matrix = matrix                  # L2-normalized float32 segment embeddings
        # structured.rank returns [] without structured cells/tables in the release; its own
        # presence probe costs ~0.1-0.6 s per search, so it is evaluated once per key.
        self.structured_present = structured_present


_lock = threading.Lock()
_index = None
_building = False
_idle = threading.Event()  # set while no build is running
_idle.set()


def _request(query):
    return dict(_REQUEST, query=query)


def _policy_fingerprint(conn):
    return conn.execute('''SELECT md5(COALESCE(string_agg(
        target_id || ':' || revision || ':' || denied || ':' || quarantined || ':' || permissions::text,
        '|' ORDER BY target_id), '')) AS fingerprint FROM kb.policy''').fetchone()['fingerprint']


def _key(conn, context, info):
    return (info['release_id'], str(context['policy_revision']), _policy_fingerprint(conn),
            context['grant_fingerprint'], vector.embedding_spec()['config_hash'])


def _embedding_sql(candidates):
    """vector.search's own coverage CTEs, returning the scored segments instead of scoring in SQL."""
    sql = vector._search_sql(candidates.sql)
    cut = sql.index('query_parts AS MATERIALIZED (')
    prefix = sql[:cut].rstrip().rstrip(',')
    return prefix + '''
      SELECT coverage.selected AS selected, coverage.ready AS ready,
             manifest.chunk_id AS chunk_id, e.embedding::text AS embedding
      FROM manifest_segments manifest
      JOIN actual_vectors e
        ON e.chunk_id=manifest.chunk_id AND e.config_hash=manifest.config_hash
       AND e.embedding_key=manifest.embedding_key AND e.span=manifest.span
      CROSS JOIN coverage
      WHERE manifest.embedding_key IS NOT NULL AND manifest.span IS NOT NULL
        AND manifest.key_occurrences=1
      ORDER BY manifest.chunk_id'''


def _load_embeddings(conn, candidates, release_id, config_hash):
    conn.execute('SET LOCAL enable_nestloop=off')
    conn.execute("SET LOCAL work_mem TO '64MB'")
    params = tuple(candidates.params) + (release_id, config_hash, '[]', 1)
    vectors, chunk_ids, starts = [], [], []
    coverage = None
    with conn.cursor(name='fast_index_embeddings') as cursor:
        cursor.itersize = 4096
        cursor.execute(_embedding_sql(candidates), params)
        for row in cursor:
            coverage = (row['selected'], row['ready'])
            if not chunk_ids or chunk_ids[-1] != row['chunk_id']:
                chunk_ids.append(row['chunk_id'])
                starts.append(len(vectors))
            vectors.append(np.fromstring(row['embedding'][1:-1], dtype=np.float32, sep=','))
    conn.execute('RESET enable_nestloop')
    conn.execute('RESET work_mem')
    if coverage is None or coverage[0] != coverage[1]:
        raise RuntimeError('vector index incomplete or stale for the authorized subset')
    matrix = np.vstack(vectors)
    if matrix.shape[1] != vector.DIMENSIONS or not np.isfinite(matrix).all():
        raise RuntimeError('invalid embedding matrix')
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    if (norms == 0).any():
        raise RuntimeError('zero embedding vector')
    matrix /= norms
    return chunk_ids, np.asarray(starts, dtype=np.int64), matrix


def _vector_rank(index, prepared_query, limit=_RANK_LIMIT):
    """vector.search's ordering: per chunk the best query-segment x passage-segment cosine,
    then score descending, chunk id ascending."""
    queries = np.asarray([segment['embedding'] for segment in prepared_query['segments']], dtype=np.float32)
    queries /= np.linalg.norm(queries, axis=1, keepdims=True)
    segment_scores = (index.matrix @ queries.T).max(axis=1)
    chunk_scores = np.maximum.reduceat(segment_scores, index.segment_starts)
    count = min(limit, len(chunk_scores))
    if count < len(chunk_scores):
        top = np.argpartition(-chunk_scores, count - 1)[:count]
    else:
        top = np.arange(count)
    ordered = sorted(top.tolist(), key=lambda position: (-float(chunk_scores[position]), index.chunk_ids[position]))
    return [index.chunk_ids[position] for position in ordered]


def _lexical_rank(conn, query, index, candidates, limit=_RANK_LIMIT):
    """lexical.rank over the cached candidate set, using the chunk GIN indexes instead of the
    per-query candidate relation. Frequencies and ordering match lexical.rank."""
    if not isinstance(query, str) or not query.strip():
        return []
    if any(len(run) == 1 for run in lexical._CJK.findall(query)):
        return lexical.rank(conn, query, candidates, top_k=limit)  # unindexed substring path
    exact = lexical.technical_ids(query)
    bigrams = lexical.cjk_bigrams(query)
    rows = conn.execute('''SELECT c.chunk_id,
        ARRAY(SELECT DISTINCT value FROM unnest(c.technical_ids) AS requested(value)
              WHERE value = ANY(%s::text[])) AS matched_ids,
        COALESCE(ts_rank_cd(c.fts_ru, plainto_tsquery('russian', %s)), 0) +
        COALESCE(ts_rank_cd(c.fts_en, plainto_tsquery('english', %s)), 0) +
        CASE WHEN c.cjk_terms && %s::text[] THEN 1 ELSE 0 END AS score
      FROM kb.chunks c
      JOIN kb.release_members m ON m.release_id=%s AND m.entity_id=c.chunk_id
      WHERE c.technical_ids && %s::text[]
         OR c.fts_ru @@ plainto_tsquery('russian', %s)
         OR c.fts_en @@ plainto_tsquery('english', %s)
         OR c.cjk_terms && %s::text[]''',
        (exact, query, query, bigrams, index.key[0], exact, query, query, bigrams)).fetchall()
    rows = [row for row in rows if row['chunk_id'] in index.candidates]
    frequencies = {}
    for row in rows:
        for value in row['matched_ids']:
            frequencies[value] = frequencies.get(value, 0) + 1
    ranked = sorted(rows, key=lambda row: (
        -len(row['matched_ids']),
        -sum(1.0 / frequencies[value] for value in row['matched_ids']),
        -float(row['score']),
        row['chunk_id']))
    return [row['chunk_id'] for row in ranked[:limit]]


def search(conn, query, trusted_context):
    """hybrid.search for the bridge's fixed request; raises Unavailable when no verified index."""
    request = _request(query)
    prepared = vector.prepare_query(query)
    candidates, context, info = catalog.authorized_candidates(trusted_context, conn=conn, request=request)
    key = _key(conn, context, info)
    index = _index
    if index is None or index.key != key:
        _start_build(trusted_context)
        raise Unavailable('fast index not ready for the current release/policy')
    lexical_ids = _lexical_rank(conn, query, index, candidates)
    structured_ids = (structured.rank(conn, query, candidates, top_k=_RANK_LIMIT)
                      if index.structured_present else [])
    # vector.search ranks the candidate relation, then keeps hits that hydrate as authorized rows.
    vector_ids = [chunk_id for chunk_id in _vector_rank(index, prepared) if chunk_id in index.rows]
    reasons = {}
    for name, ranking in (('lexical', lexical_ids), ('structured', structured_ids), ('vector', vector_ids)):
        for chunk_id in ranking:
            reasons.setdefault(chunk_id, []).append(name)
    ranked = hybrid.reciprocal_rank_fusion([lexical_ids, structured_ids, vector_ids])
    by_id = {chunk_id: index.rows[chunk_id] for chunk_id, _ in ranked[:_RANK_LIMIT] if chunk_id in index.rows}
    groups, selected = set(), []
    for chunk_id, score in ranked:
        row = by_id.get(chunk_id)
        if row is None or row['content_role'] in _EXCLUDED_ROLES:
            continue
        group = row['evidence_source_group_id']
        if group in groups:
            continue
        groups.add(group)
        selected.append((chunk_id, score, row))
        if len(selected) >= TOP_K:
            break
    selected = hybrid._select_vector_representatives(query, selected, ranked, by_id, vector_ids)
    results = []
    for chunk_id, score, row in selected:
        view = hybrid.citation_view(row, 'explain')
        view.update(reasons=reasons.get(chunk_id, []), rrf_score=score)
        results.append(view)
    return results


def _build(trusted_context):
    """Derive, verify, and install the index for the current key in one rolled-back transaction."""
    global _index
    from . import retrieval  # late import: retrieval imports this module
    conn = retrieval._open_connection()
    try:
        conn.execute('SET LOCAL max_parallel_workers_per_gather = 0')
        request = _request(_PROBE_QUERY)
        candidates, context, info = catalog.authorized_candidates(trusted_context, conn=conn, request=request)
        key = _key(conn, context, info)
        candidate_ids = frozenset(row['chunk_id'] for row in conn.execute(
            'SELECT chunk_id FROM (' + candidates.sql + ') AS candidate', candidates.params).fetchall())
        authorized, _, _ = catalog.authorized_rows(trusted_context, conn=conn, chunk_ids=None, request=request)
        rows = {row['chunk_id']: row for row in authorized if row['chunk_id'] in candidate_ids}
        chunk_ids, starts, matrix = _load_embeddings(conn, candidates, info['release_id'], key[4])
        structured_present = conn.execute('''SELECT EXISTS (
          SELECT 1 FROM kb.read_release_structured_entities
          WHERE release_id=%s AND entity_type IN ('cell','table')
        ) AS present''', (info['release_id'],)).fetchone()['present']
        index = _Index(key, candidate_ids, rows, chunk_ids, starts, matrix, structured_present)
        # vector.search runs every frozen-index check (release status, config, artifact, closure,
        # coverage) and is the reference ranking the in-memory scorer must reproduce.
        prepared = vector.prepare_query(_PROBE_QUERY)
        retrieval._local.connection = conn
        try:
            reference = vector.search(_PROBE_QUERY, candidates, info['release_id'], top_k=_RANK_LIMIT,
                                      expected_config_hash=key[4], prepared_query=prepared)
        finally:
            retrieval._local.connection = None
        reference_ids = [item['chunk_id'] for item in reference]
        produced = [chunk_id for chunk_id in _vector_rank(index, prepared) if chunk_id in rows]
        # Float rounding may reorder near-equal scores at the window edge, never the head.
        if not set(reference_ids[:40]) <= set(produced[:60]) or reference_ids[:5] != produced[:5]:
            raise RuntimeError('in-memory vector ranking diverges from the SQL reference')
        with _lock:
            _index = index
        _LOG.warning('fast retrieval index ready: %d chunks, %d segments, %d authorized rows',
                     len(chunk_ids), matrix.shape[0], len(rows))
    finally:
        try:
            conn.rollback()
        finally:
            conn.close()


def _build_and_clear(trusted_context):
    global _building
    try:
        _build(trusted_context)
    except Exception as error:  # the slow path keeps serving; the next search retries the build
        _LOG.warning('fast retrieval index build failed: %s: %s', type(error).__name__, error)
    finally:
        with _lock:
            _building = False
            _idle.set()


def _start_build(trusted_context):
    global _building
    with _lock:
        if _building:
            return
        _building = True
        _idle.clear()
    threading.Thread(target=_build_and_clear, args=(dict(trusted_context),), name='fast-index-build',
                     daemon=True).start()


def build_now(trusted_context):
    """Synchronous build (operator tools); waits out a build already in progress instead.
    Failure leaves the slow path in place."""
    global _building
    with _lock:
        running = _building
        if not running:
            _building = True
            _idle.clear()
    if running:
        _idle.wait()
        return
    _build_and_clear(dict(trusted_context))


def ready():
    return _index is not None
