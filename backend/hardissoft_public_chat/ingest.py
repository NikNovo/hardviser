"""Extract, chunk, and index uploaded project files without logging their contents."""
from contextlib import contextmanager
import logging
import math
import os
import signal
import stat
import threading
import time

from . import appstore, extractors

CHUNK_CHARACTERS = 1200
CHUNK_OVERLAP = 200
EXTRACTION_TIMEOUT_SECONDS = 120
logger = logging.getLogger('hardissoft_public_chat.ingest')


class _Empty(Exception):
    pass


def _alarm_handler(_signum, _frame):
    raise TimeoutError('file extraction timed out')


@contextmanager
def _extraction_timeout():
    if threading.current_thread() is not threading.main_thread():
        raise RuntimeError('file extraction must run on the worker main thread')
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_delay, previous_interval = signal.getitimer(signal.ITIMER_REAL)
    started = time.monotonic()
    signal.signal(signal.SIGALRM, _alarm_handler)
    signal.setitimer(signal.ITIMER_REAL, EXTRACTION_TIMEOUT_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_delay > 0:
            remaining = max(0, previous_delay - (time.monotonic() - started))
            if remaining > 0:
                signal.setitimer(signal.ITIMER_REAL, remaining, previous_interval)


def _extract(conn, path, row):
    kind, content_level = extractors.classify(row['name'])
    if kind != row['kind'] or content_level != row['content_level']:
        conn.execute('UPDATE files SET kind=%s,content_level=%s WHERE id=%s',
                     (kind, content_level, row['id']))
    if extractors.suffix(row['name']) == 'pdf':
        return extractors.extract_pages(row['name'], path, size_bytes=row['size_bytes'],
                                        sha256=row['sha256'].strip())
    with _extraction_timeout():
        return extractors.extract_pages(row['name'], path, size_bytes=row['size_bytes'],
                                        sha256=row['sha256'].strip())


def _chunks(text, page):
    start = 0
    while start < len(text):
        end = min(start + CHUNK_CHARACTERS, len(text))
        chunk = text[start:end]
        if chunk.strip():
            yield page, chunk
        if end == len(text):
            return
        start = end - CHUNK_OVERLAP


def _embed(texts):
    from hardissoft_kb.search import vector

    encoded = vector.encode_segments(texts, kind='passage', batch_size=8)
    embeddings = []
    for parts in encoded:
        mean = [sum(part['embedding'][i] for part in parts) / len(parts)
                for i in range(vector.DIMENSIONS)]
        norm = math.sqrt(sum(value * value for value in mean))
        if not math.isfinite(norm) or norm == 0:
            raise RuntimeError('embedding returned an invalid vector')
        embeddings.append([value / norm for value in mean])
    return embeddings


def _vector_literal(values):
    return '[' + ','.join(format(value, '.9g') for value in values) + ']'


def _insert_chunks(conn, file_id, pages):
    chunks = [(page, text) for page, page_text in pages for page, text in _chunks(page_text, page)]
    if not chunks:
        raise _Empty()
    index = 0
    for start in range(0, len(chunks), 8):
        batch = chunks[start:start + 8]
        embeddings = _embed([text for _, text in batch])
        records = []
        for (page, text), embedding in zip(batch, embeddings):
            records.append((file_id, index, page, text, _vector_literal(embedding)))
            index += 1
        with conn.cursor() as cursor:
            cursor.executemany('''INSERT INTO file_chunks(file_id,idx,page,text,embedding)
                VALUES (%s,%s,%s,%s,%s::vector)''', records)


def _source_path(row):
    sha256 = row['sha256'].strip()
    if len(sha256) != 64 or any(char not in '0123456789abcdef' for char in sha256):
        raise RuntimeError('source digest is invalid')
    path = appstore.file_path(sha256)
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size != row['size_bytes']):
        raise RuntimeError('source file is unavailable')
    return path


def _queue_blob_gc(conn, sha256):
    conn.execute('INSERT INTO blob_gc(sha256) VALUES (%s) ON CONFLICT DO NOTHING', (sha256,))


