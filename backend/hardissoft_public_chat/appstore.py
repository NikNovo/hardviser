"""Per-user PostgreSQL storage for projects, chats, files, and sessions."""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import unicodedata
import uuid

import psycopg
from psycopg.rows import dict_row

from . import extractors

CHUNK_BYTES = 2 * 1024 * 1024
MAX_FILE_BYTES = 100 * 1024 * 1024
MAX_NEW_FILE_BYTES = 10 * 1024 * 1024
MAX_PROJECT_FILES = 200
MAX_USER_STORAGE_BYTES = 5 * 1024 * 1024 * 1024
UPLOAD_TTL = timedelta(hours=1)
SESSION_TTL = timedelta(hours=12)
_BRIEF_FIELD_LABELS = (
    ('description', 'Description'),
    ('audience', 'Audience'),
    ('markets', 'Markets'),
    ('team', 'Team'),
    ('goal', 'Goal'),
)
_BRIEF_FIELDS = frozenset(('description', 'audience', 'markets', 'team', 'goal', 'notes'))
_LOGIN = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')
_SHA256 = re.compile(r'^[a-f0-9]{64}$')
_SCRYPT_N = 1 << 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_BYTES = 64
_DUMMY_SALT = b'\0' * 16
_DUMMY_HASH = hashlib.scrypt(b'invalid credentials', salt=_DUMMY_SALT, n=_SCRYPT_N,
                             r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_BYTES)


class NotFound(RuntimeError):
    """The requested resource is absent or belongs to a different user."""


