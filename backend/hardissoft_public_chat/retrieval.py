"""Owner-approved, read-only retrieval over the pinned RAG release.

On 2026-10-31 the owner decided that this password-gated test chat may show the whole
machine-screened global corpus and send excerpts to MUSE Standard. This module is the only
place that applies that exception: it requires an exact Severus-side switch, keeps the KB's
current-policy denials, quarantine, and global scope, redacts contact patterns again, and
rolls back every database transaction, so the chat never changes KB policy or data.
"""
import concurrent.futures
import hashlib
import json
import os
import re
import threading
import time

from hardissoft_kb import catalog, privacy
from hardissoft_kb.search import hybrid
from . import fast_index
from hardissoft_kb.search.context import validate_context

OWNER_EXCEPTION = 'machine-screened-display-and-muse-2026-10-31'
TOP_K = 5
MAX_QUERIES = 2
MAX_ITEMS = 15
MAX_ITEM_BYTES = 2048
MAX_TOTAL_BYTES = 16 * 1024
_MIN_ITEM_BYTES = 256
_QUERY_CANCELED = '57014'
_RELEASE = re.compile(r'^release:[0-9a-f]{64}$')
_COLLECTION = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
_UNSAFE_LIMITATION = re.compile(r'https?://|/(?:srv|home|tmp|root|mnt)/', re.IGNORECASE)
# One search re-derives the authorized release subset: ~16-19 s elapsed alone on the pinned release,
# ~21-22 s with 8 running at once (measured 2026-11-01). More concurrent searches only stretch every
# turn past its deadline and exhaust Postgres (max_connections=30), so excess turns queue for a slot.
# A slot covers a whole turn (up to MAX_QUERIES searches) so no turn holds one search running while
# its other search waits.
MAX_CONCURRENT_RETRIEVALS = 4
# Measured loaded search time plus headroom; a turn admitted with less time would hit its statement
# timeout after loading the database, so it fails before searching instead.
MIN_SEARCH_SECONDS = 25
_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_RETRIEVALS)
# With a verified fast_index a search is sub-second DB work; these bound concurrent fast turns
# (two connections each) well under Postgres max_connections=30.
MAX_CONCURRENT_FAST_RETRIEVALS = 8
MIN_FAST_SEARCH_SECONDS = 5
_FAST_SLOTS = threading.BoundedSemaphore(MAX_CONCURRENT_FAST_RETRIEVALS)


class RetrievalUnavailable(RuntimeError):
    """The Severus configuration does not permit serving RAG evidence."""


class RetrievalBusy(TimeoutError):
    """No retrieval slot freed up in time for the searches to finish before the deadline."""


_local = threading.local()
_open_connection = catalog.connect


class _Borrowed:
    """Lends the caller-owned transaction to KB code; exiting never commits."""

    def __init__(self, connection):
        self._connection = connection

    def __enter__(self):
        return self._connection

    def __exit__(self, *exc):
        return False

    def __getattr__(self, name):
        return getattr(self._connection, name)


def _connect(*args, **kwargs):
    connection = getattr(_local, 'connection', None)
    if connection is None:
        return _open_connection(*args, **kwargs)
    return _Borrowed(connection)


# KB search opens connections through catalog.connect; route them into the per-thread rollback transaction.
catalog.connect = _connect