def _mark_failed(conn, row, error):
    conn.execute('DELETE FROM file_chunks WHERE file_id=%s', (row['id'],))
    conn.execute("UPDATE files SET status='failed',error=%s WHERE id=%s", (error, row['id']))
    _queue_blob_gc(conn, row['sha256'].strip())


def _process_file(conn, row):
    path = _source_path(row)
    pages = _extract(conn, path, row)
    if not any(text.strip() for _, text in pages):
        _mark_failed(conn, row, 'empty')
        return False
    _insert_chunks(conn, row['id'], pages)
    conn.execute("UPDATE files SET status='ready',error=NULL WHERE id=%s", (row['id'],))
    return True


def _claim(conn):
    return appstore._execute(conn, '''SELECT f.id,f.name,f.sha256,f.mime,f.size_bytes,f.kind,f.content_level
        FROM files f JOIN projects p ON p.id=f.project_id
        WHERE f.status='pending' AND f.deleted_at IS NULL
        ORDER BY f.created_at,f.id
        LIMIT 1 FOR UPDATE OF f SKIP LOCKED''').fetchone()


def process_pending(conn, limit=10):
    """Process up to ``limit`` claimed files inside the caller's transaction."""
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('limit must be between 1 and 100')
    processed = 0
    for _ in range(limit):
        row = _claim(conn)
        if row is None:
            break
        processed += 1
        try:
            with conn.transaction():
                _process_file(conn, row)
        except _Empty:
            with conn.transaction():
                _mark_failed(conn, row, 'empty')
        except Exception as exc:
            with conn.transaction():
                _mark_failed(conn, row, 'extract_failed')
            logger.warning('file ingestion failed: %s', type(exc).__name__)
    return processed


def _expire_upload_sessions(conn, limit=100):
    rows = appstore._execute(conn, '''SELECT id FROM upload_sessions WHERE expires_at<=now()
        ORDER BY expires_at LIMIT %s FOR UPDATE SKIP LOCKED''', (limit,)).fetchall()
    if rows:
        conn.execute('DELETE FROM upload_sessions WHERE id=ANY(%s::uuid[])',
                     ([row['id'] for row in rows],))
    return [row['id'] for row in rows]


def _safe_unlink(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        return
    path.unlink()
    try:
        path.parent.rmdir()
    except OSError:
        pass


def _cleanup_expired_files(upload_ids):
    for upload_id in upload_ids:
        _safe_unlink(appstore._upload_path(upload_id))


def _cleanup_orphan_upload_files(conn):
    root = appstore._data_root() / 'uploads'
    try:
        info = root.lstat()
    except FileNotFoundError:
        return
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        return
    live_ids = {str(row['id']) for row in appstore._execute(
        conn, 'SELECT id FROM upload_sessions WHERE expires_at>now()').fetchall()}
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for path in entries:
        if path.name not in live_ids:
            _safe_unlink(path)


def _process_blob_gc(conn, limit=100):
    rows = appstore._execute(conn, 'SELECT sha256 FROM blob_gc ORDER BY queued_at LIMIT %s',
                             (limit,)).fetchall()
    for row in rows:
        sha256 = row['sha256'].strip()
        conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (sha256,))
        referenced = appstore._execute(conn, '''SELECT 1 FROM files
            WHERE sha256=%s AND deleted_at IS NULL AND status<>'failed' LIMIT 1''',
            (sha256,)).fetchone()
        if referenced is None:
            _safe_unlink(appstore.file_path(sha256))
        conn.execute('DELETE FROM blob_gc WHERE sha256=%s', (sha256,))


def _run_once():
    conn = appstore.connect()
    try:
        expired = _expire_upload_sessions(conn)
        processed = process_pending(conn)
        _process_blob_gc(conn)
        conn.commit()
        _cleanup_expired_files(expired)
        _cleanup_orphan_upload_files(conn)
        return processed
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main():
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    while True:
        try:
            _run_once()
        except Exception as exc:
            logger.warning('ingestion cycle failed: %s', type(exc).__name__)
        time.sleep(5)


if __name__ == '__main__':
    main()
