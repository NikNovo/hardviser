"""One-time email links and durable issuance limits for public registration."""
import base64
import binascii
from datetime import timedelta
import hashlib
import re
import unicodedata
from urllib.parse import urlsplit
import secrets

from . import appstore

LINK_TTL = timedelta(minutes=15)
EMAIL_COOLDOWN_SECONDS = 60
EMAIL_REQUESTS_PER_HOUR = 5
CLIENT_REQUESTS_PER_HOUR = 20
GLOBAL_REQUESTS_PER_UTC_DAY = 100
_HISTORY_TTL = timedelta(hours=48)
_EMAIL_ATOM = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+"
_DOMAIN_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_EMAIL = re.compile(rf'^{_EMAIL_ATOM}(?:\.{_EMAIL_ATOM})*@{_DOMAIN_LABEL}(?:\.{_DOMAIN_LABEL})+$')
_BUCKET = re.compile(r'^[a-f0-9]{64}$')
_TOKEN = re.compile(r'^[A-Za-z0-9_-]{43}$')


def _email(value):
    if not isinstance(value, str):
        raise appstore.Invalid('email')
    normalized = value.strip().lower()
    local_part, separator, domain = normalized.rpartition('@')
    if (not separator or len(local_part) > 64 or len(domain) > 253 or len(normalized) > 254
            or not _EMAIL.fullmatch(normalized)):
        raise appstore.Invalid('email')
    return normalized


def _client_bucket(value):
    if not isinstance(value, str) or not _BUCKET.fullmatch(value):
        raise appstore.Invalid('client_bucket')
    return value


def _return_to(value):
    if (not isinstance(value, str) or not value.startswith('/') or value.startswith('//')
            or len(value) > 512 or '\\' in value or '#' in value
            or any(unicodedata.category(character) == 'Cc' for character in value)):
        raise appstore.Invalid('return_to')
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise appstore.Invalid('return_to') from None
    if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith('/'):
        raise appstore.Invalid('return_to')
    return value


def _token_hash(token):
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        raise appstore.Invalid('invalid_link')
    try:
        encoded = token.encode('ascii')
        decoded = base64.b64decode(encoded + b'=', altchars=b'-_', validate=True)
    except (UnicodeEncodeError, ValueError, binascii.Error):
        raise appstore.Invalid('invalid_link') from None
    if len(decoded) != 32 or base64.urlsafe_b64encode(decoded).rstrip(b'=') != encoded:
        raise appstore.Invalid('invalid_link')
    return hashlib.sha256(encoded).hexdigest()