class Invalid(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class Conflict(RuntimeError):
    """A compare-and-set update no longer matches the current record."""

class QuotaExceeded(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def connect():
    """Open a caller-managed transaction using the app_runtime DB role."""
    host = os.environ.get('HIS_APP_DB_HOST', '127.0.0.1')
    port = int(os.environ.get('HIS_APP_DB_PORT', '5432'))
    dbname = os.environ.get('HIS_APP_DB_NAME', 'hardviser_app')
    user = os.environ.get('HIS_APP_DB_USER', 'app_runtime')
    return psycopg.connect(host=host, port=port, dbname=dbname, user=user,
                           autocommit=False, connect_timeout=10)


def _execute(conn, query, params=()):
    return conn.cursor(row_factory=dict_row).execute(query, params)


def _uuid(value, *, hidden=False, code='id'):
    try:
        if isinstance(value, bool):
            raise ValueError
        return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        if hidden:
            raise NotFound() from None
        raise Invalid(code) from None


def _id(value):
    return str(value) if value is not None else None


def _iso(value):
    return value.isoformat() if value is not None else None


def _valid_text(value, *, code, max_chars, max_bytes, allow_empty=False):
    if (not isinstance(value, str) or (not allow_empty and not value.strip())
            or len(value) > max_chars or '\x00' in value):
        raise Invalid(code)
    try:
        if len(value.encode('utf-8')) > max_bytes:
            raise Invalid(code)
    except UnicodeEncodeError:
        raise Invalid(code) from None
    return value


def _login(value):
    if not isinstance(value, str):
        raise Invalid('login')
    value = value.strip().lower()
    if not _LOGIN.fullmatch(value):
        raise Invalid('login')
    return value


def _display_name(value):
    if value is None:
        return None
    if (not isinstance(value, str) or not 1 <= len(value) <= 80
            or value != value.strip()
            or any(unicodedata.category(character) == 'Cc' for character in value)):
        raise Invalid('display_name')
    try:
        value.encode('utf-8')
    except UnicodeEncodeError:
        raise Invalid('display_name') from None
    return value


def _password(value):
    if not isinstance(value, str) or not value:
        raise Invalid('password')
    try:
        encoded = value.encode('utf-8')
    except UnicodeEncodeError:
        raise Invalid('password') from None
    if len(encoded) > 4096:
        raise Invalid('password')
    return encoded


def _password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password, salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                            p=_SCRYPT_P, dklen=_SCRYPT_BYTES)
    return 'scrypt$%d$%d$%d$%s$%s' % (
        _SCRYPT_N, _SCRYPT_R, _SCRYPT_P, salt.hex(), digest.hex())


def _verify_password(password, encoded):
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split('$')
        if (algorithm != 'scrypt' or int(n) != _SCRYPT_N or int(r) != _SCRYPT_R
                or int(p) != _SCRYPT_P or len(salt_hex) != 32
                or len(digest_hex) != _SCRYPT_BYTES * 2):
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.scrypt(password, salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                                p=_SCRYPT_P, dklen=_SCRYPT_BYTES)
        return hmac.compare_digest(actual, expected)
    except (AttributeError, TypeError, ValueError, OverflowError):
        return False


def create_user(conn, login, password):
    login = _login(login)
    encoded = _password(password)
    row = _execute(conn, '''INSERT INTO users(login,password_hash)
        VALUES (%s,%s) ON CONFLICT (login) DO NOTHING RETURNING id,login''',
        (login, _password_hash(encoded))).fetchone()
    if row is None:
        raise Invalid('login_exists')
    return {'id': _id(row['id']), 'login': row['login']}

def get_or_create_email_user(conn, email):
    """Reuse an enabled verified-email identity or create an inaccessible-password user."""
    if not isinstance(email, str) or email != email.lower() or not 3 <= len(email) <= 254:
        raise Invalid('email')

    def existing_user():
        return _execute(conn, '''SELECT id,email,disabled_at FROM users
            WHERE email=%s FOR UPDATE''', (email,)).fetchone()

    row = existing_user()
    if row is not None:
        if row['disabled_at'] is not None:
            return None
        return {'id': _id(row['id']), 'login': row['email']}

    for _ in range(8):
        generated_login = 'email-' + secrets.token_hex(16)
        row = _execute(conn, '''INSERT INTO users(login,password_hash,email)
            VALUES (%s,%s,%s) ON CONFLICT DO NOTHING
            RETURNING id,email''',
            (generated_login, _password_hash(secrets.token_bytes(32)), email)).fetchone()
        if row is not None:
            return {'id': _id(row['id']), 'login': row['email']}
        row = existing_user()
        if row is not None:
            if row['disabled_at'] is not None:
                return None
            return {'id': _id(row['id']), 'login': row['email']}
    raise RuntimeError('could not allocate an email account identity')




def set_password(conn, user_id, password):
    user_id = _uuid(user_id, hidden=True)
    encoded = _password(password)
    row = _execute(conn, 'UPDATE users SET password_hash=%s WHERE id=%s RETURNING id',
                   (_password_hash(encoded), user_id)).fetchone()
    if row is None:
        raise NotFound()
    _execute(conn, '''UPDATE sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE user_id=%s''', (user_id,))




def list_users(conn):
    rows = _execute(conn, '''SELECT id,login,created_at,disabled_at FROM users
        ORDER BY login''').fetchall()
    return [{'id': _id(row['id']), 'login': row['login'],
             'created_at': _iso(row['created_at']), 'disabled_at': _iso(row['disabled_at'])}
            for row in rows]


def account_identity(conn, user_id):
    user_id = _uuid(user_id, hidden=True)
    row = _execute(conn, '''SELECT u.id,COALESCE(u.email,u.login) AS login,u.display_name,
        ARRAY(SELECT r.role FROM user_roles r
              WHERE r.user_id=u.id ORDER BY r.role) AS roles
        FROM users u
        WHERE u.id=%s AND u.disabled_at IS NULL''', (user_id,)).fetchone()
    if row is None:
        raise NotFound()
    return {'id': _id(row['id']), 'login': row['login'],
            'display_name': row['display_name'], 'roles': row['roles']}


def update_account_profile(conn, user_id, display_name):
    user_id = _uuid(user_id, hidden=True)
    display_name = _display_name(display_name)
    row = _execute(conn, '''UPDATE users SET display_name=%s
        WHERE id=%s AND disabled_at IS NULL RETURNING id''',
        (display_name, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return account_identity(conn, row['id'])


def authenticate(conn, login, password):
    try:
        login = _login(login)
        encoded = _password(password)
    except Invalid:
        return None
    row = _execute(conn, '''SELECT id,login,email,password_hash,disabled_at FROM users
        WHERE login=%s''', (login,)).fetchone()
    if row is None:
        actual = hashlib.scrypt(encoded, salt=_DUMMY_SALT, n=_SCRYPT_N,
                                r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_BYTES)
        hmac.compare_digest(actual, _DUMMY_HASH)
        return None
    valid = _verify_password(encoded, row['password_hash'])
    if not valid or row['disabled_at'] is not None:
        return None
    return {'id': _id(row['id']), 'login': row['email'] or row['login']}


def create_session(conn, user_id):
    user_id = _uuid(user_id, hidden=True)
    user = _execute(conn, '''SELECT id FROM users
        WHERE id=%s AND disabled_at IS NULL FOR SHARE''', (user_id,)).fetchone()
    if user is None:
        raise NotFound()
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + SESSION_TTL
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    _execute(conn, '''INSERT INTO sessions(token_hash,user_id,expires_at)
        VALUES (%s,%s,%s)''', (token_hash, user_id, expires_at))
    return token, expires_at.isoformat()


def resolve_session(conn, token):
    if not isinstance(token, str) or not token or len(token) > 256:
        return None
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    row = _execute(conn, '''SELECT u.id,COALESCE(u.email,u.login) AS login,u.display_name,
        ARRAY(SELECT r.role FROM user_roles r
              WHERE r.user_id=u.id ORDER BY r.role) AS roles
        FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=%s AND s.revoked_at IS NULL AND s.expires_at>statement_timestamp()
          AND u.disabled_at IS NULL''', (token_hash,)).fetchone()
    return {'id': _id(row['id']), 'login': row['login'],
            'display_name': row['display_name'], 'roles': row['roles']} if row else None


def revoke_session(conn, token):
    if not isinstance(token, str) or not token or len(token) > 256:
        return
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    _execute(conn, '''UPDATE sessions SET revoked_at=COALESCE(revoked_at,now())
        WHERE token_hash=%s''', (token_hash,))


def _owned_project(conn, user_id, project_id, *, lock=False):
    user_id = _uuid(user_id, hidden=True)
    project_id = _uuid(project_id, hidden=True)
    sql = 'SELECT id FROM projects WHERE id=%s AND owner_id=%s'
    if lock:
        sql += ' FOR UPDATE'
    row = _execute(conn, sql, (project_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return project_id

def _owned_assistant_message(conn, user_id, project_id, message_id):
    message_id = _uuid(message_id, hidden=True)
    row = _execute(conn, '''SELECT m.id,c.id AS chat_id FROM messages m
        JOIN chats c ON c.id=m.chat_id
        JOIN projects p ON p.id=c.project_id
        WHERE m.id=%s AND m.role='assistant' AND c.project_id=%s AND p.owner_id=%s''',
        (message_id, project_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return row['id'], row['chat_id']


def _blank_brief_fields(notes=''):
    return {field: notes if field == 'notes' else '' for field in _BRIEF_FIELDS}


def _render_brief(fields):
    sections = [f'{label}: {fields[field]}' for field, label in _BRIEF_FIELD_LABELS if fields[field]]
    if fields['notes']:
        sections.append(fields['notes'])
    rendered = '\n'.join(sections)
    return _valid_text(rendered, code='brief', max_chars=8192, max_bytes=8192, allow_empty=True)

def _project_result(row):
    return {'id': _id(row['id']), 'name': row['name'], 'brief_fields': row['brief_fields'],
            'brief_text': row['brief_text'], 'updated_at': _iso(row['updated_at'])}


def list_projects(conn, user_id):
    user_id = _uuid(user_id, hidden=True)
    rows = _execute(conn, '''SELECT id,name,brief->>'text' AS brief_text,brief_fields,updated_at
        FROM projects WHERE owner_id=%s ORDER BY updated_at DESC,id''',
        (user_id,)).fetchall()
    return [_project_result(row) for row in rows]


def get_project(conn, user_id, project_id):
    project_id = _owned_project(conn, user_id, project_id)
    row = _execute(conn, '''SELECT id,name,brief->>'text' AS brief_text,brief_fields,updated_at
        FROM projects WHERE id=%s''', (project_id,)).fetchone()
    return _project_result(row)


def create_project(conn, user_id, name, brief_text=''):
    user_id = _uuid(user_id, hidden=True)
    user = _execute(conn, 'SELECT id FROM users WHERE id=%s AND disabled_at IS NULL',
                    (user_id,)).fetchone()
    if user is None:
        raise NotFound()
    name = _valid_text(name, code='project', max_chars=200, max_bytes=800)
    brief_text = _valid_text(brief_text, code='brief', max_chars=8192, max_bytes=8192,
                             allow_empty=True)
    row = _execute(conn, '''INSERT INTO projects(owner_id,name,brief,brief_fields)
        VALUES (%s,%s,%s::jsonb,%s::jsonb)
        RETURNING id,name,brief->>'text' AS brief_text,brief_fields,updated_at''',
        (user_id, name, json.dumps({'text': brief_text}, ensure_ascii=False),
         json.dumps(_blank_brief_fields(brief_text), ensure_ascii=False))).fetchone()
    return _project_result(row)


def update_project(conn, user_id, project_id, name=None, brief_text=None):
    project_id = _owned_project(conn, user_id, project_id, lock=True)
    user_id = _uuid(user_id, hidden=True)
    updates, params = [], []
    if name is not None:
        updates.append('name=%s')
        params.append(_valid_text(name, code='project', max_chars=200, max_bytes=800))
    if brief_text is not None:
        brief_text = _valid_text(brief_text, code='brief', max_chars=8192,
                                 max_bytes=8192, allow_empty=True)
        current = _execute(conn, 'SELECT brief_fields FROM projects WHERE id=%s',
                           (project_id,)).fetchone()
        fields = dict(current['brief_fields'])
        fields['notes'] = brief_text
        rendered = _render_brief(fields)
        updates.extend(('brief_fields=%s::jsonb', 'brief=%s::jsonb'))
        params.extend((json.dumps(fields, ensure_ascii=False),
                       json.dumps({'text': rendered}, ensure_ascii=False)))
    if updates:
        params.extend((project_id, user_id))
        row = _execute(conn, '''UPDATE projects SET %s,updated_at=now()
            WHERE id=%%s AND owner_id=%%s
            RETURNING id,name,brief->>'text' AS brief_text,brief_fields,updated_at''' % ','.join(updates),
            tuple(params)).fetchone()
        if row is None:
            raise NotFound()
        return _project_result(row)
    return get_project(conn, user_id, project_id)


def save_project_brief(conn, user_id, project_id, field, text, expected_text, *, source_message_id=None):
    if not isinstance(field, str) or field not in _BRIEF_FIELDS:
        raise Invalid('brief_field')
    text = _valid_text(text, code='brief', max_chars=8192, max_bytes=8192, allow_empty=True)
    expected_text = _valid_text(expected_text, code='brief', max_chars=8192,
                                max_bytes=8192, allow_empty=True)
    user_id = _uuid(user_id, hidden=True)
    project_id = _owned_project(conn, user_id, project_id, lock=True)
    current = _execute(conn, '''SELECT id,name,brief_fields FROM projects
        WHERE id=%s AND owner_id=%s''', (project_id, user_id)).fetchone()
    fields = dict(current['brief_fields'])
    if fields[field] != expected_text:
        raise Conflict()
    if source_message_id is not None:
        _owned_assistant_message(conn, user_id, project_id, source_message_id)
    fields[field] = text
    rendered = _render_brief(fields)
    row = _execute(conn, '''UPDATE projects SET brief_fields=%s::jsonb,
        brief=jsonb_set(brief,'{text}',to_jsonb(%s::text),true),updated_at=now()
        WHERE id=%s AND owner_id=%s
        RETURNING id,name,brief->>'text' AS brief_text,brief_fields,updated_at''',
        (json.dumps(fields, ensure_ascii=False), rendered, project_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return _project_result(row)


def delete_project(conn, user_id, project_id):
    project_id = _owned_project(conn, user_id, project_id, lock=True)
    hashes = _execute(conn, 'SELECT DISTINCT sha256 FROM files WHERE project_id=%s',
                      (project_id,)).fetchall()
    for row in hashes:
        _execute(conn, 'INSERT INTO blob_gc(sha256) VALUES (%s) ON CONFLICT DO NOTHING',
                 (row['sha256'],))
    _execute(conn, 'DELETE FROM projects WHERE id=%s', (project_id,))
    return {}


def _owned_chat(conn, user_id, chat_id, *, lock=False):
    user_id = _uuid(user_id, hidden=True)
    chat_id = _uuid(chat_id, hidden=True)
    sql = '''SELECT c.id,c.project_id,c.title,c.mode,c.pinned,c.updated_at
        FROM chats c JOIN projects p ON p.id=c.project_id
        WHERE c.id=%s AND p.owner_id=%s'''
    if lock:
        sql += ' FOR UPDATE OF c'
    row = _execute(conn, sql, (chat_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return row


def _chat_result(row):
    return {'id': _id(row['id']), 'project_id': _id(row['project_id']),
            'title': row['title'], 'mode': row['mode'],
            'pinned': [_id(value) for value in (row['pinned'] or [])],
            'updated_at': _iso(row['updated_at'])}


def list_chats(conn, user_id, project_id):
    project_id = _owned_project(conn, user_id, project_id)
    rows = _execute(conn, '''SELECT id,title,mode,pinned,updated_at FROM chats
        WHERE project_id=%s ORDER BY updated_at DESC,id''', (project_id,)).fetchall()
    return [{'id': _id(row['id']), 'title': row['title'], 'mode': row['mode'],
             'pinned': [_id(value) for value in (row['pinned'] or [])],
             'updated_at': _iso(row['updated_at'])} for row in rows]


def get_chat(conn, user_id, chat_id):
    return _chat_result(_owned_chat(conn, user_id, chat_id))


def create_chat(conn, user_id, project_id, title='New chat'):
    project_id = _owned_project(conn, user_id, project_id)
    title = _valid_text(title, code='chat', max_chars=200, max_bytes=800)
    row = _execute(conn, '''INSERT INTO chats(project_id,title)
        VALUES (%s,%s) RETURNING id,project_id,title,mode,pinned,updated_at''',
        (project_id, title)).fetchone()
    return _chat_result(row)


def _file_ids(values, *, code, hidden=False, maximum=200):
    if not isinstance(values, (list, tuple)) or len(values) > maximum:
        raise Invalid(code)
    parsed = [_uuid(value, hidden=hidden, code=code) for value in values]
    if len(set(parsed)) != len(parsed):
        raise Invalid(code)
    return parsed


def _validate_pinned(conn, project_id, values):
    ids = _file_ids(values, code='pinned', maximum=20)
    if not ids:
        return ids
    count = _execute(conn, '''SELECT count(*) AS total FROM files
        WHERE project_id=%s AND id=ANY(%s::uuid[]) AND deleted_at IS NULL''',
        (project_id, ids)).fetchone()['total']
    if count != len(ids):
        raise Invalid('pinned')
    return ids


def update_chat(conn, user_id, chat_id, title=None, mode=None, pinned=None):
    chat = _owned_chat(conn, user_id, chat_id, lock=True)
    updates, params = [], []
    if title is not None:
        updates.append('title=%s')
        params.append(_valid_text(title, code='chat', max_chars=200, max_bytes=800))
    if mode is not None:
        if mode not in ('auto', 'technical'):
            raise Invalid('mode')
        updates.append('mode=%s')
        params.append(mode)
    if pinned is not None:
        updates.append('pinned=%s::uuid[]')
        params.append(_validate_pinned(conn, chat['project_id'], pinned))
    if updates:
        params.extend((chat['id'], _uuid(user_id, hidden=True)))
        row = _execute(conn, '''UPDATE chats c SET %s,updated_at=now()
            FROM projects p WHERE c.id=%%s AND p.id=c.project_id AND p.owner_id=%%s
            RETURNING c.id,c.project_id,c.title,c.mode,c.pinned,c.updated_at''' % ','.join(updates),
            tuple(params)).fetchone()
        if row is None:
            raise NotFound()
        return _chat_result(row)
    return _chat_result(chat)


def delete_chat(conn, user_id, chat_id):
    chat = _owned_chat(conn, user_id, chat_id)
    _execute(conn, 'DELETE FROM chats WHERE id=%s', (chat['id'],))
    return {}


def _request_id(value):
    return _uuid(value, code='request_id') if value is not None else None


def _message_result(row):
    return {'id': _id(row['id']), 'role': row['role'], 'content': row['content'],
            'mentions': [_id(value) for value in (row['mentions'] or [])],
            'route': row['route'], 'status': row['status'], 'payload': row['payload'],
            'request_id': _id(row['request_id']), 'created_at': _iso(row['created_at'])}


def list_messages(conn, user_id, chat_id):
    chat = _owned_chat(conn, user_id, chat_id)
    rows = _execute(conn, '''SELECT id,role,content,mentions,route,status,payload,request_id,created_at
        FROM (SELECT id,role,content,mentions,route,status,payload,request_id,created_at
              FROM messages WHERE chat_id=%s ORDER BY created_at DESC,id DESC LIMIT 100) recent
        ORDER BY created_at,id''', (chat['id'],)).fetchall()
    return [_message_result(row) for row in rows]

def _todo_result(row):
    return {'id': _id(row['id']), 'project_id': _id(row['project_id']),
            'text': row['text'], 'completed': row['completed'],
            'source_message_id': _id(row['source_message_id']),
            'source_chat_id': _id(row['source_chat_id']),
            'created_at': _iso(row['created_at']), 'updated_at': _iso(row['updated_at'])}


def _owned_todo(conn, user_id, todo_id, *, lock=False):
    user_id = _uuid(user_id, hidden=True)
    todo_id = _uuid(todo_id, hidden=True)
    sql = '''SELECT t.id,t.project_id,t.text,t.completed,t.source_message_id,t.source_chat_id,
                    t.created_at,t.updated_at
        FROM todos t JOIN projects p ON p.id=t.project_id
        WHERE t.id=%s AND p.owner_id=%s'''
    if lock:
        sql += ' FOR UPDATE OF t'
    row = _execute(conn, sql, (todo_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    return row


def list_todos(conn, user_id, project_id):
    project_id = _owned_project(conn, user_id, project_id)
    rows = _execute(conn, '''SELECT id,project_id,text,completed,source_message_id,source_chat_id,
                                    created_at,updated_at
        FROM todos WHERE project_id=%s ORDER BY created_at,id''', (project_id,)).fetchall()
    return [_todo_result(row) for row in rows]


def create_todo(conn, user_id, project_id, text, *, source_message_id=None):
    user_id = _uuid(user_id, hidden=True)
    project_id = _owned_project(conn, user_id, project_id)
    text = _valid_text(text, code='todo', max_chars=2000, max_bytes=8000)
    source_id, source_chat_id = (None, None)
    if source_message_id is not None:
        source_id, source_chat_id = _owned_assistant_message(
            conn, user_id, project_id, source_message_id)
    row = _execute(conn, '''INSERT INTO todos(project_id,text,source_message_id,source_chat_id)
        VALUES (%s,%s,%s,%s)
        RETURNING id,project_id,text,completed,source_message_id,source_chat_id,created_at,updated_at''',
        (project_id, text, source_id, source_chat_id)).fetchone()
    return _todo_result(row)


def update_todo(conn, user_id, todo_id, text=None, completed=None):
    if text is None and completed is None:
        raise Invalid('todo')
    todo = _owned_todo(conn, user_id, todo_id, lock=True)
    updates, params = [], []
    if text is not None:
        updates.append('text=%s')
        params.append(_valid_text(text, code='todo', max_chars=2000, max_bytes=8000))
    if completed is not None:
        if not isinstance(completed, bool):
            raise Invalid('todo')
        updates.append('completed=%s')
        params.append(completed)
    params.extend((todo['id'], todo['project_id']))
    row = _execute(conn, '''UPDATE todos SET %s,updated_at=now()
        WHERE id=%%s AND project_id=%%s
        RETURNING id,project_id,text,completed,source_message_id,source_chat_id,created_at,updated_at''' %
        ','.join(updates), tuple(params)).fetchone()
    if row is None:
        raise NotFound()
    return _todo_result(row)


def delete_todo(conn, user_id, todo_id):
    todo = _owned_todo(conn, user_id, todo_id, lock=True)
    _execute(conn, 'DELETE FROM todos WHERE id=%s AND project_id=%s',
             (todo['id'], todo['project_id']))
    return {'deleted': True}


def add_user_message(conn, user_id, chat_id, content, mentions, request_id):
    chat = _owned_chat(conn, user_id, chat_id, lock=True)
    content = _valid_text(content, code='message', max_chars=16000, max_bytes=32768)
    ids = _file_ids(mentions, code='mentions', maximum=10)
    if ids:
        count = _execute(conn, '''SELECT count(*) AS total FROM files
            WHERE project_id=%s AND id=ANY(%s::uuid[]) AND status='ready' AND deleted_at IS NULL''',
            (chat['project_id'], ids)).fetchone()['total']
        if count != len(ids):
            raise Invalid('mentions')
    row = _execute(conn, '''INSERT INTO messages(chat_id,role,content,mentions,request_id)
        VALUES (%s,'user',%s,%s::uuid[],%s)
        RETURNING id,role,content,mentions,route,status,payload,request_id,created_at''',
        (chat['id'], content, ids, _request_id(request_id))).fetchone()
    _execute(conn, 'UPDATE chats SET updated_at=now() WHERE id=%s', (chat['id'],))
    return _message_result(row)


def add_assistant_message(conn, chat_id, content, payload, route, request_id, status):
    chat_id = _uuid(chat_id, hidden=True)
    if route not in (None, 'general', 'technical'):
        raise Invalid('route')
    if status not in ('complete', 'error'):
        raise Invalid('status')
    content = _valid_text(content, code='message', max_chars=16000, max_bytes=32768,
                          allow_empty=status == 'error')
    if payload is not None and not isinstance(payload, dict):
        raise Invalid('payload')
    row = _execute(conn, '''INSERT INTO messages(chat_id,role,content,route,status,payload,request_id)
        SELECT c.id,'assistant',%s,%s,%s,%s::jsonb,%s FROM chats c
        WHERE c.id=%s RETURNING id,role,content,mentions,route,status,payload,request_id,created_at''',
        (content, route, status, json.dumps(payload, ensure_ascii=False) if payload is not None else None,
         _request_id(request_id), chat_id)).fetchone()
    if row is None:
        raise NotFound()
    _execute(conn, 'UPDATE chats SET updated_at=now() WHERE id=%s', (chat_id,))
    return _message_result(row)


def recent_user_questions(conn, chat_id, limit=6, max_bytes=8192):
    chat_id = _uuid(chat_id, hidden=True)
    if type(limit) is not int or not 1 <= limit <= 6:
        raise Invalid('limit')
    if type(max_bytes) is not int or not 1 <= max_bytes <= 8192:
        raise Invalid('max_bytes')
    rows = _execute(conn, '''SELECT content FROM messages
        WHERE chat_id=%s AND role='user' AND status='complete'
        ORDER BY created_at DESC,id DESC LIMIT %s''', (chat_id, limit)).fetchall()
    questions, total = [], 0
    for row in rows:
        size = len(row['content'].encode('utf-8'))
        if total + size > max_bytes:
            break
        questions.append(row['content'])
        total += size
    questions.reverse()
    return questions


def _data_root():
    data_home = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local' / 'share')))
    root = Path(os.environ.get('HIS_APP_DATA_ROOT', str(data_home / 'hardviser' / 'app-data')))
    if not root.is_absolute():
        raise Invalid('storage_config')
    return root


def _private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise PermissionError('app storage directory must be owner-only')
    return path


def file_path(sha256):
    if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
        raise Invalid('sha256')
    return _data_root() / 'files' / sha256[:2] / sha256


def _upload_path(upload_id):
    return _data_root() / 'uploads' / str(upload_id)


def _file_result(row, *, include_sha=False):
    result = {'id': _id(row['id']), 'name': row['name'], 'mime': row['mime'],
              'size_bytes': row['size_bytes'], 'status': row['status'],
              'error': row['error'], 'created_at': _iso(row['created_at']),
              'kind': row['kind'], 'content_level': row['content_level']}
    if include_sha:
        result['sha256'] = row['sha256'].strip()
    return result


def list_files(conn, user_id, project_id):
    project_id = _owned_project(conn, user_id, project_id)
    rows = _execute(conn, '''SELECT id,name,mime,size_bytes,status,error,created_at,kind,content_level
        FROM files WHERE project_id=%s AND deleted_at IS NULL
        ORDER BY created_at DESC,id''', (project_id,)).fetchall()
    return [_file_result(row) for row in rows]

def browse_files(conn, user_id):
    user_id = _uuid(user_id, hidden=True)
    rows = _execute(conn, '''SELECT f.id,f.name,f.mime,f.size_bytes,f.status,f.error,f.created_at,
                                    f.kind,f.content_level,p.id AS project_id,p.name AS project_name
        FROM files f JOIN projects p ON p.id=f.project_id
        WHERE p.owner_id=%s AND f.deleted_at IS NULL
        ORDER BY f.created_at DESC,f.id''', (user_id,)).fetchall()
    result = []
    for row in rows:
        item = _file_result(row)
        item['project_id'] = _id(row['project_id'])
        item['project_name'] = row['project_name']
        result.append(item)
    return result


def _check_file_quota(conn, user_id, project_id, size_bytes):
    used_bytes = _execute(conn, '''SELECT
          COALESCE((SELECT sum(f.size_bytes) FROM files f
                    JOIN projects p ON p.id=f.project_id
                    WHERE p.owner_id=%s AND f.deleted_at IS NULL AND f.status<>'failed'),0)
        + COALESCE((SELECT sum(us.size_bytes) FROM upload_sessions us
                    WHERE us.user_id=%s AND us.expires_at>now()),0) AS used_bytes''',
        (user_id, user_id)).fetchone()['used_bytes']
    if used_bytes + size_bytes > MAX_USER_STORAGE_BYTES:
        raise QuotaExceeded('storage')
    project_count = _execute(conn, '''SELECT
          (SELECT count(*) FROM files WHERE project_id=%s AND deleted_at IS NULL AND status<>'failed')
        + (SELECT count(*) FROM upload_sessions WHERE project_id=%s AND expires_at>now()) AS total''',
        (project_id, project_id)).fetchone()['total']
    if project_count >= MAX_PROJECT_FILES:
        raise QuotaExceeded('files')

def attach_file(conn, user_id, project_id, file_id):
    user_id = _uuid(user_id, hidden=True)
    user = _execute(conn, 'SELECT id FROM users WHERE id=%s AND disabled_at IS NULL FOR UPDATE',
                    (user_id,)).fetchone()
    if user is None:
        raise NotFound()
    project_id = _owned_project(conn, user_id, project_id, lock=True)
    file_id = _uuid(file_id, hidden=True)
    imported = _execute(conn, '''SELECT f.id,f.name,f.mime,f.size_bytes,f.status,f.error,f.created_at,
                                       f.kind,f.content_level
        FROM file_imports i JOIN files f ON f.id=i.target_file_id
        WHERE i.target_project_id=%s AND i.source_file_id=%s AND f.deleted_at IS NULL''',
        (project_id, file_id)).fetchone()
    if imported is not None:
        return _file_result(imported)

    source = _execute(conn, '''SELECT f.id,f.project_id,f.name,f.mime,f.size_bytes,f.sha256,
                                      f.status,f.error,f.created_at,f.kind,f.content_level
        FROM files f JOIN projects p ON p.id=f.project_id
        WHERE f.id=%s AND p.owner_id=%s AND f.status='ready' AND f.deleted_at IS NULL
        FOR UPDATE OF f''', (file_id, user_id)).fetchone()
    if source is None:
        raise NotFound()
    if source['project_id'] == project_id:
        return _file_result(source)
    _check_file_quota(conn, user_id, project_id, source['size_bytes'])
    target = _execute(conn, '''INSERT INTO files
        (project_id,name,mime,size_bytes,sha256,kind,content_level,status)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'ready')
        RETURNING id,name,mime,size_bytes,status,error,created_at,kind,content_level''',
        (project_id, source['name'], source['mime'], source['size_bytes'], source['sha256'],
         source['kind'], source['content_level'])).fetchone()
    _execute(conn, '''INSERT INTO file_imports(target_project_id,source_file_id,target_file_id)
        VALUES (%s,%s,%s)''', (project_id, file_id, target['id']))
    _execute(conn, '''INSERT INTO file_chunks(file_id,idx,page,text,embedding)
        SELECT %s,idx,page,text,embedding FROM file_chunks WHERE file_id=%s''',
        (target['id'], file_id))
    return _file_result(target)

def _validate_upload(name, mime, size_bytes, sha256):
    if not isinstance(mime, str) or len(mime) > 100 or '\x00' in mime:
        raise Invalid('mime')
    name = _valid_text(name, code='name', max_chars=200, max_bytes=800)
    if '/' in name or '\\' in name:
        raise Invalid('name')
    try:
        extractors.classify(name)
    except extractors.UnsupportedFormat:
        raise Invalid('unsupported_type') from None
    if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes < 0:
        raise Invalid('file_size')
    if size_bytes > MAX_FILE_BYTES:
        raise QuotaExceeded('file_size')
    if size_bytes > MAX_NEW_FILE_BYTES:
        raise Invalid('file_size')
    if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
        raise Invalid('sha256')
    return name


def start_upload(conn, user_id, project_id, name, mime, size_bytes, sha256):
    user_id = _uuid(user_id, hidden=True)
    user = _execute(conn, 'SELECT id FROM users WHERE id=%s AND disabled_at IS NULL FOR UPDATE',
                    (user_id,)).fetchone()
    if user is None:
        raise NotFound()
    project_id = _owned_project(conn, user_id, project_id, lock=True)
    name = _validate_upload(name, mime, size_bytes, sha256)
    _check_file_quota(conn, user_id, project_id, size_bytes)
    _private_dir(_data_root() / 'uploads')
    upload_id = uuid.uuid4()
    _execute(conn, '''INSERT INTO upload_sessions
        (id,user_id,project_id,name,mime,size_bytes,sha256,expires_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,now()+%s::interval)''',
        (upload_id, user_id, project_id, name, mime, size_bytes, sha256,
         '%s seconds' % int(UPLOAD_TTL.total_seconds())))
    return {'upload_id': str(upload_id), 'chunk_bytes': CHUNK_BYTES}


def _owned_upload(conn, user_id, upload_id, *, lock=False):
    user_id = _uuid(user_id, hidden=True)
    upload_id = _uuid(upload_id, hidden=True)
    sql = '''SELECT us.id,us.user_id,us.project_id,us.name,us.mime,us.size_bytes,us.sha256,
                    us.received_bytes,us.next_index,us.expires_at
        FROM upload_sessions us JOIN projects p ON p.id=us.project_id
        WHERE us.id=%s AND us.user_id=%s AND p.owner_id=%s'''
    if lock:
        sql += ' FOR UPDATE OF us'
    row = _execute(conn, sql, (upload_id, user_id, user_id)).fetchone()
    if row is None or row['expires_at'] <= datetime.now(timezone.utc):
        raise NotFound()
    return row


def _validate_upload_fd(fd, expected_owner):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != expected_owner
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise PermissionError('app upload file must be owner-only')
    return info


def put_chunk(conn, user_id, upload_id, index, data):
    row = _owned_upload(conn, user_id, upload_id, lock=True)
    if type(index) is not int or index < 0 or index != row['next_index']:
        raise Invalid('chunk_order')
    if not isinstance(data, bytes) or not data or len(data) > CHUNK_BYTES:
        raise Invalid('chunk')
    if row['received_bytes'] + len(data) > row['size_bytes']:
        raise Invalid('chunk_size')
    path = _upload_path(row['id'])
    _private_dir(path.parent)
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, 0o600)
    try:
        info = _validate_upload_fd(fd, os.geteuid())
        if info.st_size != row['received_bytes']:
            os.ftruncate(fd, row['received_bytes'])
        os.lseek(fd, row['received_bytes'], os.SEEK_SET)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError('short write to app upload')
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    _execute(conn, '''UPDATE upload_sessions
        SET received_bytes=received_bytes+%s,next_index=next_index+1 WHERE id=%s''',
        (len(data), row['id']))


def _hash_path(path):
    flags = os.O_RDONLY
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        info = _validate_upload_fd(fd, os.geteuid())
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
                size += len(block)
        return size, digest.hexdigest(), info
    finally:
        os.close(fd)


def finish_upload(conn, user_id, upload_id):
    row = _owned_upload(conn, user_id, upload_id, lock=True)
    if row['size_bytes'] > MAX_NEW_FILE_BYTES:
        raise Invalid('file_size')
    if row['received_bytes'] != row['size_bytes']:
        raise Invalid('upload_incomplete')
    temp_path = _upload_path(row['id'])
    _private_dir(temp_path.parent)
    if not temp_path.exists() and row['size_bytes'] == 0:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
        if hasattr(os, 'O_NOFOLLOW'):
            flags |= os.O_NOFOLLOW
        fd = os.open(temp_path, flags, 0o600)
        os.close(fd)
    try:
        actual_size, actual_sha, _ = _hash_path(temp_path)
    except (FileNotFoundError, OSError):
        raise Invalid('upload_integrity') from None
    if actual_size != row['size_bytes'] or not hmac.compare_digest(actual_sha, row['sha256']):
        raise Invalid('upload_integrity')

    conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', (actual_sha,))
    blob_path = file_path(actual_sha)
    _private_dir(blob_path.parent)
    try:
        os.link(temp_path, blob_path, follow_symlinks=False)
    except FileExistsError:
        try:
            blob_size, blob_sha, _ = _hash_path(blob_path)
        except OSError:
            raise Invalid('upload_integrity') from None
        if blob_size != actual_size or not hmac.compare_digest(blob_sha, actual_sha):
            raise Invalid('upload_integrity')

    kind, content_level = extractors.classify(row['name'])
    file_row = _execute(conn, '''INSERT INTO files
        (project_id,name,mime,size_bytes,sha256,kind,content_level,status)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'pending')
        RETURNING id,name,mime,size_bytes,sha256,status,error,created_at,kind,content_level''',
        (row['project_id'], row['name'], row['mime'], row['size_bytes'], actual_sha,
         kind, content_level)).fetchone()
    _execute(conn, 'DELETE FROM upload_sessions WHERE id=%s', (row['id'],))
    return _file_result(file_row, include_sha=True)


def delete_file(conn, user_id, file_id):
    user_id = _uuid(user_id, hidden=True)
    file_id = _uuid(file_id, hidden=True)
    row = _execute(conn, '''UPDATE files f SET deleted_at=COALESCE(deleted_at,now())
        FROM projects p WHERE f.id=%s AND p.id=f.project_id AND p.owner_id=%s
          AND f.deleted_at IS NULL RETURNING f.id,f.sha256''',
        (file_id, user_id)).fetchone()
    if row is None:
        raise NotFound()
    _execute(conn, 'DELETE FROM file_chunks WHERE file_id=%s', (file_id,))
    _execute(conn, 'DELETE FROM file_imports WHERE target_file_id=%s', (file_id,))
    _execute(conn, 'UPDATE chats SET pinned=array_remove(pinned,%s),updated_at=now() WHERE %s=ANY(pinned)',
             (file_id, file_id))
    _execute(conn, 'INSERT INTO blob_gc(sha256) VALUES (%s) ON CONFLICT DO NOTHING',
             (row['sha256'],))
    return {}


def _vector_literal(values):
    if not isinstance(values, (list, tuple)) or len(values) != 384:
        raise Invalid('embedding')
    try:
        encoded = '[' + ','.join(format(float(value), '.9g') for value in values) + ']'
    except (TypeError, ValueError, OverflowError):
        raise Invalid('embedding') from None
    return encoded


def _query_embedding(text):
    from hardissoft_kb.search import vector

    segments = vector.encode_segments([text], kind='query')[0]
    mean = [sum(part['embedding'][i] for part in segments) / len(segments)
            for i in range(vector.DIMENSIONS)]
    norm = sum(value * value for value in mean) ** 0.5
    if not norm:
        raise Invalid('query')
    return [value / norm for value in mean]


def _clip_utf8(text, max_bytes):
    raw = text.encode('utf-8')
    if len(raw) <= max_bytes:
        return text
    return raw[:max_bytes].decode('utf-8', 'ignore')


def search_project_files(conn, user_id, project_id, query, file_ids=None, limit=6, max_bytes=8192):
    project_id = _owned_project(conn, user_id, project_id)
    query = _valid_text(query, code='query', max_chars=4000, max_bytes=8192)
    if type(limit) is not int or not 1 <= limit <= 100:
        raise Invalid('limit')
    if type(max_bytes) is not int or not 1 <= max_bytes <= 65536:
        raise Invalid('max_bytes')
    selected_ids = None
    if file_ids is not None:
        selected_ids = _file_ids(file_ids, code='file_ids', hidden=True)
        if not selected_ids:
            return []
        if len(selected_ids) > MAX_PROJECT_FILES:
            raise Invalid('file_ids')
        available = _execute(conn, '''SELECT id FROM files
            WHERE project_id=%s AND id=ANY(%s::uuid[]) AND status='ready' AND deleted_at IS NULL''',
            (project_id, selected_ids)).fetchall()
        if len(available) != len(selected_ids):
            raise NotFound()
    vector_literal = _vector_literal(_query_embedding(query))
    selected = selected_ids
    rows = _execute(conn, '''WITH q AS (
          SELECT %s::vector AS embedding,
                 plainto_tsquery('russian',%s) AS ru,
                 plainto_tsquery('english',%s) AS en
        ), vector_candidates AS MATERIALIZED (
          SELECT fc.file_id,fc.idx,
                 row_number() OVER (ORDER BY fc.embedding <=> q.embedding) AS rank
          FROM file_chunks fc JOIN files f ON f.id=fc.file_id CROSS JOIN q
          WHERE f.project_id=%s AND f.status='ready' AND f.deleted_at IS NULL
            AND fc.embedding IS NOT NULL
            AND (%s::uuid[] IS NULL OR f.id=ANY(%s::uuid[]))
          ORDER BY fc.embedding <=> q.embedding LIMIT 100
        ), lexical_candidates AS MATERIALIZED (
          SELECT fc.file_id,fc.idx,
                 row_number() OVER (ORDER BY
                   ts_rank_cd(fc.fts_ru,q.ru)+ts_rank_cd(fc.fts_en,q.en) DESC) AS rank
          FROM file_chunks fc JOIN files f ON f.id=fc.file_id CROSS JOIN q
          WHERE f.project_id=%s AND f.status='ready' AND f.deleted_at IS NULL
            AND (fc.fts_ru @@ q.ru OR fc.fts_en @@ q.en)
            AND (%s::uuid[] IS NULL OR f.id=ANY(%s::uuid[]))
          ORDER BY ts_rank_cd(fc.fts_ru,q.ru)+ts_rank_cd(fc.fts_en,q.en) DESC
          LIMIT 100
        ), candidates AS (
          SELECT file_id,idx,1.0/(60+rank) AS score FROM vector_candidates
          UNION ALL
          SELECT file_id,idx,1.0/(60+rank) AS score FROM lexical_candidates
        ), ranked AS (
          SELECT file_id,idx,sum(score) AS score FROM candidates GROUP BY file_id,idx
        )
        SELECT f.id AS file_id,f.name,fc.page,fc.text,f.kind,f.content_level,r.score
        FROM ranked r JOIN file_chunks fc ON fc.file_id=r.file_id AND fc.idx=r.idx
        JOIN files f ON f.id=fc.file_id
        WHERE f.project_id=%s AND f.status='ready' AND f.deleted_at IS NULL
        ORDER BY r.score DESC,f.id,fc.idx LIMIT %s''',
        (vector_literal, query, query, project_id, selected, selected,
         project_id, selected, selected, project_id, limit)).fetchall()
    result, used = [], 0
    for row in rows:
        remaining = max_bytes - used
        if remaining <= 0:
            break
        text = _clip_utf8(row['text'], remaining)
        if not text:
            continue
        used += len(text.encode('utf-8'))
        result.append({'file_id': _id(row['file_id']), 'name': row['name'],
                       'page': row['page'], 'text': text, 'kind': row['kind'],
                       'content_level': row['content_level']})
    return result