def context():
    if os.environ.get('HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION') != OWNER_EXCEPTION:
        raise RetrievalUnavailable('owner exception is not configured')
    release_id = os.environ.get('HIS_KB_PUBLIC_CHAT_RELEASE_ID', '')
    if not _RELEASE.fullmatch(release_id):
        raise RetrievalUnavailable('pinned release is not configured')
    collections = sorted({value.strip() for value in os.environ.get('HIS_KB_PUBLIC_CHAT_COLLECTIONS', '').split(',') if value.strip()})
    if not collections or any(not _COLLECTION.fullmatch(value) for value in collections):
        raise RetrievalUnavailable('collection allowlist is not configured')
    grant = {
        'principal_id': 'public-rag-chat',
        'scope': {'kind': 'global'},
        'allowed_collections': collections,
        'purpose': 'internal_retrieval',
        'allow_machine_screened': True,
        'owner_exception': OWNER_EXCEPTION,
    }
    grant['grant_fingerprint'] = hashlib.sha256(json.dumps(grant, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()
    return validate_context(dict(grant, operator=True, release_id=release_id))


def _run(connection, query, trusted_context, timeout_ms, mode):
    connection.execute('SET LOCAL statement_timeout = %d' % timeout_ms)
    # Parallel plans allocate dynamic shared memory per query; concurrent turns exhausted the
    # server-wide segment table ("too many dynamic shared memory segments"). Serial plans are
    # equally fast for these queries.
    connection.execute('SET LOCAL max_parallel_workers_per_gather = 0')
    try:
        if mode == 'hybrid' and fast_index.ready():
            try:
                return fast_index.search(connection, query, dict(trusted_context))
            except fast_index.Unavailable:
                pass  # no verified index for the current policy yet: identical slow path
        return hybrid.search({'query': query, 'top_k': TOP_K, 'operation': 'explain', 'mode': mode}, dict(trusted_context))['results']
    except RuntimeError:
        raise
    except Exception as exc:
        if getattr(exc, 'sqlstate', None) == _QUERY_CANCELED:
            raise TimeoutError('retrieval statement timeout') from None
        raise


def _search(query, trusted_context, timeout_ms):
    connection = _open_connection()
    _local.connection = connection
    try:
        try:
            return _run(connection, query, trusted_context, timeout_ms, 'hybrid')
        except RuntimeError:
            # Vector degradation is reported as RuntimeError; retry once lexically in a clean transaction.
            connection.rollback()
            return _run(connection, query, trusted_context, timeout_ms, 'lexical')
    finally:
        _local.connection = None
        try:
            connection.rollback()
        finally:
            connection.close()


def _clip(text, limit):
    encoded = text.encode('utf-8')
    if len(encoded) <= limit:
        return text
    return encoded[:limit - 3].decode('utf-8', 'ignore') + '…'


def _locator(value):
    if isinstance(value, dict) and value.get('kind') == 'pdf' and type(value.get('page_index')) is int and value['page_index'] >= 0:
        return {'kind': 'pdf', 'page_index': value['page_index']}
    return None


def _limitations(value):
    result = []
    for item in value if isinstance(value, (list, tuple)) else ():
        if isinstance(item, str) and item.strip() and len(item) <= 256 and not _UNSAFE_LIMITATION.search(item):
            result.append(item)
        if len(result) == 8:
            break
    return result


def _label(value, fallback):
    return value if isinstance(value, str) and value and len(value) <= 64 else fallback


def retrieve(queries, *, deadline):
    trusted_context = context()
    if not isinstance(queries, list) or not 1 <= len(queries) <= MAX_QUERIES \
            or any(not isinstance(query, str) or not query.strip() for query in queries):
        raise ValueError('one or two search queries required')
    fast = fast_index.ready()
    slots, min_seconds = (_FAST_SLOTS, MIN_FAST_SEARCH_SECONDS) if fast else (_SLOTS, MIN_SEARCH_SECONDS)
    if deadline - time.monotonic() < min_seconds:
        raise TimeoutError('retrieval deadline exhausted')
    if not slots.acquire(timeout=max(0.0, deadline - time.monotonic() - min_seconds)):
        raise RetrievalBusy('no retrieval slot before the deadline')
    try:
        timeout_ms = int((deadline - time.monotonic()) * 1000) - 1000
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(queries)) as pool:
            result_lists = list(pool.map(lambda query: _search(query, trusted_context, timeout_ms), queries))
    finally:
        slots.release()
    evidence, seen, total = [], set(), 0
    for rank in range(TOP_K):
        for results in result_lists:
            if rank >= len(results) or len(evidence) >= MAX_ITEMS:
                continue
            budget = min(MAX_ITEM_BYTES, MAX_TOTAL_BYTES - total)
            if budget < _MIN_ITEM_BYTES:
                return evidence
            row = results[rank]
            text = row.get('text') if isinstance(row, dict) else None
            if not isinstance(text, str) or not text.strip():
                continue
            text = privacy.redact(text)['text']
            digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            excerpt = _clip(text, budget)
            evidence.append({
                'ref': 'e%d' % (len(evidence) + 1),
                'text': excerpt,
                'safe_locator': _locator(row.get('safe_locator')),
                'modality': _label(row.get('modality'), 'unknown'),
                'language': _label(row.get('language'), 'und'),
                'limitations': _limitations(row.get('limitations')),
            })
            total += len(excerpt.encode('utf-8'))
    return evidence


def warm_up():
    """Load the pinned embedding runtime and start building the fast index in the background;
    searches use the slow path until the index is verified."""
    from hardissoft_kb.search import vector
    vector.prepare_query('warm up')
    fast_index._start_build(context())
