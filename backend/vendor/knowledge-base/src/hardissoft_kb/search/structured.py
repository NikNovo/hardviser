"""Set-based structured ranking and explicitly accepted/native context edges."""
import re

SPEC = {'method': 'structured', 'version': 'cells-links-v3-native-order'}
_RELATION_KINDS = ('requires_context', 'reply_to', 'post_reference', 'attached_to',
                   'derived_from', 'caption_of', 'translation_of')


def _candidate_relation(candidates):
    sql = getattr(candidates, 'sql', None)
    params = getattr(candidates, 'params', None)
    release_id = getattr(candidates, 'release_id', None)
    if not isinstance(sql, str) or not isinstance(params, (tuple, list)) or not isinstance(release_id, str):
        raise TypeError('authorized CandidateSet required')
    return sql, tuple(params), release_id


def _limit(value, maximum=500):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f'limit must be 1..{maximum}')
    return value


def rank(conn, query, candidates, top_k=100):
    """Find candidate documents using release-filtered structured cells."""
    _limit(top_k)
    tokens = sorted(set(re.findall(r'[\w.+%-]+', query.casefold()))) if isinstance(query, str) else []
    if not tokens:
        return []
    sql, params, release_id = _candidate_relation(candidates)
    # An empty release-pinned structured projection cannot produce any hits.
    # Do not materialize the expensive authorized chunk relation in that case.
    # Presence never authorizes a hit: the unchanged eligible join below does.
    present = conn.execute('''SELECT EXISTS (
      SELECT 1 FROM kb.read_release_structured_entities
      WHERE release_id=%s AND entity_type IN ('cell','table')
    ) AS present''', (release_id,)).fetchone()['present']
    if not present:
        return []
    rows = conn.execute(f'''WITH eligible AS MATERIALIZED (
      SELECT chunk_id FROM ({sql}) authorized
    ), cells AS MATERIALIZED (
      SELECT e.payload->>'document_id' AS chunk_id,
        lower(concat_ws(' ',e.payload->>'raw_value',e.payload->>'parsed_value',e.payload->>'unit',
          e.payload->>'currency',e.payload->>'quantity_break',e.payload->>'formula',
          e.payload->>'cached_value',e.payload->>'a1_ref',e.payload->>'cell_type',
          (e.payload->'header_path')::text)) AS searchable_text
      FROM kb.read_release_structured_entities e
      JOIN eligible a ON a.chunk_id=e.payload->>'document_id'
      WHERE e.release_id=%s AND e.entity_type IN ('cell','table')
    ), hits AS (
      SELECT c.chunk_id, count(DISTINCT token.value) AS score
      FROM cells c CROSS JOIN unnest(%s::text[]) token(value)
      WHERE position(token.value in c.searchable_text) > 0
      GROUP BY c.chunk_id
    ) SELECT chunk_id FROM hits ORDER BY score DESC,chunk_id LIMIT %s''',
      params + (release_id, tokens, top_k)).fetchall()
    return [row['chunk_id'] for row in rows]


