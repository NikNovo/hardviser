"""Pinned CPU E5 encoder and exact cosine over a release-authorized subset.

Use CPython 3.10.12 with the vendored `requirements/embedding.lock`; supply the vendor source on `PYTHONPATH`.
  python -m hardissoft_kb.search.vector prepare
  python -m hardissoft_kb.search.vector encode --kind query < texts.jsonl
  python -m hardissoft_kb.search.vector status RELEASE
  python -m hardissoft_kb.search.vector index RELEASE --batch-size 8 --limit 32
Mass indexing is dispatched by the resource scheduler, never this pilot CLI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import sys
import threading
from functools import lru_cache

MODEL = 'intfloat/multilingual-e5-small'
REVISION = '614241f622f53c4eeff9890bdc4f31cfecc418b3'
DIMENSIONS = 384
MAX_TOKENS = 512
SEGMENT_TARGET_TOKENS = 448
MAX_QUERY_SEGMENTS = 32
MAX_QUERY_CHARACTERS = 16_384
THREADS = 2
INDEX_VERSION = 2
QUERY_AGGREGATION = 'max_query_segment_passage_segment_cosine'
ARTIFACT_MANIFEST_SHA256 = '2af4ff8fc7830d6017a216cde3e5798e3daaef21119ec3fffa6da08c1d56d600'
PYTHON_VERSION = '3.10.12'
EXCLUDED_ROLES = ('source_catalog', 'process_record', 'generated_draft')
ARTIFACT_SCHEMA = 'his.kb.vector-artifact.v1'
_DEFAULT_ROOT = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share'))) / 'hardviser' / 'knowledge-base'
ROOT = Path(os.environ.get('HIS_KB_ROOT', str(_DEFAULT_ROOT)))
RUNTIME = ROOT / 'runtime' / 'embeddings'
_LOCK_PATH = Path(__file__).resolve().parents[3] / 'requirements' / 'embedding.lock'


def _read_embedding_lock():
    """Load the full resolved pin set; an unpinned line is an integrity error."""
    raw = _LOCK_PATH.read_bytes()
    dependencies = {}
    for line in raw.decode('utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)', line)
        if not match:
            raise RuntimeError('requirements/embedding.lock contains an unpinned dependency')
        name = re.sub(r'[-_.]+', '-', match.group(1)).lower()
        if name in dependencies:
            raise RuntimeError('requirements/embedding.lock contains a duplicate dependency')
        dependencies[name] = match.group(2)
    required = {'torch', 'transformers', 'tokenizers', 'numpy', 'safetensors',
                'sentencepiece', 'huggingface-hub'}
    if not required.issubset(dependencies):
        raise RuntimeError('requirements/embedding.lock is missing encoder dependencies')
    return hashlib.sha256(raw).hexdigest(), dependencies


EMBEDDING_LOCK_SHA256, ENCODER_VERSIONS = _read_embedding_lock()


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode('utf-8')).hexdigest()


def _text_sha256(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()



def _valid_vector(vector, *, normalized=False):
    if not isinstance(vector, (list, tuple)) or len(vector) != DIMENSIONS:
        return False
    if any(isinstance(value, bool) for value in vector):
        return False
    try:
        if not all(math.isfinite(value) for value in vector) or not any(vector):
            return False
    except (TypeError, ValueError, OverflowError):
        return False
    if not normalized:
        return True
    norm = math.sqrt(sum(value * value for value in vector))
    return math.isfinite(norm) and abs(norm - 1.0) <= 1e-4



def embedding_spec():
    """Every encoder, segmentation, and exact-scoring setting is identity-bound."""
    settings = {'model': MODEL, 'revision': REVISION, 'tokenizer_revision': REVISION,
                'dimensions': DIMENSIONS, 'max_tokens': MAX_TOKENS,
                'segment_target_tokens': SEGMENT_TARGET_TOKENS,
                'pooling': 'attention_mask_mean', 'normalization': 'l2', 'metric': 'cosine',
                'prefixes': {'query': 'query: ', 'passage': 'passage: '},
                'segmentation': 'contiguous_character_spans_token_budget_v1',
                'artifact_manifest_sha256': ARTIFACT_MANIFEST_SHA256,
                'embedding_lock_sha256': EMBEDDING_LOCK_SHA256,
                'dependencies': dict(sorted(ENCODER_VERSIONS.items())),
                'python': PYTHON_VERSION, 'query_aggregation': QUERY_AGGREGATION,
                'index_version': INDEX_VERSION, 'dtype': 'float32', 'device': 'cpu',
                'threads': THREADS, 'torch_interop_threads': 1}
    settings.update(ENCODER_VERSIONS)
    return {**settings, 'config_hash': _hash(settings)}


def embedding_key(text, kind='passage'):
    _validate_kind(kind)
    if not isinstance(text, str):
        raise ValueError('Embedding input must be text')
    return _hash({'text': text, 'kind': kind, 'config_hash': embedding_spec()['config_hash']})


def _validate_kind(kind):
    if kind not in ('query', 'passage'):
        raise ValueError('kind must be query or passage')


def _sha_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def prepare_model():
    """Fetch only the pinned safetensors revision and seal its exact local artifacts."""
    from huggingface_hub import snapshot_download
    RUNTIME.mkdir(parents=True, exist_ok=True)
    path = Path(snapshot_download(MODEL, revision=REVISION,
                    cache_dir=str(RUNTIME / 'hub'),
                    allow_patterns=['config.json', 'model.safetensors', 'tokenizer.json',
                                    'tokenizer_config.json', 'special_tokens_map.json',
                                    'sentencepiece.bpe.model']))
    files = {p.name: _sha_file(p) for p in sorted(path.iterdir()) if p.is_file()}
    if not {'config.json', 'model.safetensors', 'tokenizer.json'} <= files.keys():
        raise RuntimeError('Pinned model download incomplete')
    expected = {
        'model.safetensors': '1a55775f53449dac10a2bcbc312469fac40b96d53198c407081a831f81c98477',
        'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
        'sentencepiece.bpe.model': 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865',
    }
    if any(files.get(name) != digest for name, digest in expected.items()):
        raise RuntimeError('Downloaded weights/tokenizer do not match upstream pinned LFS SHA256')
    expected_blobs = {'config.json': '60a2a84020f1d74cc53ea9e8c4e91cf4af6c2b68',
                      'tokenizer_config.json': '059214673d9d6d2ee319411e2ffec8c024b816d5',
                      'special_tokens_map.json': 'e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b'}
    for name, digest in expected_blobs.items():
        data = (path / name).read_bytes()
        blob = b'blob ' + str(len(data)).encode() + b'\0' + data
        if hashlib.sha1(blob).hexdigest() != digest:
            raise RuntimeError('Pinned upstream config/tokenizer git blob mismatch: ' + name)
    config = json.loads((path / 'config.json').read_text(encoding='utf-8'))
    if config.get('hidden_size') != DIMENSIONS or config.get('max_position_embeddings', 0) < MAX_TOKENS:
        raise RuntimeError('Pinned E5 configuration does not match dimensional/token contract')
    manifest = {'model': MODEL, 'revision': REVISION, 'files': files}
    if _hash(manifest) != ARTIFACT_MANIFEST_SHA256:
        raise RuntimeError('Pinned artifact manifest identity mismatch')
    target = RUNTIME / ('artifacts-' + REVISION + '.json')
    if target.exists():
        if json.loads(target.read_text(encoding='utf-8')) != manifest:
            raise RuntimeError('Model artifact checksum differs from sealed manifest')
    else:
        with target.open('x', encoding='utf-8') as stream:
            json.dump(manifest, stream, sort_keys=True, indent=2)
    return {'path': str(path), 'manifest_sha256': _hash(manifest), **embedding_spec()}


_RUNTIME_LOCK = threading.Lock()

@lru_cache(maxsize=1)
def _runtime_cached():
    """Load one local CPU model per process; never download during encode/search."""
    for name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
        os.environ[name] = str(THREADS)
    os.environ['TOKENIZERS_PARALLELISM'] = 'false'
    from importlib.metadata import version
    import torch
    from transformers import AutoModel, AutoTokenizer
    if platform.python_version() != PYTHON_VERSION:
        raise RuntimeError('Python runtime version differs from requirements/embedding.lock')
    actual = {name: version(name) for name in ENCODER_VERSIONS}
    if actual != ENCODER_VERSIONS:
        raise RuntimeError('Embedding runtime version differs from requirements/embedding.lock')
    torch.set_num_threads(THREADS)
    if torch.get_num_interop_threads() != 1:
        torch.set_num_interop_threads(1)
    manifest_path = RUNTIME / ('artifacts-' + REVISION + '.json')
    if not manifest_path.exists():
        raise RuntimeError('Embedding model unavailable: use the already prepared local model artifacts')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('model') != MODEL or manifest.get('revision') != REVISION:
        raise RuntimeError('Embedding artifact model/revision mismatch')
    if _hash(manifest) != ARTIFACT_MANIFEST_SHA256:
        raise RuntimeError('Embedding artifact manifest identity mismatch')
    path = RUNTIME / 'hub' / 'models--intfloat--multilingual-e5-small' / 'snapshots' / REVISION
    for name, digest in manifest['files'].items():
        if _sha_file(path / name) != digest:
            raise RuntimeError('Embedding artifact hash mismatch: ' + name)
    tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True,
                                              use_fast=True, trust_remote_code=False)
    model = AutoModel.from_pretrained(str(path), local_files_only=True,
                                      trust_remote_code=False, use_safetensors=True).to('cpu').eval()
    if model.config.hidden_size != DIMENSIONS:
        raise RuntimeError('Wrong embedding dimensions')
    return torch, tokenizer, model


def _runtime():
    """Share one concurrent initialization and reuse its process-local runtime."""
    with _RUNTIME_LOCK:
        return _runtime_cached()


_runtime.cache_clear = _runtime_cached.cache_clear


_TOKENIZER_LOCK = threading.Lock()


def _tokenize(tokenizer, *args, **kwargs):
    """Guard fast-tokenizer calls whose padding/truncation state is mutable."""
    with _TOKENIZER_LOCK:
        return tokenizer(*args, **kwargs)


def segment_text(text, kind='passage', *, tokenizer=None):
    """Split without truncation; returned spans cover original Unicode characters."""
    _validate_kind(kind)
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Embedding input must be a nonempty string')
    if tokenizer is None:
        tokenizer = _runtime()[1]
    prefix = embedding_spec()['prefixes'][kind]

    def input_length(value):
        return len(_tokenize(tokenizer, prefix + value, add_special_tokens=True,
                             truncation=False, verbose=False)['input_ids'])

    def payload_length(value):
        return len(_tokenize(tokenizer, value, add_special_tokens=False,
                             truncation=False, verbose=False)['input_ids'])

    parts, start = [], 0
    while start < len(text):
        end = len(text)
        if payload_length(text[start:end]) > SEGMENT_TARGET_TOKENS or input_length(text[start:end]) > MAX_TOKENS:
            offsets = _tokenize(tokenizer, text[start:], add_special_tokens=False,
                                truncation=False, return_offsets_mapping=True)['offset_mapping']
            prefix_tokens = len(_tokenize(tokenizer, prefix, add_special_tokens=True,
                                          truncation=False, verbose=False)['input_ids'])
            budget = min(SEGMENT_TARGET_TOKENS, MAX_TOKENS - prefix_tokens)
            if budget < 1 or not offsets:
                raise RuntimeError('Tokenizer leaves no text token budget')
            end = start + offsets[min(budget, len(offsets)) - 1][1]
            while end > start and (payload_length(text[start:end]) > SEGMENT_TARGET_TOKENS
                                   or input_length(text[start:end]) > MAX_TOKENS):
                end = start + (end - start) // 2
        if end <= start:
            raise ValueError('Tokenizer cannot segment this input within model context')
        parts.append({'text': text[start:end], 'start': start, 'end': end,
                      'token_count': input_length(text[start:end])})
        start = end
    _validate_span_coverage(text, parts)
    return parts


def _validate_span_coverage(text, parts):
    if not isinstance(parts, list) or not parts:
        raise RuntimeError('Encoder segmentation produced no spans')
    cursor = 0
    for part in parts:
        if not isinstance(part, dict) or part.get('start') != cursor:
            raise RuntimeError('Encoder spans do not form contiguous Unicode coverage')
        end = part.get('end')
        if type(end) is not int or end <= cursor or end > len(text):
            raise RuntimeError('Encoder emitted an invalid Unicode span')
        if part.get('text') != text[cursor:end]:
            raise RuntimeError('Encoder span text differs from source variant')
        cursor = end
    if cursor != len(text):
        raise RuntimeError('Encoder spans do not cover the complete source variant')


def _validate_segment_manifest(text, segments, passage_key):
    if not isinstance(segments, list) or not segments:
        raise RuntimeError('Embedding checkpoint has an empty segment manifest')
    cursor, seen = 0, set()
    for part in segments:
        span = part.get('span') if isinstance(part, dict) else None
        if not isinstance(span, dict) or span.get('unit') != 'unicode_character':
            raise RuntimeError('Embedding checkpoint span unit is invalid')
        start, end = span.get('start'), span.get('end')
        if type(start) is not int or type(end) is not int or start != cursor or end <= start or end > len(text):
            raise RuntimeError('Embedding checkpoint spans are not exact contiguous coverage')
        expected = passage_key + ':' + str(start) + ':' + str(end)
        if part.get('embedding_key') != expected or expected in seen:
            raise RuntimeError('Embedding checkpoint segment identity is invalid')
        seen.add(expected)
        cursor = end
    if cursor != len(text):
        raise RuntimeError('Embedding checkpoint does not cover the complete source variant')


def _encode_short(texts, kind):
    if not texts:
        return []
    if len(texts) > 32:
        raise ValueError('Encoder batch size must not exceed 32 segments')
    torch, tokenizer, model = _runtime()
    prefix = embedding_spec()['prefixes'][kind]
    batch = _tokenize(tokenizer, [prefix + text for text in texts], padding=True,
                      truncation=False, return_tensors='pt')
    if batch['input_ids'].shape[1] > MAX_TOKENS:
        raise ValueError('Overlength input must be segmented before encoding')
    with torch.inference_mode():
        hidden = model(**batch).last_hidden_state
        mask = batch['attention_mask'].unsqueeze(-1).to(hidden.dtype)
        pooled = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
        normalized = torch.nn.functional.normalize(pooled, p=2, dim=1)
    vectors = normalized.tolist()
    if len(vectors) != len(texts) or any(not _valid_vector(vector) for vector in vectors):
        raise RuntimeError('Encoder returned an invalid vector count, dimension, or value')
    return vectors


def _encode_segment_batches(texts, parts, kind, batch_size):
    """Length-bucket segments across input texts and restore original order."""
    if type(batch_size) is not int or not 1 <= batch_size <= 32:
        raise ValueError('batch_size must be 1..32')
    if len(texts) != len(parts):
        raise RuntimeError('Encoder input and segmentation counts differ')
    if not texts:
        return []
    result = [[None] * len(spans) for spans in parts]
    ordered = sorted((part['token_count'], i, j)
                     for i, spans in enumerate(parts) for j, part in enumerate(spans))
    keys = [embedding_key(text, kind) for text in texts]
    for offset in range(0, len(ordered), batch_size):
        batch = ordered[offset:offset + batch_size]
        vectors = _encode_short([parts[i][j]['text'] for _, i, j in batch], kind)
        if len(vectors) != len(batch):
            raise RuntimeError('Encoder vector count differs from complete segment count')
        for (_, i, j), embedding in zip(batch, vectors):
            part = parts[i][j]
            result[i][j] = {'span': {'start': part['start'], 'end': part['end'],
                                     'unit': 'unicode_character'},
                            'embedding': embedding,
                            'embedding_key': keys[i] + ':' + str(part['start']) + ':' + str(part['end'])}
    if any(not segments or any(part is None for part in segments) for segments in result):
        raise RuntimeError('Encoder omitted one or more complete source spans')
    return result


def encode_texts(texts, kind='passage'):
    """Return one vector per bounded input; overlength inputs require explicit spans."""
    _validate_kind(kind)
    texts = list(texts)
    if not texts:
        return []
    parts = [segment_text(text, kind) for text in texts]
    if any(len(spans) != 1 for spans in parts):
        raise ValueError('Overlength block: use encode_segments to retain every span')
    return [segments[0]['embedding'] for segments in _encode_segment_batches(texts, parts, kind, 8)]


def encode_segments(texts, kind='passage', *, batch_size=8, max_segments=None):
    """Encode complete strings in bounded, cross-text length buckets."""
    _validate_kind(kind)
    if max_segments is not None and (type(max_segments) is not int or max_segments < 1):
        raise ValueError('max_segments must be a positive integer')
    texts = list(texts)
    parts = [segment_text(text, kind) for text in texts]
    if max_segments is not None and any(len(spans) > max_segments for spans in parts):
        raise ValueError('Input exceeds the configured segment limit')
    return _encode_segment_batches(texts, parts, kind, batch_size)


def cosine(left, right):
    if not left or len(left) != len(right) or not all(math.isfinite(value) for value in [*left, *right]):
        raise ValueError('Cosine requires equal finite nonempty vectors')
    norm = math.sqrt(sum(value * value for value in left) * sum(value * value for value in right))
    if norm == 0:
        raise ValueError('Cosine is undefined for zero vectors')
    return sum(a * b for a, b in zip(left, right)) / norm


_ORIGIN_ACCEPTANCE_SQL = (
    "c.privacy_state <> 'machine_screened' "
    "OR c.safe_locator->>'kind' IS DISTINCT FROM 'forum' "
    "OR origin.operator_privacy_accepted IS TRUE"
)

_SELECTED_BASE_SQL = f'''
WITH requested_release AS MATERIALIZED (
  SELECT %s::text AS release_id
),
origin_summaries AS MATERIALIZED (
  SELECT o.release_id,o.chunk_id,
         bool_and(o.operator_privacy_accepted) AS operator_privacy_accepted,
         bool_and(o.review_accepted) AS review_accepted
  FROM requested_release requested
  JOIN kb.read_release_chunk_origins o ON o.release_id=requested.release_id
  GROUP BY o.release_id,o.chunk_id
)
SELECT c.chunk_id,c.variant_id,c.source_id,c.source_version_id,c.evidence_source_group_id,
       c.text_sha256,c.retrieval_text,c.content_role
FROM requested_release requested
JOIN kb.release_members m ON m.release_id=requested.release_id
JOIN kb.read_projection c ON c.chunk_id=m.entity_id
JOIN kb.release_members vm ON vm.release_id=m.release_id AND vm.entity_id=c.variant_id
JOIN origin_summaries origin ON origin.release_id=m.release_id AND origin.chunk_id=c.chunk_id
WHERE origin.review_accepted IS TRUE
  AND EXISTS (
    SELECT 1 FROM kb.release_chunk_dependencies d
    WHERE d.release_id=m.release_id AND d.chunk_id=c.chunk_id
  )
  AND ({_ORIGIN_ACCEPTANCE_SQL})
  AND c.privacy_state IN ('reviewed_safe','machine_screened')
  AND c.content_role NOT IN ('source_catalog','process_record','generated_draft')
  AND c.retrieval_text IS NOT NULL AND btrim(c.retrieval_text) <> ''
'''

_SELECTED_WRITER_BASE_SQL = f'''
WITH requested_release AS MATERIALIZED (
  SELECT %s::text AS release_id
),
raw_origins AS MATERIALIZED (
  SELECT o.release_id,o.chunk_id,o.package_id
  FROM requested_release requested
  JOIN kb.releases r ON r.release_id=requested.release_id
    AND r.status IN ('candidate','accepted')
  JOIN kb.release_chunk_origins o ON o.release_id=r.release_id
),
active_packages AS MATERIALIZED (
  SELECT DISTINCT package_id FROM raw_origins
),
accepted_variants AS MATERIALIZED (
  SELECT DISTINCT p.package_id,accepted.variant_id
  FROM active_packages active
  JOIN kb.packages p ON p.package_id=active.package_id
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN p.review_receipt->>'status'='accepted'
           AND jsonb_typeof(p.review_receipt->'accepted_variant_ids')='array'
         THEN p.review_receipt->'accepted_variant_ids'
         ELSE '[]'::jsonb END
  ) AS accepted(variant_id)
),
eligible_origins AS MATERIALIZED (
  SELECT o.release_id,o.chunk_id,origin.operator_privacy_accepted,
         origin.chunk_id IS NOT NULL AS origin_visible,
         accepted.package_id IS NOT NULL AS origin_accepted
  FROM raw_origins o
  JOIN kb.chunks c ON c.chunk_id=o.chunk_id
  LEFT JOIN kb.chunk_origins origin
    ON origin.chunk_id=o.chunk_id AND origin.package_id=o.package_id
  LEFT JOIN accepted_variants accepted
    ON accepted.package_id=o.package_id AND accepted.variant_id=c.variant_id
),
origin_eligibility AS MATERIALIZED (
  SELECT release_id,chunk_id,
         bool_and(origin_accepted) AS all_origins_accepted
  FROM eligible_origins
  GROUP BY release_id,chunk_id
),
origin_summaries AS MATERIALIZED (
  SELECT o.release_id,o.chunk_id,
         bool_and(o.operator_privacy_accepted) AS operator_privacy_accepted,
         TRUE AS review_accepted,
         jsonb_agg(DISTINCT d.dependency_id) AS dependency_ids
  FROM eligible_origins o
  JOIN kb.release_chunk_dependencies d ON d.release_id=o.release_id AND d.chunk_id=o.chunk_id
  WHERE o.origin_visible IS TRUE AND o.origin_accepted IS TRUE
  GROUP BY o.release_id,o.chunk_id
),
-- Bind chunk and variant identities before membership joins: low CTE estimates
-- must not multiply every release member by every eligible origin.
eligible_chunks AS MATERIALIZED (
  SELECT origin.release_id,c.chunk_id,c.variant_id,c.source_id,c.source_version_id,
         c.evidence_source_group_id,c.text_sha256,c.retrieval_text,c.content_role
  FROM kb.chunks c
  JOIN origin_summaries origin ON origin.chunk_id=c.chunk_id
  JOIN origin_eligibility eligibility
    ON eligibility.release_id=origin.release_id AND eligibility.chunk_id=c.chunk_id
   AND eligibility.all_origins_accepted IS TRUE
  WHERE origin.dependency_ids IS NOT NULL AND origin.review_accepted IS TRUE
    AND ({_ORIGIN_ACCEPTANCE_SQL})
    AND c.privacy_state IN ('reviewed_safe','machine_screened')
    AND c.content_role NOT IN ('source_catalog','process_record','generated_draft')
    AND c.retrieval_text IS NOT NULL AND btrim(c.retrieval_text) <> ''
)
SELECT c.chunk_id,c.variant_id,c.source_id,c.source_version_id,c.evidence_source_group_id,
       c.text_sha256,c.retrieval_text,c.content_role
FROM eligible_chunks c
JOIN kb.release_members m ON m.release_id=c.release_id AND m.entity_id=c.chunk_id
JOIN kb.entities e ON e.id=c.variant_id
JOIN kb.release_members vm ON vm.release_id=c.release_id AND vm.entity_id=c.variant_id
WHERE TRUE
'''


def _selected_rows_sql(*, page=False, target_texts=False, writer=False):
    query = _SELECTED_WRITER_BASE_SQL if writer else _SELECTED_BASE_SQL
    if target_texts:
        query += ' AND c.text_sha256 IN (SELECT text_sha256 FROM targets)'
    if page:
        query += ' AND (%s::text IS NULL OR c.chunk_id > %s::text)'
    query += ' ORDER BY c.chunk_id'
    if page:
        query += ' LIMIT %s'
    return query


def _embedding_relations(*, writer=False):
    if writer:
        return 'kb.embedding_checkpoints', 'kb.embeddings'
    return 'kb.read_embedding_checkpoints', 'kb.read_embeddings'


def _checkpoint_complete_predicate(checkpoint='cp', *, writer=False):
    _, embeddings = _embedding_relations(writer=writer)
    safe_segments = (f"CASE WHEN jsonb_typeof({checkpoint}.segments)='array' "
                     f"THEN {checkpoint}.segments ELSE '[]'::jsonb END")
    count = f"CASE WHEN jsonb_typeof({checkpoint}.segments)='array' THEN jsonb_array_length({checkpoint}.segments) ELSE 0 END"
    return f'''jsonb_typeof({checkpoint}.segments)='array'
      AND {count}>0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset({safe_segments}) AS expected(embedding_key text,span jsonb)
        LEFT JOIN {embeddings} actual
          ON actual.chunk_id={checkpoint}.chunk_id AND actual.config_hash={checkpoint}.config_hash
         AND actual.embedding_key=expected.embedding_key AND actual.span=expected.span
        WHERE expected.embedding_key IS NULL OR expected.span IS NULL OR actual.embedding_key IS NULL
      )
      AND NOT EXISTS (
        SELECT expected.embedding_key FROM jsonb_to_recordset({safe_segments}) AS expected(embedding_key text,span jsonb)
        GROUP BY expected.embedding_key HAVING count(*)>1
      )
      AND (SELECT count(*) FROM {embeddings} actual
           WHERE actual.chunk_id={checkpoint}.chunk_id
             AND actual.config_hash={checkpoint}.config_hash)={count}'''


def _reader_index_counts(connection, release_id, config_hash):
    selected_rows = connection.execute(
        'SELECT chunk_id,text_sha256 FROM (' + _selected_rows_sql() + ') selected_rows',
        (release_id,)).fetchall()
    selected = {row['chunk_id']: row['text_sha256'] for row in selected_rows}
    checkpoints = connection.execute('''SELECT cp.chunk_id,cp.content_key,cp.text_sha256,cp.segments
        FROM kb.read_embedding_checkpoints cp
        JOIN kb.release_members m ON m.entity_id=cp.chunk_id
        WHERE m.release_id=%s AND cp.config_hash=%s''',
        (release_id, config_hash)).fetchall()
    matching = [cp for cp in checkpoints
                if cp['chunk_id'] in selected
                and cp['content_key'] == selected[cp['chunk_id']]
                and cp['text_sha256'] == selected[cp['chunk_id']]]
    if not matching:
        return {'selected': len(selected), 'checkpointed': 0}
    chunk_ids = list({cp['chunk_id'] for cp in matching})
    vectors = connection.execute('''SELECT e.chunk_id,e.embedding_key,e.span
        FROM kb.read_embeddings e
        JOIN kb.release_members m ON m.entity_id=e.chunk_id
        WHERE m.release_id=%s AND e.config_hash=%s AND e.chunk_id=ANY(%s::text[])''',
        (release_id, config_hash, chunk_ids)).fetchall()
    vectors_by_chunk = {}
    for vector_row in vectors:
        vectors_by_chunk.setdefault(vector_row['chunk_id'], []).append(
            (vector_row['embedding_key'], vector_row['span']))

    complete = 0
    for checkpoint in matching:
        segments = checkpoint['segments']
        if not isinstance(segments, list) or not segments:
            continue
        expected = []
        for segment in segments:
            if not isinstance(segment, dict):
                break
            key, span = segment.get('embedding_key'), segment.get('span')
            if key is None or span is None:
                break
            if not isinstance(key, str):
                key = json.dumps(key, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
            expected.append((key, span))
        else:
            if len({key for key, _ in expected}) != len(expected):
                continue
            actual = vectors_by_chunk.get(checkpoint['chunk_id'], [])
            if len(actual) == len(expected) and all(
                    any(key == actual_key and span == actual_span
                        for actual_key, actual_span in actual)
                    for key, span in expected):
                complete += 1
    return {'selected': len(selected), 'checkpointed': complete}



def _require_schema(connection):
    """Require admin-provisioned vector tables and pre-granted writer privileges."""
    relations = connection.execute("""SELECT to_regclass('kb.embeddings') AS embeddings,
        to_regclass('kb.embedding_checkpoints') AS embedding_checkpoints,
        to_regclass('kb.embedding_checkpoints_content_config_idx') AS checkpoint_index,
        to_regclass('kb.index_builds') AS index_builds""").fetchone()
    if not relations or any(relations[name] is None for name in
                            ('embeddings', 'embedding_checkpoints', 'checkpoint_index', 'index_builds')):
        raise RuntimeError('Vector schema is not provisioned; run the administrative catalogue migration')
    privileges = connection.execute("""SELECT has_schema_privilege(current_user,'kb','USAGE') AS schema_usage,
        has_table_privilege(current_user,'kb.embeddings','SELECT') AS embeddings_select,
        has_table_privilege(current_user,'kb.embeddings','INSERT') AS embeddings_insert,
        has_table_privilege(current_user,'kb.embeddings','DELETE') AS embeddings_delete,
        has_table_privilege(current_user,'kb.embedding_checkpoints','SELECT') AS checkpoints_select,
        has_table_privilege(current_user,'kb.embedding_checkpoints','INSERT') AS checkpoints_insert,
        has_table_privilege(current_user,'kb.embedding_checkpoints','UPDATE') AS checkpoints_update,
        has_table_privilege(current_user,'kb.embedding_checkpoints','DELETE') AS checkpoints_delete,
        has_table_privilege(current_user,'kb.index_builds','SELECT') AS index_builds_select,
        has_table_privilege(current_user,'kb.index_builds','INSERT') AS index_builds_insert,
        has_table_privilege(current_user,'kb.index_builds','UPDATE') AS index_builds_update""").fetchone()
    required = ('schema_usage', 'embeddings_select', 'embeddings_insert', 'embeddings_delete',
                'checkpoints_select', 'checkpoints_insert', 'checkpoints_update', 'checkpoints_delete',
                'index_builds_select', 'index_builds_insert', 'index_builds_update')
    if not privileges or any(privileges[name] is not True for name in required):
        raise PermissionError('Vector index role lacks required pre-granted table privileges')


def _typed_chunk_count(connection, release_id):
    return connection.execute('''SELECT count(*) AS typed FROM kb.read_projection c
        JOIN kb.release_members m ON m.entity_id=c.chunk_id WHERE m.release_id=%s''',
        (release_id,)).fetchone()['typed']


def _index_counts(connection, release_id, config_hash, *, writer=False):
    typed = _typed_chunk_count(connection, release_id)
    tables = connection.execute("SELECT to_regclass('kb.embeddings') AS embeddings, "
                                "to_regclass('kb.embedding_checkpoints') AS checkpoints").fetchone()
    if tables['embeddings'] is not None and tables['checkpoints'] is not None:
        if writer:
            checkpoint_table, _ = _embedding_relations(writer=True)
            predicate = _checkpoint_complete_predicate('cp', writer=True)
            counts = connection.execute(f'''WITH selected AS MATERIALIZED ({_selected_rows_sql(writer=True)}),
                complete AS MATERIALIZED (
                  SELECT cp.chunk_id FROM selected s
                  JOIN {checkpoint_table} cp ON cp.chunk_id=s.chunk_id
                    AND cp.config_hash=%s AND cp.content_key=s.text_sha256 AND cp.text_sha256=s.text_sha256
                  WHERE {predicate}
                )
                SELECT (SELECT count(*) FROM selected) AS selected,
                       (SELECT count(*) FROM complete) AS checkpointed''',
                (release_id, config_hash)).fetchone()
        else:
            counts = _reader_index_counts(connection, release_id, config_hash)
        selected = counts['selected']
        complete = counts['checkpointed']
    else:
        selected = connection.execute('SELECT count(*) AS selected FROM (' +
                                      _selected_rows_sql(writer=writer) + ') selected_rows',
                                      (release_id,)).fetchone()['selected']
        complete = 0
    return {'selected': selected, 'checkpointed_chunks': complete,
            'pending_chunks': selected - complete, 'excluded_typed_chunks': typed - selected,
            'embedding_tables_available': tables['embeddings'] is not None and tables['checkpoints'] is not None}


def index_state(release_id, *, conn=None):
    """Read-only index counts; never creates schema or loads the encoder."""
    from hardissoft_kb import catalog
    if conn is None:
        with catalog.connect(readonly=True) as owned:
            return index_state(release_id, conn=owned)
    info = catalog.release_info(release_id, conn=conn)
    closure = catalog.release_closure(release_id, conn=conn)
    build = conn.execute("SELECT config_hash,spec,status FROM kb.index_builds WHERE release_id=%s AND method='vector'",
                         (release_id,)).fetchone()
    config_hash = build['config_hash'] if build else None
    counts = _index_counts(conn, release_id, config_hash or embedding_spec()['config_hash'])
    spec = build['spec'] if build else {}
    if isinstance(spec, str):
        spec = json.loads(spec)
    return {'release_id': release_id, 'release_status': info.get('status'),
            'selected': counts['selected'], 'checkpointed_chunks': counts['checkpointed_chunks'],
            'pending_chunks': counts['pending_chunks'], 'excluded_typed_chunks': counts['excluded_typed_chunks'],
            'embedding_tables_available': counts['embedding_tables_available'],
            'config_hash': config_hash, 'current_config_hash': embedding_spec()['config_hash'],
            'closure_sha256': closure, 'index_closure_sha256': spec.get('closure_sha256'),
            'closure_compatible': bool(spec.get('closure_sha256') and spec.get('closure_sha256') == closure),
            'index_version': spec.get('index_version'), 'artifact': spec.get('artifact'),
            'status': build['status'] if build else 'missing'}


def _manifest_json(segments):
    return json.dumps([{'embedding_key': part['embedding_key'], 'span': part['span']}
                       for part in segments], sort_keys=True, separators=(',', ':'))

def _complete_chunk_ids(connection, rows, config_hash, *, writer=False):
    targets = [{'chunk_id': row['chunk_id'], 'text_sha256': row['text_sha256'],
                'content_key': row['text_sha256']} for row in rows]
    if not targets:
        return set()
    checkpoint_table, _ = _embedding_relations(writer=writer)
    predicate = _checkpoint_complete_predicate('cp', writer=writer)
    found = connection.execute(f'''WITH targets AS MATERIALIZED (
          SELECT * FROM jsonb_to_recordset(%s::jsonb) AS t(chunk_id text,text_sha256 text,content_key text)
        ) SELECT cp.chunk_id FROM targets t
        JOIN {checkpoint_table} cp ON cp.chunk_id=t.chunk_id AND cp.config_hash=%s
          AND cp.text_sha256=t.text_sha256 AND cp.content_key=t.content_key
        WHERE {predicate}''', (json.dumps(targets), config_hash)).fetchall()
    return {row['chunk_id'] if isinstance(row, dict) else row[0] for row in found}


def _cache_sources(connection, targets, config_hash, excluded_ids, release_id, *, writer=False):
    if not targets:
        return {}
    checkpoint_table, _ = _embedding_relations(writer=writer)
    predicate = _checkpoint_complete_predicate('cp', writer=writer)
    rows = connection.execute(f'''WITH targets AS MATERIALIZED (
          SELECT * FROM jsonb_to_recordset(%s::jsonb) AS t(content_key text,text_sha256 text)
        ), selected AS MATERIALIZED ({_selected_rows_sql(target_texts=True, writer=writer)})
        SELECT DISTINCT ON (t.content_key) cp.chunk_id,cp.content_key,cp.text_sha256,cp.segments
        FROM targets t JOIN selected donor ON donor.text_sha256=t.text_sha256
        JOIN {checkpoint_table} cp ON cp.chunk_id=donor.chunk_id AND cp.config_hash=%s
          AND cp.content_key=t.content_key AND cp.text_sha256=t.text_sha256
        WHERE NOT (cp.chunk_id=ANY(%s)) AND {predicate}
        ORDER BY t.content_key,cp.chunk_id''',
        (json.dumps(targets), release_id, config_hash, list(excluded_ids))).fetchall()
    return {row['content_key']: row for row in rows}


def _delete_target_checkpoints(connection, chunk_ids, config_hash):
    if chunk_ids:
        connection.execute('DELETE FROM kb.embedding_checkpoints WHERE chunk_id=ANY(%s) AND config_hash=%s',
                           (list(chunk_ids), config_hash))
        connection.execute('DELETE FROM kb.embeddings WHERE chunk_id=ANY(%s) AND config_hash=%s',
                           (list(chunk_ids), config_hash))


def _write_checkpoint(connection, chunk_id, content_key, text_sha256, segments, config_hash):
    connection.execute('''INSERT INTO kb.embedding_checkpoints(chunk_id,config_hash,content_key,text_sha256,segments)
        VALUES(%s,%s,%s,%s,%s::jsonb) ON CONFLICT(chunk_id,config_hash) DO UPDATE
        SET content_key=excluded.content_key,text_sha256=excluded.text_sha256,segments=excluded.segments''',
        (chunk_id, config_hash, content_key, text_sha256, _manifest_json(segments)))


def _copy_vectors(connection, target_ids, source_id, config_hash, *, writer=False):
    if not target_ids:
        return 0
    _, embeddings = _embedding_relations(writer=writer)
    cursor = connection.execute(f'''WITH targets AS MATERIALIZED (
          SELECT jsonb_array_elements_text(%s::jsonb) AS chunk_id
        ) INSERT INTO kb.embeddings(chunk_id,embedding_key,config_hash,span,embedding)
        SELECT targets.chunk_id,source.embedding_key,source.config_hash,source.span,source.embedding
        FROM targets CROSS JOIN {embeddings} source
        WHERE source.chunk_id=%s AND source.config_hash=%s''',
        (json.dumps(target_ids), source_id, config_hash))
    return cursor.rowcount


def _protected_release_preflight(connection, release_id, protected_release_id, config_hash, *, writer=False):
    """Require a complete, same-config accepted donor before successor indexing."""
    if protected_release_id is None:
        return None
    if not isinstance(protected_release_id, str) or not protected_release_id:
        raise ValueError('protected_release_id must be a nonempty release identifier')
    if protected_release_id == release_id:
        raise ValueError('Protected vector release must differ from the candidate release')
    protected_release = connection.execute(
        'SELECT status FROM kb.releases WHERE release_id=%s',
        (protected_release_id,)).fetchone()
    if not protected_release or protected_release['status'] != 'accepted':
        raise RuntimeError('Protected vector release must be accepted')
    protected_build = connection.execute(
        "SELECT config_hash FROM kb.index_builds WHERE release_id=%s AND method='vector'",
        (protected_release_id,)).fetchone()
    if not protected_build or protected_build['config_hash'] != config_hash:
        raise RuntimeError('Protected vector release has a missing or different embedding configuration')

    selected_sql = _selected_rows_sql(writer=writer)
    # Set difference avoids a quadratic nested loop when both CTEs are
    # underestimated. Missing identities also count as changed hash pairs.
    coverage = connection.execute(f'''WITH protected AS MATERIALIZED ({selected_sql}),
        successor AS MATERIALIZED ({selected_sql})
        SELECT (SELECT count(*) FROM protected) AS selected,
               (SELECT count(*) FROM (
                  SELECT chunk_id FROM protected EXCEPT SELECT chunk_id FROM successor
                ) missing) AS missing_chunks,
               (SELECT count(*) FROM (
                  SELECT chunk_id,text_sha256 FROM protected
                  EXCEPT SELECT chunk_id,text_sha256 FROM successor
                ) changed) AS changed_text_hashes''',
        (protected_release_id, release_id)).fetchone()
    if coverage['selected'] == 0:
        raise RuntimeError('Protected vector release has no selected chunks')
    if coverage['missing_chunks'] or coverage['changed_text_hashes']:
        raise RuntimeError('Successor does not preserve all protected source chunk identities')
    protected_rows = connection.execute(
        f'SELECT selected_rows.chunk_id,selected_rows.text_sha256 FROM ({selected_sql}) selected_rows',
        (protected_release_id,)).fetchall()
    protected_chunk_ids = frozenset(row['chunk_id'] for row in protected_rows)
    protected_text_hashes = frozenset(row['text_sha256'] for row in protected_rows)
    if len(protected_chunk_ids) != coverage['selected']:
        raise RuntimeError('Protected source chunk selection is not unique')
    counts = _index_counts(connection, protected_release_id, config_hash, writer=writer)
    if (not counts['embedding_tables_available']
            or counts['selected'] != coverage['selected']
            or counts['checkpointed_chunks'] != coverage['selected']
            or counts['pending_chunks'] != 0):
        raise RuntimeError(
            'Protected source release has missing or incomplete vector checkpoints; refusing build')
    return {'release_id': protected_release_id, 'selected': counts['selected'],
            'checkpointed_chunks': counts['checkpointed_chunks'],
            'config_hash': config_hash, 'chunk_ids': protected_chunk_ids,
            'text_hashes': protected_text_hashes}


def _write_vectors(connection, chunk_id, segments, config_hash):
    with connection.cursor() as cursor:
        cursor.executemany('''INSERT INTO kb.embeddings(chunk_id,embedding_key,config_hash,span,embedding)
            VALUES(%s,%s,%s,%s::jsonb,%s)''',
            [(chunk_id, part['embedding_key'], config_hash,
              json.dumps(part['span'], sort_keys=True, separators=(',', ':')), part['embedding'])
             for part in segments])


def _process_pending_batch(connection, pending, config_hash, batch_size, release_id, *, writer=False,
                           protected_chunk_ids=(), protected_text_hashes=()):
    if any(row['chunk_id'] in protected_chunk_ids for row in pending):
        raise RuntimeError(
            'Protected source checkpoint is incomplete; refusing to encode protected chunk')
    grouped = {}
    for row in pending:
        grouped.setdefault(row['text_sha256'], []).append(row)
    groups = list(grouped.items())
    descriptors = [{'content_key': key, 'text_sha256': key} for key, _ in groups]
    target_ids = [row['chunk_id'] for row in pending]
    _delete_target_checkpoints(connection, target_ids, config_hash)
    sources = _cache_sources(connection, descriptors, config_hash, target_ids, release_id, writer=writer)
    texts = {key: rows[0]['retrieval_text'] for key, rows in groups}
    manifests, cache_groups, encode_keys = {}, {}, []
    for content_key, rows in groups:
        source = sources.get(content_key)
        if source is None:
            encode_keys.append(content_key)
            continue
        segments = source['segments']
        if isinstance(segments, str):
            segments = json.loads(segments)
        _validate_segment_manifest(texts[content_key], segments,
                                   embedding_key(texts[content_key], 'passage'))
        manifests[content_key] = segments
        cache_groups[content_key] = source
    if any(key in protected_text_hashes for key in encode_keys):
        raise RuntimeError(
            'Protected source cache is unavailable; refusing to encode protected content')
    if encode_keys:
        encoded = encode_segments([texts[key] for key in encode_keys], 'passage', batch_size=batch_size)
        if len(encoded) != len(encode_keys):
            raise RuntimeError('Encoder output count differs from unique pending content count')
        for key, segments in zip(encode_keys, encoded):
            _validate_segment_manifest(texts[key], segments, embedding_key(texts[key], 'passage'))
            manifests[key] = [{'embedding_key': part['embedding_key'], 'span': part['span'],
                               'embedding': part['embedding']} for part in segments]
    counts = {'encoded_chunks': 0, 'cache_copied_chunks': 0,
              'segments_written': 0, 'processed_chunks': len(pending)}
    for content_key, rows in groups:
        segments = manifests[content_key]
        if content_key in cache_groups:
            source = cache_groups[content_key]
            copied = _copy_vectors(connection, [row['chunk_id'] for row in rows],
                                   source['chunk_id'], config_hash, writer=writer)
            expected = len(segments) * len(rows)
            if copied != expected:
                raise RuntimeError('Complete cache checkpoint changed during vector copy')
            for row in rows:
                _write_checkpoint(connection, row['chunk_id'], content_key,
                                  row['text_sha256'], segments, config_hash)
            counts['cache_copied_chunks'] += len(rows)
            counts['segments_written'] += copied
            continue
        seed, *aliases = rows
        _write_vectors(connection, seed['chunk_id'], segments, config_hash)
        _write_checkpoint(connection, seed['chunk_id'], content_key,
                          seed['text_sha256'], segments, config_hash)
        counts['encoded_chunks'] += 1
        counts['segments_written'] += len(segments)
        if aliases:
            copied = _copy_vectors(connection, [row['chunk_id'] for row in aliases],
                                   seed['chunk_id'], config_hash, writer=writer)
            expected = len(segments) * len(aliases)
            if copied != expected:
                raise RuntimeError('Newly encoded alias vector copy was incomplete')
            for row in aliases:
                _write_checkpoint(connection, row['chunk_id'], content_key,
                                  row['text_sha256'], segments, config_hash)
            counts['cache_copied_chunks'] += len(aliases)
            counts['segments_written'] += copied
    return counts


def _server_rows(connection, sql, params, name):
    """Yield small batches from a server-side cursor; never materialize a full index."""
    with connection.cursor(name=name) as cursor:
        cursor.itersize = 64
        cursor.execute(sql, params)
        while True:
            batch = cursor.fetchmany(64)
            if not batch:
                break
            yield from batch


def _artifact_descriptor(connection, release_id, config_hash, closure_sha256, *,
                         writer=False, counts=None):
    if counts is None:
        counts = _index_counts(connection, release_id, config_hash, writer=writer)
    if not counts['embedding_tables_available'] or counts['selected'] == 0 or counts['pending_chunks'] != 0:
        raise RuntimeError('Vector artifact requires a nonempty, complete selected index')
    # Both server cursors consume the entire artifact, not a fractional preview.
    # Safe-view cardinality estimates otherwise select repeated nested-loop probes.
    connection.execute('SET LOCAL cursor_tuple_fraction=1.0')
    connection.execute('SET LOCAL enable_nestloop=off')
    connection.execute('SET LOCAL max_parallel_workers_per_gather=0')
    checkpoint_table, embeddings_table = _embedding_relations(writer=writer)
    checkpoint_sql = f'''WITH selected AS MATERIALIZED ({_selected_rows_sql(writer=writer)})
        SELECT s.chunk_id,s.retrieval_text,s.text_sha256,cp.content_key,cp.segments
        FROM selected s JOIN {checkpoint_table} cp ON cp.chunk_id=s.chunk_id
          AND cp.config_hash=%s AND cp.content_key=s.text_sha256 AND cp.text_sha256=s.text_sha256
        ORDER BY s.chunk_id'''
    checkpoint_hash = hashlib.sha256()
    chunk_count = segment_count = 0
    for row in _server_rows(connection, checkpoint_sql, (release_id, config_hash), 'kb_vector_checkpoints'):
        text = row['retrieval_text']
        segments = row['segments']
        if isinstance(segments, str):
            segments = json.loads(segments)
        if _text_sha256(text) != row['text_sha256'] or row['content_key'] != row['text_sha256']:
            raise RuntimeError('Vector checkpoint source variant identity mismatch')
        _validate_segment_manifest(text, segments, embedding_key(text, 'passage'))
        payload = {'chunk_id': row['chunk_id'], 'text_sha256': row['text_sha256'],
                   'content_key': row['content_key'], 'segments': segments}
        checkpoint_hash.update(json.dumps(payload, sort_keys=True, separators=(',', ':'),
                                           ensure_ascii=False).encode('utf-8') + b'\n')
        chunk_count += 1
        segment_count += len(segments)
    if chunk_count != counts['selected']:
        raise RuntimeError('Vector artifact checkpoint coverage differs from selected release chunks')
    vector_sql = f'''WITH selected AS MATERIALIZED (
          SELECT chunk_id,text_sha256 FROM ({_selected_rows_sql(writer=writer)}) selected_rows
        ), checkpoints AS MATERIALIZED (
          SELECT s.chunk_id,cp.config_hash,cp.segments FROM selected s
          JOIN {checkpoint_table} cp ON cp.chunk_id=s.chunk_id AND cp.config_hash=%s
            AND cp.content_key=s.text_sha256 AND cp.text_sha256=s.text_sha256
        )
        SELECT cp.chunk_id,cp.segments,e.embedding_key,e.config_hash,e.span,e.embedding
        FROM checkpoints cp
        JOIN {embeddings_table} e ON e.chunk_id=cp.chunk_id AND e.config_hash=cp.config_hash
        ORDER BY cp.chunk_id,e.embedding_key'''
    vectors_hash = hashlib.sha256()
    vector_count = 0
    current_chunk = None
    expected, seen = {}, set()
    vector_chunk_count = 0
    for row in _server_rows(connection, vector_sql, (release_id, config_hash), 'kb_vector_segments'):
        if row['chunk_id'] != current_chunk:
            if current_chunk is not None and seen != set(expected):
                raise RuntimeError('Vector artifact is missing checkpoint segments')
            current_chunk = row['chunk_id']
            segments = row['segments']
            if isinstance(segments, str):
                segments = json.loads(segments)
            if not isinstance(segments, list) or not segments:
                raise RuntimeError('Vector artifact checkpoint has no segments')
            expected = {}
            for part in segments:
                key = part.get('embedding_key') if isinstance(part, dict) else None
                if not isinstance(key, str) or key in expected or part.get('span') is None:
                    raise RuntimeError('Vector artifact checkpoint segment identity is invalid')
                expected[key] = part['span']
            seen = set()
            vector_chunk_count += 1
        key = row['embedding_key']
        if key not in expected or key in seen or expected[key] != row['span']:
            raise RuntimeError('Vector artifact segment differs from exact checkpoint manifest')
        seen.add(key)
        vector = row['embedding']
        if not _valid_vector(vector):
            raise RuntimeError('Vector artifact contains an invalid model vector')
        if not _valid_vector(vector, normalized=True):
            raise RuntimeError('Vector artifact contains a non-normalized model vector')
        payload = {'chunk_id': row['chunk_id'], 'embedding_key': row['embedding_key'],
                   'config_hash': row['config_hash'], 'span': row['span'], 'embedding': vector}
        vectors_hash.update(json.dumps(payload, sort_keys=True, separators=(',', ':'),
                                       ensure_ascii=False).encode('utf-8') + b'\n')
        vector_count += 1
    if current_chunk is not None and seen != set(expected):
        raise RuntimeError('Vector artifact is missing checkpoint segments')
    if vector_chunk_count != chunk_count or vector_count != segment_count:
        raise RuntimeError('Vector artifact segment count differs from exact checkpoint manifests')
    return {'schema': ARTIFACT_SCHEMA, 'closure_sha256': closure_sha256,
            'config_hash': config_hash, 'index_version': INDEX_VERSION,
            'chunk_count': chunk_count, 'segment_count': segment_count,
            'checkpoint_manifest_sha256': checkpoint_hash.hexdigest(),
            'embeddings_sha256': vectors_hash.hexdigest()}


def validate_artifact(release_id, *, conn=None, expected_config_hash=None,
                      expected_closure_sha256=None):
    """Read-only acceptance gate; checks sealed manifests and actual vectors without a model."""
    from hardissoft_kb import catalog
    if conn is None:
        with catalog.connect(readonly=True) as owned:
            return validate_artifact(release_id, conn=owned,
                                     expected_config_hash=expected_config_hash,
                                     expected_closure_sha256=expected_closure_sha256)
    build = conn.execute("SELECT config_hash,spec,status FROM kb.index_builds "
                         "WHERE release_id=%s AND method='vector'", (release_id,)).fetchone()
    if not build or build['status'] not in ('built', 'accepted'):
        raise RuntimeError('Vector artifact is not built and sealed')
    spec = build['spec'] if isinstance(build['spec'], dict) else json.loads(build['spec'])
    descriptor = spec.get('artifact')
    if not isinstance(descriptor, dict) or descriptor.get('schema') != ARTIFACT_SCHEMA:
        raise RuntimeError('Vector artifact descriptor is missing or incompatible')
    config_hash = build['config_hash']
    if spec.get('config_hash') != config_hash or descriptor.get('config_hash') != config_hash:
        raise RuntimeError('Vector artifact configuration identity mismatch')
    if expected_config_hash is not None and expected_config_hash != config_hash:
        raise RuntimeError('Vector artifact configuration differs from required release spec')
    closure = catalog.release_closure(release_id, conn=conn)
    if spec.get('closure_sha256') != closure or descriptor.get('closure_sha256') != closure:
        raise RuntimeError('Vector artifact release closure mismatch')
    if expected_closure_sha256 is not None and expected_closure_sha256 != closure:
        raise RuntimeError('Vector artifact differs from required release closure')
    if spec.get('index_version') != INDEX_VERSION or descriptor.get('index_version') != INDEX_VERSION:
        raise RuntimeError('Vector artifact index version mismatch')
    actual = _artifact_descriptor(conn, release_id, config_hash, closure)
    if actual != descriptor:
        raise RuntimeError('Vector artifact contents do not match its sealed descriptor')
    return actual


def build_index(release_id, *, batch_size=8, limit=None, progress=None,
                protected_release_id=None):
    """Incrementally build only a mutable candidate and seal its exact vector artifact."""
    from hardissoft_kb import catalog
    if type(batch_size) is not int or not 1 <= batch_size <= 32:
        raise ValueError('batch_size must be 1..32')
    if limit is not None and (type(limit) is not int or limit < 1):
        raise ValueError('limit must be a positive integer')
    config_hash = embedding_spec()['config_hash']
    processed = encoded_chunks = cache_copied_chunks = segments_written = 0
    with catalog.connect() as connection:
        lock_key = 'hardissoft-kb-vector-index:' + release_id
        connection.execute('SELECT pg_advisory_lock(hashtextextended(%s,0))', (lock_key,))
        release = connection.execute('SELECT status FROM kb.releases WHERE release_id=%s FOR UPDATE',
                                     (release_id,)).fetchone()
        if not release or release['status'] != 'candidate':
            raise ValueError('Vector indexing is allowed only for a mutable candidate release')
        closure = catalog.release_closure(release_id, conn=connection)
        _require_schema(connection)
        protected = _protected_release_preflight(
            connection, release_id, protected_release_id, config_hash, writer=True)
        protected_chunk_ids = protected['chunk_ids'] if protected is not None else ()
        protected_text_hashes = protected['text_hashes'] if protected is not None else ()
        spec = {**embedding_spec(), 'closure_sha256': closure, 'index_version': INDEX_VERSION}
        connection.execute('''INSERT INTO kb.index_builds(release_id,method,config_hash,spec,status)
            VALUES(%s,'vector',%s,%s::jsonb,'building')
            ON CONFLICT(release_id,method) DO UPDATE SET config_hash=excluded.config_hash,
              spec=excluded.spec,status='building',acceptance_ref=NULL''',
            (release_id, config_hash, json.dumps(spec, sort_keys=True)))
        connection.commit()
        initial = _index_counts(connection, release_id, config_hash, writer=True)
        cursor_chunk_id = None
        while limit is None or processed < limit:
            page = connection.execute(_selected_rows_sql(page=True, writer=True),
                                      (release_id, cursor_chunk_id, cursor_chunk_id, batch_size)).fetchall()
            if not page:
                break
            for row in page:
                if _text_sha256(row['retrieval_text']) != row['text_sha256']:
                    raise RuntimeError('Catalogue chunk text hash differs from its selected variant')
            cursor_chunk_id = page[-1]['chunk_id']
            complete = _complete_chunk_ids(connection, page, config_hash, writer=True)
            pending = [row for row in page if row['chunk_id'] not in complete]
            if limit is not None:
                pending = pending[:max(0, limit - processed)]
            if not pending:
                continue
            batch_counts = _process_pending_batch(
                connection, pending, config_hash, batch_size, release_id, writer=True,
                protected_chunk_ids=protected_chunk_ids,
                protected_text_hashes=protected_text_hashes)
            connection.commit()
            processed += batch_counts['processed_chunks']
            encoded_chunks += batch_counts['encoded_chunks']
            cache_copied_chunks += batch_counts['cache_copied_chunks']
            segments_written += batch_counts['segments_written']
            if progress:
                checkpointed = initial['checkpointed_chunks'] + processed
                progress({'release_id': release_id, 'selected': initial['selected'],
                          'processed_chunks': processed, 'encoded_chunks': encoded_chunks,
                          'cache_copied_chunks': cache_copied_chunks,
                          'segments_written': segments_written,
                          'checkpointed_chunks': checkpointed,
                          'pending_chunks': initial['selected'] - checkpointed,
                          'excluded_typed_chunks': initial['excluded_typed_chunks'],
                          'embedding_tables_available': initial['embedding_tables_available']})
        current = connection.execute('SELECT status FROM kb.releases WHERE release_id=%s FOR SHARE',
                                     (release_id,)).fetchone()
        current_closure = catalog.release_closure(release_id, conn=connection)
        if not current or current['status'] != 'candidate' or current_closure != closure:
            connection.execute("UPDATE kb.index_builds SET status='stale' WHERE release_id=%s AND method='vector'",
                               (release_id,))
            connection.commit()
            raise RuntimeError('Release closure changed during vector indexing; rebuild required')
        final_counts = _index_counts(connection, release_id, config_hash, writer=True)
        status = 'built' if final_counts['pending_chunks'] == 0 and final_counts['selected'] > 0 else 'partial'
        if status == 'built':
            spec['artifact'] = _artifact_descriptor(connection, release_id, config_hash, closure,
                                                    writer=True, counts=final_counts)
        connection.execute('''UPDATE kb.index_builds SET spec=%s::jsonb,status=%s,acceptance_ref=NULL
            WHERE release_id=%s AND method='vector' AND config_hash=%s''',
            (json.dumps(spec, sort_keys=True), status, release_id, config_hash))
        connection.commit()
    protected_summary = ({key: protected[key] for key in
                          ('release_id', 'selected', 'checkpointed_chunks', 'config_hash')}
                         if protected is not None else None)
    return {'release_id': release_id, 'selected': initial['selected'],
            'initial_checkpointed_chunks': initial['checkpointed_chunks'],
            'processed_chunks': processed, 'encoded_chunks': encoded_chunks,
            'cache_copied_chunks': cache_copied_chunks, 'reused_chunks': initial['checkpointed_chunks'],
            'segments_written': segments_written, **final_counts, 'status': status,
            'config_hash': config_hash, 'closure_sha256': closure,
            'artifact': spec.get('artifact'),
            'protected_release_preflight': protected_summary}


def _candidate_input(rows, requested_release_id):
    fields = ('sql', 'params', 'release_id', 'fetch_rows')
    present = [hasattr(rows, field) for field in fields]
    if not all(present):
        raise TypeError('Vector search requires an authorized Catalogue CandidateSet')
    if rows.release_id != requested_release_id:
        raise ValueError('CandidateSet release does not match requested release')
    if (not isinstance(rows.sql, str) or not rows.sql.strip()
            or not isinstance(rows.params, (tuple, list)) or not callable(rows.fetch_rows)):
        raise TypeError('CandidateSet must expose sql, params, release_id, and fetch_rows')
    return rows


def _row_value(row, name, index):
    if isinstance(row, dict):
        return row[name]
    return row[index]


def _search_sql(candidate_sql):
    if not isinstance(candidate_sql, str) or not candidate_sql.strip():
        raise TypeError('Vector search requires an authorized CandidateSet SQL relation')
    eligible = f'''eligible AS MATERIALIZED (
        SELECT candidate.chunk_id,candidate.text_sha256
        FROM (
{candidate_sql}
        ) AS candidate
        WHERE candidate.content_role NOT IN ('source_catalog','process_record','generated_draft')
          AND candidate.retrieval_text IS NOT NULL AND btrim(candidate.retrieval_text)<>''
      )'''
    return f'''WITH {eligible},
      params AS MATERIALIZED (
        SELECT %s::text AS release_id,%s::text AS config_hash,
               %s::jsonb AS query_segments,%s::integer AS top_k
      ),
      selected AS MATERIALIZED (
        SELECT DISTINCT ON (c.chunk_id) c.chunk_id,c.text_sha256
        FROM eligible c CROSS JOIN params p
        JOIN kb.release_members m ON m.release_id=p.release_id AND m.entity_id=c.chunk_id
        ORDER BY c.chunk_id
      ),
      -- Recheck each safe view once; aggregate manifest coverage instead of correlated per-chunk probes.
      complete AS MATERIALIZED (
        SELECT s.chunk_id,cp.config_hash,cp.segments,
               CASE WHEN jsonb_typeof(cp.segments)='array'
                    THEN jsonb_array_length(cp.segments) ELSE 0 END AS expected_segments
        FROM selected s CROSS JOIN params p
        JOIN kb.read_embedding_checkpoints cp ON cp.chunk_id=s.chunk_id
          AND cp.config_hash=p.config_hash AND cp.content_key=s.text_sha256
          AND cp.text_sha256=s.text_sha256
        WHERE CASE WHEN jsonb_typeof(cp.segments)='array'
                   THEN jsonb_array_length(cp.segments)>0 ELSE FALSE END
      ),
      manifest_segments AS MATERIALIZED (
        SELECT cp.chunk_id,cp.config_hash,cp.expected_segments,
               expected.embedding_key,expected.span,
               count(*) OVER (PARTITION BY cp.chunk_id,expected.embedding_key) AS key_occurrences
        FROM complete cp
        CROSS JOIN LATERAL jsonb_to_recordset(cp.segments)
          AS expected(embedding_key text,span jsonb)
      ),
      actual_vectors AS MATERIALIZED (
        SELECT e.chunk_id,e.config_hash,e.embedding_key,e.span,e.embedding,
               count(*) OVER (PARTITION BY e.chunk_id,e.config_hash) AS actual_segments
        FROM kb.read_embeddings e
        JOIN complete cp ON cp.chunk_id=e.chunk_id AND cp.config_hash=e.config_hash
      ),
      matched_segments AS MATERIALIZED (
        SELECT manifest.chunk_id,manifest.expected_segments,
               manifest.embedding_key,manifest.span,manifest.key_occurrences,
               actual.embedding_key AS matched_key,actual.actual_segments
        FROM manifest_segments manifest
        LEFT JOIN actual_vectors actual
          ON actual.chunk_id=manifest.chunk_id AND actual.config_hash=manifest.config_hash
         AND actual.embedding_key=manifest.embedding_key AND actual.span=manifest.span
      ),
      segment_counts AS MATERIALIZED (
        SELECT chunk_id,max(actual_segments) AS actual_segments,
               count(*) FILTER (WHERE matched_key IS NOT NULL) AS matched_segments,
               bool_and(embedding_key IS NOT NULL AND span IS NOT NULL
                        AND key_occurrences=1 AND matched_key IS NOT NULL) AS manifest_complete
        FROM matched_segments
        GROUP BY chunk_id
      ),
      coverage AS MATERIALIZED (
        SELECT (SELECT count(*) FROM selected) AS selected,
               (SELECT count(*) FROM complete cp
                JOIN segment_counts counts USING (chunk_id)
                WHERE cp.expected_segments=counts.actual_segments
                  AND cp.expected_segments=counts.matched_segments
                  AND counts.manifest_complete) AS ready
      ),
      query_parts AS MATERIALIZED (
        SELECT q.ordinality AS query_part,
               ARRAY(SELECT v.value::double precision
                     FROM jsonb_array_elements_text(q.segment->'embedding') WITH ORDINALITY AS v(value,ordinality)
                     ORDER BY v.ordinality) AS embedding
        FROM params p,
             jsonb_array_elements(p.query_segments) WITH ORDINALITY AS q(segment,ordinality)
      ),
      scored_segments AS MATERIALIZED (
        SELECT manifest.chunk_id,manifest.span,
               1.0-(e.embedding::real[]::vector <=> query.embedding::real[]::vector) AS score
        FROM manifest_segments manifest
        JOIN actual_vectors e
          ON e.chunk_id=manifest.chunk_id AND e.config_hash=manifest.config_hash
         AND e.embedding_key=manifest.embedding_key AND e.span=manifest.span
        CROSS JOIN query_parts query
        CROSS JOIN coverage
        WHERE coverage.selected=coverage.ready
          AND manifest.embedding_key IS NOT NULL
          AND manifest.span IS NOT NULL
          AND manifest.key_occurrences=1
      ),
      best AS MATERIALIZED (
        SELECT DISTINCT ON (chunk_id) chunk_id,score,span
        FROM scored_segments
        ORDER BY chunk_id,score DESC,span->>'start',span->>'end'
      ),
      limited AS MATERIALIZED (
        SELECT chunk_id,score,span FROM best ORDER BY score DESC,chunk_id
        LIMIT (SELECT top_k FROM params)
      ),
      hits AS (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('chunk_id',chunk_id,'score',score,
                            'vector_span',span) ORDER BY score DESC,chunk_id),'[]'::jsonb) AS value
        FROM limited
      )
      SELECT coverage.selected AS selected,
             coverage.ready AS ready,hits.value AS hits
      FROM coverage CROSS JOIN hits'''


def _canonical_query_text(query):
    if not isinstance(query, str) or not query.strip():
        raise ValueError('Search query must be nonempty text')
    canonical = query.strip()
    if len(canonical) > MAX_QUERY_CHARACTERS:
        raise ValueError('Search query exceeds the configured character bound')
    return canonical


def _prepared_query_payload(prepared_query, config_hash, query_sha256):
    if not isinstance(prepared_query, dict) or set(prepared_query) != {'config_hash', 'query_sha256', 'segments'}:
        raise ValueError('Prepared query must contain only config_hash, query_sha256, and segments')
    if prepared_query['query_sha256'] != query_sha256:
        raise ValueError('Prepared query does not match search query')
    if prepared_query['config_hash'] != config_hash:
        raise RuntimeError('Prepared query configuration mismatch; lexical-only degradation required')
    segments = prepared_query['segments']
    if not isinstance(segments, list) or not 1 <= len(segments) <= MAX_QUERY_SEGMENTS:
        raise ValueError('Prepared query segment count is outside the configured bound')
    for segment in segments:
        if not isinstance(segment, dict) or set(segment) != {'embedding'}:
            raise ValueError('Prepared query segments may contain only embeddings')
        embedding = segment['embedding']
        if (not isinstance(embedding, list) or len(embedding) != DIMENSIONS
                or any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in embedding)):
            raise ValueError('Prepared query embedding has invalid dimensions or values')
        norm = math.sqrt(math.fsum(value * value for value in embedding))
        if not math.isfinite(norm) or abs(norm - 1.0) > 1e-5:
            raise ValueError('Prepared query embeddings must be L2-normalized')
    return json.dumps(segments, separators=(',', ':'), allow_nan=False)


def prepare_query(query):
    """Encode a bounded canonical query before opening the policy transaction."""
    canonical = _canonical_query_text(query)
    config_hash = embedding_spec()['config_hash']
    segments = encode_segments([canonical], 'query', max_segments=MAX_QUERY_SEGMENTS)[0]
    return {'config_hash': config_hash, 'query_sha256': _text_sha256(canonical),
            'segments': [{'embedding': part['embedding']} for part in segments]}


def _execute_vector_query(connection, sql, parameters):
    """Execute the vector SQL with bounded transaction-local work memory."""
    previous_work_mem = connection.execute(
        "SELECT current_setting('work_mem') AS work_mem").fetchone()['work_mem']
    with connection.transaction():
        connection.execute("SET LOCAL work_mem TO '64MB'")
        result = connection.execute(sql, parameters).fetchone()
        connection.execute("SELECT pg_catalog.set_config('work_mem', %s, true)",
                           (previous_work_mem,)).fetchone()
    return result

def search(query, rows, release_id, top_k=50, *, expected_config_hash=None, prepared_query=None):
    """Exact cosine over a Catalogue CandidateSet; hydrate only bounded final hits."""
    if type(top_k) is not int or top_k < 1:
        raise ValueError('top_k must be positive')
    canonical_query = _canonical_query_text(query)
    candidates = _candidate_input(rows, release_id)
    if prepared_query is None:
        raise ValueError('CandidateSet search requires query vectors prepared before the policy transaction')
    from hardissoft_kb import catalog
    config = embedding_spec()['config_hash']
    if expected_config_hash is not None and expected_config_hash != config:
        raise RuntimeError('Release vector configuration mismatch; lexical-only degradation required')
    query_payload = _prepared_query_payload(prepared_query, config, _text_sha256(canonical_query))
    sql = _search_sql(candidates.sql)
    prefix_params = tuple(candidates.params)
    with catalog.connect(readonly=True) as connection:
        info = catalog.release_info(release_id, conn=connection)
        if info.get('status') not in (None, 'accepted', 'candidate'):
            raise RuntimeError('Release is not searchable; lexical-only degradation required')
        frozen = info.get('index_spec', {}).get('vector', {})
        frozen_config = frozen.get('config_hash')
        if not frozen_config or frozen_config != config or frozen.get('index_version') != INDEX_VERSION:
            raise RuntimeError('Release vector configuration mismatch; lexical-only degradation required')
        if expected_config_hash is not None and expected_config_hash != frozen_config:
            raise RuntimeError('Release vector configuration mismatch; lexical-only degradation required')
        if prepared_query['config_hash'] != frozen_config:
            raise RuntimeError('Prepared query configuration differs from frozen vector index')
        artifact = frozen.get('artifact')
        if not isinstance(artifact, dict) or artifact.get('schema') != ARTIFACT_SCHEMA:
            raise RuntimeError('Release vector artifact is not sealed; lexical-only degradation required')
        if artifact.get('config_hash') != frozen_config:
            raise RuntimeError('Release vector artifact configuration mismatch')
        closure = catalog.release_closure(release_id, conn=connection)
        if frozen.get('closure_sha256') != closure or artifact.get('closure_sha256') != closure or info.get('closure_sha256', closure) != closure:
            raise RuntimeError('Release vector closure mismatch; lexical-only degradation required')
        parameters = prefix_params + (release_id, config, query_payload, top_k)
        connection.execute('SET LOCAL max_parallel_workers_per_gather=0')
        connection.execute('SET LOCAL enable_nestloop=off')
        result = _execute_vector_query(connection, sql, parameters)
        selected, ready = _row_value(result, 'selected', 0), _row_value(result, 'ready', 1)
        if selected != ready:
            raise RuntimeError('Vector index incomplete/stale for exact authorized subset/config')
        hits = _row_value(result, 'hits', 2) or []
        if isinstance(hits, str):
            hits = json.loads(hits)
        if not hits:
            return []
        fetched = candidates.fetch_rows(connection, [hit['chunk_id'] for hit in hits])
        hydrated = {row['chunk_id']: row for row in fetched}
        return [{**hydrated[hit['chunk_id']], 'score': hit['score'],                 'vector_span': hit['vector_span']} for hit in hits if hit['chunk_id'] in hydrated]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('prepare')
    encode = sub.add_parser('encode')
    encode.add_argument('--kind', choices=['query', 'passage'], default='passage')
    status = sub.add_parser('status')
    status.add_argument('release_id')
    index = sub.add_parser('index')
    index.add_argument('release_id')
    index.add_argument('--batch-size', type=int, default=8)
    index.add_argument('--limit', type=int)
    args = parser.parse_args(argv)
    if args.command == 'prepare':
        print(json.dumps(prepare_model(), sort_keys=True))
    elif args.command == 'encode':
        for line in sys.stdin:
            text = json.loads(line)
            if not isinstance(text, str):
                raise ValueError('encode input is one JSON string per line')
            print(json.dumps({'config_hash': embedding_spec()['config_hash'],
                              'segments': encode_segments([text], args.kind)[0]}, sort_keys=True), flush=True)
    elif args.command == 'status':
        print(json.dumps(index_state(args.release_id), sort_keys=True))
    else:
        def progress(counts):
            print(json.dumps(counts, sort_keys=True), file=sys.stderr, flush=True)
        result = build_index(args.release_id, batch_size=args.batch_size,
                             limit=args.limit, progress=progress)
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()