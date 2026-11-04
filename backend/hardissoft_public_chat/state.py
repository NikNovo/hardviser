"""Shared replay protection, per-user ask quotas, and at-most-once provider state."""
import hashlib
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

_REQUEST_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
_HEX_32 = re.compile(r'^[a-f0-9]{32}$')
_HEX_64 = re.compile(r'^[a-f0-9]{64}$')
ASK_PER_USER_PER_MINUTE = 5
ASK_PER_USER_PER_DAY = 50
ASK_GLOBAL_PER_DAY = 100


class QuotaExceeded(RuntimeError):
    pass


class ReplayDetected(RuntimeError):
    pass


class DuplicateRequest(RuntimeError):
    pass


class StageAlreadyAttempted(RuntimeError):
    pass


def _path():
    configured = os.environ.get('HIS_KB_PUBLIC_CHAT_STATE_DB')
    if configured:
        path = Path(configured)
        if not path.is_absolute():
            raise ValueError('public chat state path must be absolute')
        return path
    data_home = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    default_root = data_home / 'hardviser' / 'knowledge-base'
    root = Path(os.environ.get('HIS_KB_ROOT', str(default_root)))
    return root / 'runtime' / 'public-chat' / 'state.sqlite3'


def _connect():
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory_stat = path.parent.lstat()
    if not stat.S_ISDIR(directory_stat.st_mode) or directory_stat.st_uid != os.geteuid() or directory_stat.st_mode & 0o077:
        raise PermissionError('public chat state directory must be owner-only')
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
    except FileExistsError:
        fd = None
    if fd is not None:
        os.close(fd)
    file_stat = path.lstat()
    if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != os.geteuid() or file_stat.st_mode & 0o077:
        raise PermissionError('public chat state file must be owner-only')
    conn = sqlite3.connect(path, timeout=10, isolation_level=None)
    conn.execute('PRAGMA busy_timeout=10000')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=FULL')
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS public_chat_requests (
        request_id TEXT PRIMARY KEY,
        client_bucket TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_chat_requests_bucket_time
        ON public_chat_requests(client_bucket, created_at);
      CREATE INDEX IF NOT EXISTS public_chat_requests_time
        ON public_chat_requests(created_at);
      CREATE TABLE IF NOT EXISTS public_chat_user_asks (
        user_ref TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES public_chat_requests(request_id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_chat_user_asks_user_time
        ON public_chat_user_asks(user_ref, created_at);
      CREATE INDEX IF NOT EXISTS public_chat_user_asks_time
        ON public_chat_user_asks(created_at);
      CREATE TABLE IF NOT EXISTS public_chat_provider_attempts (
        request_id TEXT NOT NULL REFERENCES public_chat_requests(request_id) ON DELETE CASCADE,
        stage TEXT NOT NULL CHECK(stage IN ('plan','answer')),
        state TEXT NOT NULL CHECK(state IN ('pending','succeeded','failed','ambiguous')),
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        PRIMARY KEY(request_id, stage)
      );
    ''')
    return conn


def _validate_admission(request_id, nonce, now):
    if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
        raise ValueError('bounded request ID required')
    if not isinstance(nonce, str) or not _HEX_32.fullmatch(nonce):
        raise ValueError('nonce must be 128-bit lowercase hex')
    if isinstance(now, bool) or not isinstance(now, int) or now < 0:
        raise ValueError('request timestamp must be a nonnegative integer')


def _insert_request(conn, request_id, nonce, now):
    if conn.execute('SELECT 1 FROM public_chat_requests WHERE nonce_hash=?',
                    (hashlib.sha256(nonce.encode('ascii')).hexdigest(),)).fetchone():
        raise ReplayDetected('signed request nonce was already consumed')
    if conn.execute('SELECT 1 FROM public_chat_requests WHERE request_id=?', (request_id,)).fetchone():
        raise DuplicateRequest('request ID was already admitted')
    conn.execute(
        'INSERT INTO public_chat_requests(request_id,client_bucket,nonce_hash,created_at) VALUES(?,?,?,?)',
        (request_id, '', hashlib.sha256(nonce.encode('ascii')).hexdigest(), now),
    )


def _admit_transaction(operation):
    with _connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        try:
            operation(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def admit_signed_request(request_id, nonce, now=None):
    """Consume a signed bridge request ID and nonce without applying ask quotas."""
    if now is None:
        now = int(time.time())
    _validate_admission(request_id, nonce, now)
    _admit_transaction(lambda conn: _insert_request(conn, request_id, nonce, now))


def admit_ask(user_ref, request_id, nonce, now=None):
    """Atomically consume a signed ask and enforce per-user and global rate limits."""
    if now is None:
        now = int(time.time())
    _validate_admission(request_id, nonce, now)
    if not isinstance(user_ref, str) or not _HEX_64.fullmatch(user_ref):
        raise ValueError('user reference must be an HMAC hex digest')
    day_start = now - now % 86400

    def admit(conn):
        minute_count = conn.execute(
            'SELECT count(*) FROM public_chat_user_asks WHERE user_ref=? AND created_at>?',
            (user_ref, now - 60),
        ).fetchone()[0]
        day_count = conn.execute(
            'SELECT count(*) FROM public_chat_user_asks WHERE user_ref=? AND created_at>=?',
            (user_ref, day_start),
        ).fetchone()[0]
        global_day_count = conn.execute(
            'SELECT count(*) FROM public_chat_user_asks WHERE created_at>=?',
            (day_start,),
        ).fetchone()[0]
        if (minute_count >= ASK_PER_USER_PER_MINUTE
                or day_count >= ASK_PER_USER_PER_DAY
                or global_day_count >= ASK_GLOBAL_PER_DAY):
            raise QuotaExceeded('per-user ask quota exceeded')
        _insert_request(conn, request_id, nonce, now)
        conn.execute(
            'INSERT INTO public_chat_user_asks(user_ref,request_id,created_at) VALUES(?,?,?)',
            (user_ref, request_id, now),
        )

    _admit_transaction(admit)


def begin_provider_attempt(request_id, stage, now=None):
    """Durably claim (request, stage) before a paid submission; never permits retries."""
    if not isinstance(request_id, str) or not _REQUEST_ID.fullmatch(request_id):
        raise ValueError('bounded request ID required')
    if stage not in ('plan', 'answer'):
        raise ValueError('unsupported provider stage')
    if now is None:
        now = int(time.time())
    with _connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        try:
            if not conn.execute('SELECT 1 FROM public_chat_requests WHERE request_id=?', (request_id,)).fetchone():
                raise ValueError('request must be admitted before provider submission')
            try:
                conn.execute(
                    'INSERT INTO public_chat_provider_attempts(request_id,stage,state,started_at) VALUES(?,?,?,?)',
                    (request_id, stage, 'pending', now),
                )
            except sqlite3.IntegrityError:
                raise StageAlreadyAttempted('provider stage already submitted; do not resend') from None
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def finish_provider_attempt(request_id, stage, state, now=None):
    if stage not in ('plan', 'answer') or state not in ('succeeded', 'failed', 'ambiguous'):
        raise ValueError('invalid provider attempt state')
    if now is None:
        now = int(time.time())
    with _connect() as conn:
        updated = conn.execute(
            '''UPDATE public_chat_provider_attempts SET state=?,finished_at=?
               WHERE request_id=? AND stage=? AND state='pending' ''',
            (state, now, request_id, stage),
        ).rowcount
        if updated != 1:
            raise ValueError('provider attempt is not pending')