def neighbors(conn, candidates, chunk_ids, limit=4):
    """Return bounded selected context via accepted edges or exact native point order.

    Relation endpoints are matched only through exact release-pinned dependencies. Native
    adjacency requires the same source version, exact typed track, and coordinate kind; no
    same-video hash/title or generic same-source proximity is used.
    """
    chunk_ids = list(dict.fromkeys(chunk_ids))
    if not chunk_ids:
        return {}
    if len(chunk_ids) > 50:
        raise ValueError('neighbor seeds must be bounded to 50')
    _limit(limit, 12)
    sql, params, release_id = _candidate_relation(candidates)
    edge_kinds = list(_RELATION_KINDS)
    rows = conn.execute(f'''WITH eligible AS MATERIALIZED (
        SELECT chunk_id,source_version_id,context_order
        FROM ({sql}) authorized
      ), seeds AS (
        SELECT a.chunk_id FROM eligible a WHERE a.chunk_id=ANY(%s::text[])
      ), seed_identity AS (
        SELECT s.chunk_id,s.chunk_id AS entity_id FROM seeds s
        UNION
        SELECT s.chunk_id,d.dependency_id FROM seeds s
          JOIN kb.release_chunk_dependencies d ON d.chunk_id=s.chunk_id AND d.release_id=%s
      ), candidate_identity AS (
        SELECT a.chunk_id,a.chunk_id AS entity_id FROM eligible a
        UNION
        SELECT a.chunk_id,d.dependency_id FROM eligible a
          JOIN kb.release_chunk_dependencies d ON d.chunk_id=a.chunk_id AND d.release_id=%s
      ), accepted_edges AS (
        SELECT e.id,e.from_id,e.to_id,e.kind AS relation_kind
        FROM kb.read_release_relations e
        WHERE e.release_id=%s AND e.kind=ANY(%s::text[])
          AND NOT EXISTS(SELECT 1 FROM kb.policy d WHERE d.target_id=e.id AND
            (d.denied OR d.quarantined OR
             (d.permissions ? 'internal_retrieval_allowed' AND
              d.permissions->'internal_retrieval_allowed' IS DISTINCT FROM 'true'::jsonb)))
      ), relation_neighbors AS (
        SELECT s.chunk_id AS seed_id,c.chunk_id AS neighbor_id,e.relation_kind,
          0::numeric AS distance,CASE WHEN e.relation_kind='requires_context' THEN 0 ELSE 1 END AS priority
        FROM seed_identity s JOIN accepted_edges e ON e.from_id=s.entity_id
        JOIN candidate_identity c ON c.entity_id=e.to_id
        WHERE s.chunk_id<>c.chunk_id
        UNION ALL
        SELECT s.chunk_id,c.chunk_id,e.relation_kind,0::numeric,
          CASE WHEN e.relation_kind='requires_context' THEN 0 ELSE 1 END
        FROM seed_identity s JOIN accepted_edges e ON e.to_id=s.entity_id
        JOIN candidate_identity c ON c.entity_id=e.from_id
        WHERE s.chunk_id<>c.chunk_id
      ), native_rows AS MATERIALIZED (
        SELECT a.chunk_id,a.source_version_id,
          a.context_order->'track' AS track,
          a.context_order->>'position_kind' AS position_kind,
          CASE WHEN a.context_order->>'position' ~ '^-?[0-9]+$'
               THEN (a.context_order->>'position')::numeric END AS position
        FROM eligible a
        WHERE jsonb_typeof(a.context_order)='object'
          AND a.context_order->>'position_kind' IN ('segment_index','timestamp_ms','pts')
          AND a.context_order->>'position' ~ '^-?[0-9]+$'
      ), native_neighbors AS (
        SELECT s.chunk_id AS seed_id,n.chunk_id AS neighbor_id,'native_order'::text AS relation_kind,
          abs(s.position-n.position) AS distance,2 AS priority
        FROM seeds seed
        JOIN native_rows s ON s.chunk_id=seed.chunk_id
        JOIN LATERAL (
          SELECT c.chunk_id,c.position
          FROM native_rows c
          WHERE c.source_version_id=s.source_version_id
            AND c.track=s.track AND c.position_kind=s.position_kind
            AND c.chunk_id<>s.chunk_id
            AND NOT EXISTS(SELECT 1 FROM relation_neighbors r
              WHERE r.seed_id=s.chunk_id AND r.neighbor_id=c.chunk_id)
          ORDER BY abs(s.position-c.position),c.chunk_id
          LIMIT %s
        ) n ON TRUE
      ), all_neighbors AS (
        SELECT * FROM relation_neighbors UNION ALL SELECT * FROM native_neighbors
      ), unique_neighbors AS (
        SELECT DISTINCT ON (seed_id,neighbor_id) seed_id,neighbor_id,relation_kind,distance,priority
        FROM all_neighbors ORDER BY seed_id,neighbor_id,priority,distance,relation_kind
      ), ranked AS (
        SELECT *,row_number() OVER(PARTITION BY seed_id ORDER BY priority,distance,neighbor_id) AS ordinal
        FROM unique_neighbors
      ) SELECT seed_id,neighbor_id,relation_kind FROM ranked
        WHERE ordinal<=%s ORDER BY seed_id,ordinal''',
      params + (chunk_ids, release_id, release_id, release_id, edge_kinds, limit, limit)).fetchall()
    result = {chunk_id: [] for chunk_id in chunk_ids}
    for row in rows:
        result.setdefault(row['seed_id'], []).append({
            'chunk_id': row['neighbor_id'], 'relation_kind': row['relation_kind']})
    return result
