"""Bounded PostgreSQL RU/EN lexical and exact technical/CJK ranking."""
import re

SPEC = {'method': 'lexical', 'version': 'pg-ru-en-technical-cjk-v1', 'cjk': 'cjk-bigram-v1'}
_CJK = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+')
_ID = re.compile(r'(?<![\w])(?:[A-Za-z0-9]+(?:[-_./:+][A-Za-z0-9]+)*)(?![\w])')


def technical_ids(text):
    return sorted({match.group().casefold() for match in _ID.finditer(text)
                   if any(char.isalpha() for char in match.group())
                   and (any(char.isdigit() for char in match.group())
                        or any(char in '-_./:+' for char in match.group()))})


def cjk_bigrams(text):
    return list(dict.fromkeys(run[index:index + 2]
                              for run in _CJK.findall(text)
                              for index in range(len(run) - 1)))


def _candidate_relation(candidates):
    sql = getattr(candidates, 'sql', None)
    params = getattr(candidates, 'params', None)
    if not isinstance(sql, str) or not isinstance(params, (tuple, list)):
        raise TypeError('authorized CandidateSet required')
    return sql, tuple(params)


def _limit(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 500:
        raise ValueError('rank limit must be 1..500')
    return value


def _exact_id_score_ctes(sql, *, include_text=False):
    columns = ['chunk_id', 'technical_ids', 'fts_ru', 'fts_en', 'cjk_terms']
    if include_text:
        columns.append('retrieval_text')
    return f'''WITH eligible AS MATERIALIZED (
        SELECT {', '.join(columns)} FROM ({sql}) AS candidate
      ),
      id_matches AS MATERIALIZED (
        SELECT DISTINCT a.chunk_id, requested.value
        FROM eligible a
        CROSS JOIN LATERAL unnest(a.technical_ids) AS requested(value)
        WHERE a.technical_ids && %s::text[]
          AND requested.value = ANY(%s::text[])
      ),
      id_frequencies AS (
        SELECT value, count(*) AS document_frequency
        FROM id_matches GROUP BY value
      ),
      id_scores AS (
        SELECT matches.chunk_id,
          count(*) AS matched_id_count,
          sum(1.0 / frequencies.document_frequency) AS rarity_score
        FROM id_matches matches
        JOIN id_frequencies frequencies USING (value)
        GROUP BY matches.chunk_id
      )'''


def rank(conn, query, candidates, top_k=100):
    """Rank only rows in the SQL-authorized relation; never materialize all text in Python."""
    if not isinstance(query, str) or not query.strip():
        return []
    sql, params = _candidate_relation(candidates)
    exact = technical_ids(query)
    bigrams = cjk_bigrams(query)
    singles = list(dict.fromkeys(run for run in _CJK.findall(query) if len(run) == 1))
    single_char_clause = ''
    query_params = (exact, exact, query, query, bigrams, query, query, bigrams)
    if singles:
        single_char_clause = '''
        OR EXISTS(SELECT 1 FROM unnest(%s::text[]) token(value)
                  WHERE position(token.value in lower(a.retrieval_text)) > 0)'''
        query_params += (singles,)
    id_score_ctes = _exact_id_score_ctes(sql, include_text=bool(singles))
    rows = conn.execute(f'''{id_score_ctes}
      SELECT a.chunk_id,
        COALESCE(id_scores.matched_id_count,0) AS matched_id_count,
        COALESCE(id_scores.rarity_score,0) AS rarity_score,
        COALESCE(ts_rank_cd(a.fts_ru,plainto_tsquery('russian',%s)),0) +
        COALESCE(ts_rank_cd(a.fts_en,plainto_tsquery('english',%s)),0) +
        CASE WHEN a.cjk_terms && %s::text[] THEN 1 ELSE 0 END AS score
      FROM eligible a
      LEFT JOIN id_scores ON id_scores.chunk_id=a.chunk_id
      WHERE id_scores.chunk_id IS NOT NULL OR
        a.fts_ru @@ plainto_tsquery('russian',%s) OR
        a.fts_en @@ plainto_tsquery('english',%s) OR
        a.cjk_terms && %s::text[]{single_char_clause}
      ORDER BY matched_id_count DESC, rarity_score DESC, score DESC, a.chunk_id
      LIMIT %s''', params + query_params + (_limit(top_k),)).fetchall()
    return [row['chunk_id'] for row in rows]