def _lock(conn, scope):
    appstore._execute(conn, 'SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                      ('hardviser-email-auth:' + scope,))


def _invalid_link():
    raise appstore.Invalid('invalid_link')


def request_link(conn, email, client_bucket, return_to):
    """Issue the only currently valid link for an address and reserve send limits."""
    email = _email(email)
    client_bucket = _client_bucket(client_bucket)
    return_to = _return_to(return_to)

    # The global lock makes the daily counter atomic; keyed locks also document and
    # preserve the email/client counter scopes if global admission is ever changed.
    scopes = sorted(('global', 'email:' + email, 'client:' + client_bucket))
    for scope in scopes:
        _lock(conn, scope)

    appstore._execute(conn, '''DELETE FROM email_auth_links
        WHERE created_at < clock_timestamp()-%s::interval''',
        ('%s seconds' % int(_HISTORY_TTL.total_seconds()),))
    latest = appstore._execute(conn, '''SELECT created_at,clock_timestamp() AS checked_at
        FROM email_auth_links WHERE email=%s ORDER BY created_at DESC,id DESC LIMIT 1''',
        (email,)).fetchone()
    if latest is not None and latest['created_at'] > latest['checked_at'] - timedelta(seconds=EMAIL_COOLDOWN_SECONDS):
        raise appstore.QuotaExceeded('email_rate_limited')

    email_count = appstore._execute(conn, '''SELECT count(*) AS total FROM email_auth_links
        WHERE email=%s AND created_at >= clock_timestamp()-interval '1 hour' ''',
        (email,)).fetchone()['total']
    client_count = appstore._execute(conn, '''SELECT count(*) AS total FROM email_auth_links
        WHERE client_bucket=%s AND created_at >= clock_timestamp()-interval '1 hour' ''',
        (client_bucket,)).fetchone()['total']
    daily_count = appstore._execute(conn, '''SELECT count(*) AS total FROM email_auth_links
        WHERE created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' ''').fetchone()['total']
    if (email_count >= EMAIL_REQUESTS_PER_HOUR
            or client_count >= CLIENT_REQUESTS_PER_HOUR
            or daily_count >= GLOBAL_REQUESTS_PER_UTC_DAY):
        raise appstore.QuotaExceeded('email_rate_limited')

    # Keep invalidated and consumed history for rate accounting, but invalidate any
    # outstanding token before the new issuance becomes visible.
    appstore._execute(conn, '''UPDATE email_auth_links SET invalidated_at=clock_timestamp()
        WHERE email=%s AND invalidated_at IS NULL AND consumed_at IS NULL''', (email,))
    token = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode('ascii')
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    row = appstore._execute(conn, '''INSERT INTO email_auth_links
        (email,token_hash,client_bucket,return_to,created_at,expires_at)
        VALUES (%s,%s,%s,%s,clock_timestamp(),clock_timestamp()+%s::interval)
        RETURNING expires_at''',
        (email, token_hash, client_bucket, return_to,
         '%s seconds' % int(LINK_TTL.total_seconds()))).fetchone()
    return {'email': email, 'token': token, 'expires_at': row['expires_at'].isoformat(),
            'return_to': return_to}


def _valid_link(conn, token_hash, *, lock=False):
    query = '''SELECT l.id,l.email,l.return_to,l.expires_at,
                      EXISTS (SELECT 1 FROM users u WHERE u.email=l.email AND u.disabled_at IS NOT NULL) AS disabled
        FROM email_auth_links l
        WHERE l.token_hash=%s AND l.invalidated_at IS NULL AND l.consumed_at IS NULL
          AND l.expires_at>clock_timestamp()'''
    if lock:
        query += ' FOR UPDATE OF l'
    return appstore._execute(conn, query, (token_hash,)).fetchone()


def prepare_link(conn, token):
    """Read link details without consuming it or creating an account/session."""
    token_hash = _token_hash(token)
    row = _valid_link(conn, token_hash)
    if row is None or row['disabled']:
        _invalid_link()
    return {'email': row['email'], 'expires_at': row['expires_at'].isoformat(),
            'return_to': row['return_to']}


def consume_link(conn, token):
    """Atomically consume a current link, then create/reuse its user and session."""
    token_hash = _token_hash(token)
    candidate = appstore._execute(conn, 'SELECT email FROM email_auth_links WHERE token_hash=%s',
                                  (token_hash,)).fetchone()
    if candidate is None:
        _invalid_link()

    # Issuance takes the same email lock before invalidating older links. This
    # establishes whether consumption or a newer request happened first.
    _lock(conn, 'email:' + candidate['email'])
    row = _valid_link(conn, token_hash, lock=True)
    if row is None or row['disabled']:
        _invalid_link()

    user = appstore.get_or_create_email_user(conn, row['email'])
    if user is None:
        _invalid_link()
    changed = appstore._execute(conn, '''UPDATE email_auth_links SET consumed_at=clock_timestamp()
        WHERE id=%s AND invalidated_at IS NULL AND consumed_at IS NULL
        RETURNING id''', (row['id'],)).fetchone()
    if changed is None:
        _invalid_link()
    session_token, expires_at = appstore.create_session(conn, user['id'])
    identity = appstore.account_identity(conn, user['id'])
    return {**identity, 'token': session_token, 'expires_at': expires_at}
