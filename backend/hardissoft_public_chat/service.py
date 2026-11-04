"""Loopback-only HMAC bridge for authenticated app storage and chat operations."""
from collections import deque
from contextlib import contextmanager
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
import unicodedata
import uuid

from . import adminstore, appstore, billing, emailauth, extractors, muse, orchestrator, retrieval, state

PATH = '/v1/public-rag/chat'
BODY_LIMIT = 48 * 1024
BRIEF_BODY_LIMIT = 128 * 1024
UPLOAD_BODY_LIMIT = 4 * 1024 * 1024
STREAM_LIMIT = 64 * 1024
MAX_PROMPT_TOKENS = 32 * 1024
MAX_COMPLETION_TOKENS = 8000
MAX_NEW_FILE_SIZE = appstore.MAX_NEW_FILE_BYTES
MAX_CHUNK_BYTES = 2 * 1024 * 1024
WEBHOOK_BODY_LIMIT = 128 * 1024
_BRIEF_FIELDS = frozenset(('description', 'audience', 'markets', 'team', 'goal', 'notes'))
_MAX_LOGIN_FAILURES = 10
_LOGIN_WINDOW_SECONDS = 15 * 60
_KEY = re.compile(r'^[a-f0-9]{64}$')
_NONCE = re.compile(r'^[a-f0-9]{32}$')
_BUCKET = re.compile(r'^[a-f0-9]{64}$')
_EMAIL_AUTH_PATHS = frozenset(('/auth/email/request', '/auth/email/prepare', '/auth/email/consume'))
_UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
_MAX_SAFE_INTEGER = 9007199254740991
_ADMIN_ROLES = ('admin', 'expert')
_AUDIT_OPERATIONS = frozenset((
    'admin.users.roles.set', 'admin.users.status.set', 'admin.bootstrap'))
_ADMIN_PATHS = frozenset((
    '/admin/users/list', '/admin/users/get', '/admin/users/roles/set',
    '/admin/users/status/set', '/admin/audit/list'))
_SHA256 = re.compile(r'^[a-f0-9]{64}$')
_MARKER = re.compile(r'\[e\d{1,2}\]', re.IGNORECASE)
_PRIVATE_QUERY_ID = re.compile(r'(?i)(?:\b[0-9a-f]{32,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)')
_PRIVATE_QUERY_PATH = re.compile(r'(?<![\w])(?:~?/|[A-Za-z]:\\|\.{1,2}/)[^\s]')
_UNAVAILABLE = (retrieval.RetrievalUnavailable, muse.Unavailable)
_TIMEOUTS = (orchestrator.DeadlineExceeded, TimeoutError)
ERROR_TEXTS = {
    'service_unavailable': 'The RAG chat service is unavailable.',
    'timeout': 'The RAG chat service took too long to answer.',
    'service_error': 'The RAG chat service could not answer this request.',
}
_HTTP_ERRORS = {
    'invalid_request': 'The request is invalid.',
    'unauthorized': 'A valid session is required.',
    'forbidden': 'This account is not allowed to perform this operation.',
    'not_found': 'The requested resource was not found.',
    'replayed_request': 'This signed request was already used.',
    'duplicate_request': 'This request was already submitted.',
    'request_too_large': 'The request body exceeds the allowed size.',
    'quota_exceeded': 'The account limit was reached. Try again later.',
    'service_unavailable': ERROR_TEXTS['service_unavailable'],
    'unsupported_type': 'Unsupported file type. See the list of supported formats.',
    'conflict': 'The request conflicts with current server state.',
    'stale_user': 'The account changed before this request could be applied.',
    'self_protection': 'This account cannot remove its own administrator role.',
    'last_admin': 'The last administrator role cannot be removed.',
    'invalid_response': 'The server returned an invalid response.',
    'invalid_link': 'This email link is invalid or has expired.',
}
_OPERATION_NAMES = {
    '/auth/email/request': 'auth.email.request',
    '/auth/email/prepare': 'auth.email.prepare',
    '/auth/email/consume': 'auth.email.consume',
    '/auth/login': 'auth.login', '/auth/logout': 'auth.logout', '/auth/me': 'auth.me',
    '/account/profile/update': 'account.profile.update',
    '/admin/users/list': 'admin.users.list', '/admin/users/get': 'admin.users.get',
    '/admin/users/roles/set': 'admin.users.roles.set',
    '/admin/users/status/set': 'admin.users.status.set',
    '/admin/audit/list': 'admin.audit.list',
    '/projects/list': 'projects.list', '/projects/create': 'projects.create',
    '/projects/update': 'projects.update', '/projects/delete': 'projects.delete',
    '/projects/brief/save': 'projects.brief.save',
    '/chats/list': 'chats.list', '/chats/create': 'chats.create', '/chats/update': 'chats.update',
    '/chats/delete': 'chats.delete', '/messages/list': 'messages.list',
    '/todos/list': 'todos.list', '/todos/create': 'todos.create',
    '/todos/update': 'todos.update', '/todos/delete': 'todos.delete',
    '/files/list': 'files.list', '/files/browse': 'files.browse', '/files/attach': 'files.attach',
    '/files/delete': 'files.delete', '/files/upload/start': 'files.upload.start',
    '/files/upload/chunk': 'files.upload.chunk', '/files/upload/finish': 'files.upload.finish',
    '/billing/status': 'billing.status', '/billing/sync': 'billing.sync',
    '/revenuecat-webhook': 'revenuecat.webhook',
    '/ask': 'ask',
}


def _key_bytes(key):
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise ValueError('HMAC key must be 32 bytes of lowercase hex')
    return bytes.fromhex(key)


def sign(key, method, path, timestamp, nonce, body):
    if not isinstance(body, bytes):
        raise TypeError('signed body must be exact bytes')
    canonical = (str(timestamp) + '\n' + str(nonce) + '\n' + str(method).upper() + '\n' + str(path) + '\n').encode('utf-8') + body
    return hmac.new(_key_bytes(key), canonical, hashlib.sha256).hexdigest()


def verify(key, method, path, timestamp, nonce, body, signature, *, now=None):
    if not isinstance(timestamp, str) or not timestamp.isascii() or not timestamp.isdigit():
        return False
    if not isinstance(nonce, str) or not _NONCE.fullmatch(nonce):
        return False
    if not isinstance(signature, str) or not _KEY.fullmatch(signature) or not isinstance(body, bytes):
        return False
    try:
        key_bytes = _key_bytes(key)
        issued = int(timestamp)
    except (ValueError, OverflowError):
        return False
    current = int(time.time()) if now is None else now
    if isinstance(current, bool) or not isinstance(current, int) or abs(current - issued) > 300:
        return False
    canonical = (timestamp + '\n' + nonce + '\n' + str(method).upper() + '\n' + str(path) + '\n').encode('utf-8') + body
    return hmac.compare_digest(hmac.new(key_bytes, canonical, hashlib.sha256).hexdigest(), signature)


def _valid_text(value, *, max_chars, max_bytes, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value.strip()) or len(value) > max_chars or '\x00' in value:
        return False
    try:
        return len(value.encode('utf-8')) <= max_bytes
    except UnicodeEncodeError:
        return False


def _valid_uuid(value):
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def _valid_ids(value, *, maximum):
    return (isinstance(value, list) and len(value) <= maximum
            and all(_valid_uuid(item) for item in value) and len(set(value)) == len(value))


def _valid_request_id(value):
    return _valid_uuid(value)


def _parse_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(
            value[:-1] + '+00:00' if value.endswith('Z') else value)
    except (ValueError, OverflowError):
        return None
    return timestamp if timestamp.tzinfo is not None and timestamp.utcoffset() is not None else None


def _valid_timestamp(value):
    return _parse_timestamp(value) is not None


def _valid_cursor(value):
    return (isinstance(value, dict) and set(value) == {'at', 'id'}
            and _valid_timestamp(value.get('at')) and _valid_uuid(value.get('id')))


def _valid_roles(value):
    return (isinstance(value, list) and len(value) <= len(_ADMIN_ROLES)
            and all(isinstance(role, str) and role in _ADMIN_ROLES for role in value)
            and value == sorted(set(value)))


def _valid_display_name(value):
    if value is None:
        return True
    return (_valid_text(value, max_chars=80, max_bytes=320)
            and value == value.strip()
            and all(unicodedata.category(character) != 'Cc' for character in value))


def _valid_reason(value):
    return (_valid_text(value, max_chars=500, max_bytes=2000)
            and value == value.strip())


def _valid_limit(value):
    return type(value) is int and 1 <= value <= 100


def _schema(path):
    common = {'request_id'}
    if path == '/auth/email/request':
        return common | {'client_bucket', 'email', 'return_to'}, set()
    if path in ('/auth/email/prepare', '/auth/email/consume'):
        return common | {'client_bucket', 'token'}, set()
    if path == '/auth/login':
        return common | {'client_bucket', 'login', 'password'}, set()
    if path in ('/auth/logout', '/auth/me'):
        return common | {'session_token'}, set()
    if path == '/account/profile/update':
        return common | {'session_token', 'display_name'}, set()
    if path == '/admin/users/list':
        return common | {'session_token'}, {'query', 'role', 'status', 'cursor', 'limit'}
    if path == '/admin/users/get':
        return common | {'session_token', 'user_id'}, set()
    if path == '/admin/users/roles/set':
        return common | {'session_token', 'user_id', 'roles', 'expected_revision', 'reason'}, set()
    if path == '/admin/users/status/set':
        return common | {'session_token', 'user_id', 'disabled', 'expected_revision', 'reason'}, set()
    if path == '/admin/audit/list':
        return common | {'session_token'}, {
            'target_user_id', 'actor_id', 'operation', 'since', 'until', 'cursor', 'limit'}
    if path == '/projects/list':
        return common | {'session_token'}, set()
    if path == '/projects/create':
        return common | {'session_token', 'name', 'brief_text'}, set()
    if path == '/projects/update':
        return common | {'session_token', 'project_id'}, {'name', 'brief_text'}
    if path == '/projects/brief/save':
        return common | {'session_token', 'project_id', 'field', 'text', 'expected_text'}, {'source_message_id'}
    if path == '/projects/delete':
        return common | {'session_token', 'project_id'}, set()
    if path == '/chats/list':
        return common | {'session_token', 'project_id'}, set()
    if path == '/chats/create':
        return common | {'session_token', 'project_id'}, {'title'}
    if path == '/chats/update':
        return common | {'session_token', 'chat_id'}, {'title', 'mode', 'pinned'}
    if path == '/chats/delete':
        return common | {'session_token', 'chat_id'}, set()
    if path == '/messages/list':
        return common | {'session_token', 'chat_id'}, set()
    if path == '/todos/list':
        return common | {'session_token', 'project_id'}, set()
    if path == '/todos/create':
        return common | {'session_token', 'project_id', 'text'}, {'source_message_id'}
    if path == '/todos/update':
        return common | {'session_token', 'todo_id'}, {'text', 'completed'}
    if path == '/todos/delete':
        return common | {'session_token', 'todo_id'}, set()
    if path == '/files/list':
        return common | {'session_token', 'project_id'}, set()
    if path == '/files/browse':
        return common | {'session_token'}, set()
    if path == '/files/attach':
        return common | {'session_token', 'project_id', 'file_id'}, set()
    if path == '/files/delete':
        return common | {'session_token', 'file_id'}, set()
    if path == '/files/upload/start':
        return common | {'session_token', 'project_id', 'name', 'mime', 'size_bytes', 'sha256'}, set()
    if path == '/files/upload/chunk':
        return common | {'session_token', 'upload_id', 'index', 'data_b64'}, set()
    if path == '/files/upload/finish':
        return common | {'session_token', 'upload_id'}, set()
    if path == '/billing/status':
        return common | {'session_token'}, set()
    if path == '/billing/sync':
        return common | {'session_token'}, set()
    if path == '/revenuecat-webhook':
        return common | {'payload'}, set()
    if path == '/ask':
        return common | {'session_token', 'chat_id', 'question', 'mentions', 'route_mode'}, set()
    return None


def _validate_body(path, value):
    schema = _schema(path)
    if schema is None or not isinstance(value, dict):
        return False
    required, optional = schema
    if not required.issubset(value) or not set(value).issubset(required | optional):
        return False
    if not _valid_request_id(value.get('request_id')):
        return False
    if path in _EMAIL_AUTH_PATHS:
        bucket_valid = isinstance(value.get('client_bucket'), str) and _BUCKET.fullmatch(
            value['client_bucket']) is not None
        if not bucket_valid:
            return False
        if path == '/auth/email/request':
            return (_valid_text(value.get('email'), max_chars=254, max_bytes=254)
                    and _valid_text(value.get('return_to'), max_chars=512, max_bytes=2048))
        return isinstance(value.get('token'), str) and len(value['token']) <= 256
    if path == '/auth/login':
        bucket = value.get('client_bucket')
        return (isinstance(bucket, str) and _BUCKET.fullmatch(bucket) is not None
                and _valid_text(value.get('login'), max_chars=64, max_bytes=64)
                and _valid_text(value.get('password'), max_chars=4096, max_bytes=4096))
    if path != '/auth/login' and 'session_token' in required:
        if not _valid_text(value.get('session_token'), max_chars=256, max_bytes=256):
            return False
    if path in ('/billing/status', '/billing/sync'):
        return True
    if path == '/revenuecat-webhook':
        return isinstance(value.get('payload'), dict)
    if path == '/account/profile/update':
        return _valid_display_name(value.get('display_name'))
    if path == '/admin/users/list':
        return (
            ('query' not in value or _valid_text(
                value['query'], max_chars=254, max_bytes=1016, allow_empty=True))
            and ('role' not in value or value['role'] in _ADMIN_ROLES)
            and ('status' not in value or value['status'] in ('active', 'disabled'))
            and ('cursor' not in value or _valid_cursor(value['cursor']))
            and ('limit' not in value or _valid_limit(value['limit'])))
    if path == '/admin/users/get':
        return _valid_uuid(value.get('user_id'))
    if path == '/admin/users/roles/set':
        revision = value.get('expected_revision')
        return (_valid_uuid(value.get('user_id'))
                and _valid_roles(value.get('roles'))
                and type(revision) is int and 0 <= revision <= _MAX_SAFE_INTEGER
                and _valid_reason(value.get('reason')))
    if path == '/admin/users/status/set':
        revision = value.get('expected_revision')
        return (_valid_uuid(value.get('user_id'))
                and isinstance(value.get('disabled'), bool)
                and type(revision) is int and 0 <= revision <= _MAX_SAFE_INTEGER
                and _valid_reason(value.get('reason')))
    if path == '/admin/audit/list':
        since = _parse_timestamp(value['since']) if 'since' in value else None
        until = _parse_timestamp(value['until']) if 'until' in value else None
        return (
            ('target_user_id' not in value or _valid_uuid(value['target_user_id']))
            and ('actor_id' not in value or _valid_uuid(value['actor_id']))
            and ('operation' not in value or (
                isinstance(value['operation'], str) and value['operation'] in _AUDIT_OPERATIONS))
            and ('since' not in value or since is not None)
            and ('until' not in value or until is not None)
            and (since is None or until is None or since <= until)
            and ('cursor' not in value or _valid_cursor(value['cursor']))
            and ('limit' not in value or _valid_limit(value['limit'])))
    if path in ('/projects/list', '/auth/logout', '/auth/me', '/files/browse', '/files/upload/finish'):
        if path == '/files/upload/finish':
            return _valid_uuid(value.get('upload_id'))
        return True
    if path in ('/projects/create', '/projects/update'):
        if path == '/projects/create' and not {'name', 'brief_text'}.issubset(value):
            return False
        if path == '/projects/update' and not ({'name', 'brief_text'} & set(value)):
            return False
        if 'project_id' in value and not _valid_uuid(value['project_id']):
            return False
        if 'name' in value and not _valid_text(value['name'], max_chars=200, max_bytes=800):
            return False
        if 'brief_text' in value and not _valid_text(value['brief_text'], max_chars=8192, max_bytes=8192, allow_empty=True):
            return False
        return True
    if path == '/projects/brief/save':
        field = value.get('field')
        return (isinstance(field, str) and field in _BRIEF_FIELDS
                and _valid_uuid(value.get('project_id'))
                and _valid_text(value.get('text'), max_chars=8192, max_bytes=8192, allow_empty=True)
                and _valid_text(value.get('expected_text'), max_chars=8192, max_bytes=8192, allow_empty=True)
                and ('source_message_id' not in value or _valid_uuid(value['source_message_id'])))
    if path in ('/projects/delete', '/chats/list', '/files/list', '/todos/list'):
        return _valid_uuid(value.get('project_id'))
    if path == '/chats/create':
        return (_valid_uuid(value.get('project_id')) and
                ('title' not in value or _valid_text(value['title'], max_chars=200, max_bytes=800)))
    if path == '/chats/update':
        if not _valid_uuid(value.get('chat_id')) or not ({'title', 'mode', 'pinned'} & set(value)):
            return False
        if 'title' in value and not _valid_text(value['title'], max_chars=200, max_bytes=800):
            return False
        if 'mode' in value and value['mode'] not in ('auto', 'technical'):
            return False
        if 'pinned' in value and not _valid_ids(value['pinned'], maximum=20):
            return False
        return True
    if path in ('/chats/delete', '/messages/list'):
        return _valid_uuid(value.get('chat_id'))
    if path == '/todos/create':
        return (_valid_uuid(value.get('project_id'))
                and _valid_text(value.get('text'), max_chars=2000, max_bytes=8000)
                and ('source_message_id' not in value or _valid_uuid(value['source_message_id'])))
    if path == '/todos/update':
        if not _valid_uuid(value.get('todo_id')) or not ({'text', 'completed'} & set(value)):
            return False
        if 'text' in value and not _valid_text(value['text'], max_chars=2000, max_bytes=8000):
            return False
        return 'completed' not in value or isinstance(value['completed'], bool)
    if path == '/todos/delete':
        return _valid_uuid(value.get('todo_id'))
    if path == '/files/delete':
        return _valid_uuid(value.get('file_id'))
    if path == '/files/attach':
        return _valid_uuid(value.get('project_id')) and _valid_uuid(value.get('file_id'))
    if path == '/files/upload/start':
        if not _valid_uuid(value.get('project_id')) or not _valid_text(value.get('name'), max_chars=200, max_bytes=800):
            return False
        if '/' in value['name'] or '\\' in value['name']:
            return False
        try:
            extractors.classify(value['name'])
        except extractors.UnsupportedFormat:
            return 'unsupported_type'
        mime = value.get('mime')
        if not isinstance(mime, str) or len(mime) > 100 or '\x00' in mime:
            return False
        size = value.get('size_bytes')
        return (type(size) is int and 0 <= size <= MAX_NEW_FILE_SIZE and
                isinstance(value.get('sha256'), str) and _SHA256.fullmatch(value['sha256']) is not None)
    if path == '/files/upload/chunk':
        if not _valid_uuid(value.get('upload_id')) or type(value.get('index')) is not int or not 0 <= value['index'] < MAX_NEW_FILE_SIZE // MAX_CHUNK_BYTES:
            return False
        encoded = value.get('data_b64')
        if not isinstance(encoded, str) or not encoded or len(encoded) > 4 * ((MAX_CHUNK_BYTES + 2) // 3):
            return False
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error):
            return False
        return 0 < len(data) <= MAX_CHUNK_BYTES
    if path == '/ask':
        return (_valid_uuid(value.get('chat_id'))
                and _valid_text(value.get('question'), max_chars=4000, max_bytes=8 * 1024)
                and _valid_ids(value.get('mentions'), maximum=10)
                and value.get('route_mode') in ('auto', 'technical'))
    return False


def _valid_identity(value):
    return (isinstance(value, dict)
            and set(value) == {'id', 'login', 'display_name', 'roles'}
            and _valid_uuid(value.get('id'))
            and _valid_text(value.get('login'), max_chars=254, max_bytes=254)
            and _valid_display_name(value.get('display_name'))
            and _valid_roles(value.get('roles')))


def _valid_login_result(value):
    return (isinstance(value, dict)
            and set(value) == {'id', 'login', 'display_name', 'roles', 'token', 'expires_at'}
            and _valid_identity({key: value.get(key) for key in ('id', 'login', 'display_name', 'roles')})
            and _valid_text(value.get('token'), max_chars=256, max_bytes=256)
            and _valid_timestamp(value.get('expires_at')))


def _valid_revision(value):
    return type(value) is int and 0 <= value <= _MAX_SAFE_INTEGER


def _valid_user_state(value):
    return (isinstance(value, dict)
            and set(value) == {'roles', 'disabled_at', 'revision'}
            and _valid_roles(value.get('roles'))
            and (value.get('disabled_at') is None or _valid_timestamp(value.get('disabled_at')))
            and _valid_revision(value.get('revision')))


def _valid_admin_user(value):
    return (isinstance(value, dict)
            and set(value) == {
                'id', 'login', 'display_name', 'roles', 'email', 'created_at',
                'disabled_at', 'revision'}
            and _valid_uuid(value.get('id'))
            and _valid_text(value.get('login'), max_chars=254, max_bytes=254)
            and _valid_display_name(value.get('display_name'))
            and _valid_roles(value.get('roles'))
            and (value.get('email') is None or _valid_text(
                value.get('email'), max_chars=254, max_bytes=254))
            and _valid_timestamp(value.get('created_at'))
            and (value.get('disabled_at') is None or _valid_timestamp(value.get('disabled_at')))
            and _valid_revision(value.get('revision')))


def _valid_audit_entry(value):
    return (isinstance(value, dict)
            and set(value) == {
                'id', 'created_at', 'actor_kind', 'actor_id', 'actor_label', 'operation',
                'target_user_id', 'before', 'after', 'reason'}
            and _valid_uuid(value.get('id'))
            and _valid_timestamp(value.get('created_at'))
            and value.get('actor_kind') in ('user', 'operator')
            and (value.get('actor_id') is None or _valid_uuid(value.get('actor_id')))
            and (value.get('actor_label') is None or _valid_text(
                value.get('actor_label'), max_chars=254, max_bytes=1016))
            and isinstance(value.get('operation'), str)
            and value.get('operation') in _AUDIT_OPERATIONS
            and _valid_uuid(value.get('target_user_id'))
            and _valid_user_state(value.get('before'))
            and _valid_user_state(value.get('after'))
            and _valid_reason(value.get('reason')))


def _valid_page(value, *, item_validator, limit):
    return (isinstance(value, dict) and set(value) == {'items', 'next_cursor'}
            and isinstance(value.get('items'), list) and len(value['items']) <= limit
            and all(item_validator(item) for item in value['items'])
            and (value.get('next_cursor') is None or _valid_cursor(value['next_cursor'])))


def _valid_billing_snapshot(value):
    return (isinstance(value, dict)
            and set(value) == {'environment', 'plan', 'expires_at', 'verified_at'}
            and value.get('environment') == 'sandbox'
            and value.get('plan') in ('free', 'pro', 'ultra_pro', 'max')
            and (value.get('expires_at') is None or _valid_timestamp(value.get('expires_at')))
            and (value.get('verified_at') is None or _valid_timestamp(value.get('verified_at')))
            and ((value.get('plan') == 'free' and value.get('expires_at') is None)
                 or (value.get('plan') != 'free' and value.get('expires_at') is not None)))


def _valid_operation_response(path, result, value):
    if path in ('/billing/status', '/billing/sync'):
        return _valid_billing_snapshot(result)
    if path == '/revenuecat-webhook':
        return isinstance(result, dict) and set(result) == {'accepted'} and result.get('accepted') is True
    if path in ('/auth/me', '/account/profile/update'):
        return _valid_identity(result)
    if path == '/auth/email/consume':
        return _valid_login_result(result)
    if path == '/admin/users/list':
        return _valid_page(
            result, item_validator=_valid_admin_user, limit=value.get('limit', 50))
    if path in ('/admin/users/get', '/admin/users/roles/set', '/admin/users/status/set'):
        return _valid_admin_user(result)
    if path == '/admin/audit/list':
        return _valid_page(
            result, item_validator=_valid_audit_entry, limit=value.get('limit', 50))
    return True


class _LoginLimiter:
    """Bound failed login attempts by a keyed login digest and client bucket."""
    def __init__(self):
        self._lock = threading.Lock()
        self._failures = {}
        self._inflight = {}

    def _prune(self, key, now):
        failures = self._failures.get(key)
        if failures is not None:
            while failures and now - failures[0] >= _LOGIN_WINDOW_SECONDS:
                failures.popleft()
            if not failures:
                self._failures.pop(key, None)
                failures = None
        return failures

    def begin(self, login_digest, client_bucket):
        now = time.monotonic()
        keys = (('login', login_digest), ('client', client_bucket))
        with self._lock:
            for key in keys:
                failures = self._prune(key, now)
                if len(failures or ()) + self._inflight.get(key, 0) >= _MAX_LOGIN_FAILURES:
                    return None
            for key in keys:
                self._inflight[key] = self._inflight.get(key, 0) + 1
        return keys

    def finish(self, keys, *, failed):
        now = time.monotonic()
        with self._lock:
            for key in keys:
                pending = self._inflight.get(key, 0) - 1
                if pending > 0:
                    self._inflight[key] = pending
                else:
                    self._inflight.pop(key, None)
                if failed:
                    self._failures.setdefault(key, deque()).append(now)
                self._prune(key, now)


_LOGIN_LIMITER = _LoginLimiter()

class _BillingSyncLimiter:
    """Throttle provider refreshes by authenticated account, not caller-supplied IDs."""
    def __init__(self):
        self._lock = threading.Lock()
        self._last = {}

    def admit(self, user_id):
        now = time.monotonic()
        with self._lock:
            for stale_id, last in tuple(self._last.items()):
                if now - last >= 60:
                    self._last.pop(stale_id, None)
            previous = self._last.get(user_id)
            if previous is not None and now - previous < 15:
                return False
            if previous is None and len(self._last) >= 10000:
                return False
            self._last[user_id] = now
            return True


_BILLING_SYNC_LIMITER = _BillingSyncLimiter()


@contextmanager
def _connection():
    conn = appstore.connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _user_ref(user_id):
    key = _key_bytes(os.environ.get('SEVERUS_RAG_BRIDGE_HMAC_KEY', ''))
    return hmac.new(key, str(user_id).encode('utf-8'), hashlib.sha256).hexdigest()


def _json_default(value):
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    raise TypeError('response contains a non-JSON value')


def _error_class(error):
    if isinstance(error, muse.Unavailable):
        return 'provider_unavailable'
    if isinstance(error, retrieval.RetrievalUnavailable):
        return 'retrieval_unavailable'
    if isinstance(error, retrieval.RetrievalBusy):
        return 'retrieval_busy'
    if isinstance(error, orchestrator.DeadlineExceeded):
        return 'turn_deadline'
    if isinstance(error, muse.ProviderTimeout):
        return 'provider_timeout'
    if isinstance(error, TimeoutError):
        return 'timeout'
    if isinstance(error, muse.AmbiguousOutcome):
        return 'provider_ambiguous'
    if isinstance(error, muse.ProviderError):
        return 'provider_error'
    return 'internal_error'


def _provider_status(error):
    status = getattr(error, 'http_status', None)
    return status if type(status) is int and 100 <= status <= 599 else None


def _log(status, started, *, request_id, op, user_ref, route=None, last_stage='accepted', code=None,
         error_class=None, result=None, provider_status=None, client_disconnected=False, error=None):
    entry = {'event': 'public_rag_chat', 'op': op,
             'request_id': request_id if _valid_request_id(request_id) else None,
             'user_ref': user_ref[:16] if isinstance(user_ref, str) else None,
             'route': route if route in ('general', 'technical') else None,
             'last_stage': last_stage if last_stage in (
                 'accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'searching', 'answering', 'result')
             else 'accepted',
             'code': code, 'status': status,
             'elapsed_ms': max(0, int((time.monotonic() - started) * 1000)),
             'error_class': error_class}
    if provider_status is not None:
        entry['provider_status'] = provider_status
    if result is not None:
        entry.update(prompt_tokens=result['usage']['prompt_tokens'],
                     completion_tokens=result['usage']['completion_tokens'])
    if client_disconnected:
        entry['client_disconnected'] = True
    if error is not None and error_class == 'internal_error':
        # Class name only (never the message): internal_error alone hid two production causes.
        entry['error_type'] = type(error).__module__ + '.' + type(error).__qualname__
    print(json.dumps(entry, separators=(',', ':')), file=sys.stderr, flush=True)


class _NDJSONStream:
    def __init__(self, handler, *, route_mode):
        self.handler = handler
        self.route_mode = route_mode
        self.bytes_sent = 0
        self.phase = 0
        self.route = None
        self.last_stage = 'accepted'
        self.terminal = False
        self.disconnected = False
        self.reading_files = False

    def start(self):
        try:
            self.handler.send_response(200)
            self.handler.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
            self.handler.send_header('Cache-Control', 'no-store')
            self.handler.send_header('X-Content-Type-Options', 'nosniff')
            self.handler.send_header('Connection', 'close')
            self.handler.end_headers()
            self.handler.wfile.flush()
            self.handler.close_connection = True
        except OSError:
            self.disconnected = True
        self._write({'type': 'progress', 'stage': 'accepted'})
        self.phase = 1

    def _write(self, event, *, terminal=False):
        if self.terminal:
            raise ValueError('stream already has a terminal event')
        raw = json.dumps(event, ensure_ascii=False, separators=(',', ':')).encode('utf-8') + b'\n'
        if self.bytes_sent + len(raw) > STREAM_LIMIT:
            raise ValueError('NDJSON stream exceeds its byte limit')
        if not self.disconnected:
            try:
                self.handler.wfile.write(raw)
                self.handler.wfile.flush()
            except OSError:
                self.disconnected = True
        self.bytes_sent += len(raw)
        if terminal:
            self.terminal = True

    def progress(self, event):
        if not isinstance(event, dict) or event.get('type') != 'progress':
            raise ValueError('progress callback returned an invalid event')
        stage = event.get('stage')
        if stage == 'classifying' and set(event) == {'type', 'stage'} and self.phase == 1:
            next_phase = 2
        elif stage == 'classified' and set(event) == {'type', 'stage', 'route'} and self.phase == 2 \
                and event.get('route') in ('general', 'technical') \
                and (self.route_mode != 'technical' or event.get('route') == 'technical'):
            self.route = event['route']
            next_phase = 3
        elif stage == 'project_context' and set(event) == {'type', 'stage', 'available'} and self.phase == 3 \
                and type(event.get('available')) is bool:
            next_phase = 4
        elif stage == 'reading_files' and set(event) == {'type', 'stage', 'count'} and self.phase == 4 \
                and not self.reading_files and type(event.get('count')) is int and 1 <= event['count'] <= 200:
            self.reading_files = True
            next_phase = 4
        elif stage == 'searching' and set(event) == {'type', 'stage', 'queries'} and self.phase == 4 \
                and self.route == 'technical' and _valid_queries(event.get('queries')):
            next_phase = 5
        elif stage == 'answering' and set(event) == {'type', 'stage'} \
                and ((self.route == 'general' and self.phase == 4)
                     or (self.route == 'technical' and self.phase == 5)):
            next_phase = 6
        else:
            raise ValueError('progress callback violated the event sequence')
        self._write(event)
        self.phase = next_phase
        self.last_stage = stage

    def result(self, value, request_id):
        if self.phase != 6 or value.get('route') != self.route \
                or (self.route_mode == 'technical' and value.get('route') != 'technical') \
                or not _valid_response(value, request_id):
            raise ValueError('orchestrator result is invalid')
        self._write({'type': 'result', 'data': value}, terminal=True)
        self.last_stage = 'result'

    def error(self, code):
        if code not in ERROR_TEXTS:
            code = 'service_error'
        self._write({'type': 'error', 'code': code, 'error': ERROR_TEXTS[code]}, terminal=True)


def _valid_queries(value):
    return (isinstance(value, list) and 1 <= len(value) <= 2
            and all(_valid_text(query, max_chars=256, max_bytes=1024)
                    and not _PRIVATE_QUERY_ID.search(query) and not _PRIVATE_QUERY_PATH.search(query)
                    for query in value))


def _valid_response(value, request_id):
    keys = {'request_id', 'message_id', 'route', 'answer', 'recommendations', 'unknowns',
            'follow_up_questions', 'model', 'usage'}
    if not isinstance(value, dict) or set(value) != keys or value.get('request_id') != request_id:
        return False
    if not _valid_uuid(value.get('message_id')) or value.get('route') not in ('general', 'technical'):
        return False
    answer = value.get('answer')
    if not _valid_text(answer, max_chars=8000, max_bytes=12 * 1024) or _MARKER.search(answer):
        return False
    for name in ('recommendations', 'unknowns'):
        items = value.get(name)
        if not isinstance(items, list) or len(items) > 10:
            return False
        if any(not _valid_text(item, max_chars=512, max_bytes=512) or _MARKER.search(item) for item in items):
            return False
    follow_ups = value.get('follow_up_questions')
    if not isinstance(follow_ups, dict) or set(follow_ups) != {'general', 'technical'}:
        return False
    for category in ('general', 'technical'):
        questions = follow_ups[category]
        if not isinstance(questions, list) or len(questions) > 3:
            return False
        if any(not _valid_text(question, max_chars=300, max_bytes=512) or _MARKER.search(question)
               for question in questions):
            return False
    usage = value.get('usage')
    if not isinstance(usage, dict) or set(usage) != {'prompt_tokens', 'completion_tokens'}:
        return False
    if any(type(usage.get(key)) is not int or usage[key] < 0 for key in ('prompt_tokens', 'completion_tokens')):
        return False
    if usage['prompt_tokens'] > MAX_PROMPT_TOKENS or usage['completion_tokens'] > MAX_COMPLETION_TOKENS:
        return False
    return value.get('model') == muse.MODEL


def _json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), default=_json_default).encode('utf-8')


def _error_payload(status, code):
    return {'code': code, 'error': _HTTP_ERRORS.get(code, 'The request could not be completed.')}


def _resolve_user(token):
    with _connection() as conn:
        return appstore.resolve_session(conn, token)


def _login(value):
    key = _key_bytes(os.environ.get('SEVERUS_RAG_BRIDGE_HMAC_KEY', ''))
    login_digest = hmac.new(key, value['login'].strip().lower().encode('utf-8'), hashlib.sha256).hexdigest()
    reservation = _LOGIN_LIMITER.begin(login_digest, value['client_bucket'])
    if reservation is None:
        return 429, _error_payload(429, 'quota_exceeded'), None
    failed = False
    try:
        with _connection() as conn:
            user = appstore.authenticate(conn, value['login'], value['password'])
            if user is None:
                failed = True
                return 401, _error_payload(401, 'unauthorized'), None
            token, expires_at = appstore.create_session(conn, user['id'])
            identity = appstore.account_identity(conn, user['id'])
        return 200, {'data': {**identity, 'token': token, 'expires_at': expires_at}}, identity
    finally:
        _LOGIN_LIMITER.finish(reservation, failed=failed)

def _email_auth_operation(path, value):
    with _connection() as conn:
        if path == '/auth/email/request':
            return emailauth.request_link(conn, value['email'], value['client_bucket'],
                                          value['return_to'])
        if path == '/auth/email/prepare':
            return emailauth.prepare_link(conn, value['token'])
        if path == '/auth/email/consume':
            return emailauth.consume_link(conn, value['token'])
    raise ValueError('unhandled email auth operation')



def _billing_operation(path, user_id):
    if path == '/billing/status':
        with _connection() as conn:
            return billing.status(conn, user_id)
    if path == '/billing/sync':
        return billing.sync_user(user_id)
    raise ValueError('unhandled billing operation')


def _revenuecat_webhook_operation(payload):
    billing.process_webhook(payload)
    return {'accepted': True}


def _store_operation(path, value, user_id, user):
    with _connection() as conn:
        if path == '/auth/logout':
            appstore.revoke_session(conn, value['session_token'])
            return {}
        if path == '/auth/me':
            return appstore.account_identity(conn, user_id)
        if path == '/account/profile/update':
            return appstore.update_account_profile(conn, user_id, value['display_name'])
        if path == '/projects/list':
            return appstore.list_projects(conn, user_id)
        if path == '/projects/create':
            return appstore.create_project(conn, user_id, value['name'], brief_text=value['brief_text'])
        if path == '/projects/update':
            return appstore.update_project(conn, user_id, value['project_id'],
                                           name=value.get('name'), brief_text=value.get('brief_text'))
        if path == '/projects/brief/save':
            return appstore.save_project_brief(
                conn, user_id, value['project_id'], value['field'], value['text'], value['expected_text'],
                source_message_id=value.get('source_message_id'))
        if path == '/projects/delete':
            appstore.delete_project(conn, user_id, value['project_id'])
            return {}
        if path == '/chats/list':
            return appstore.list_chats(conn, user_id, value['project_id'])
        if path == '/chats/create':
            return appstore.create_chat(conn, user_id, value['project_id'], title=value.get('title', 'New chat'))
        if path == '/chats/update':
            return appstore.update_chat(conn, user_id, value['chat_id'], title=value.get('title'),
                                        mode=value.get('mode'), pinned=value.get('pinned'))
        if path == '/chats/delete':
            appstore.delete_chat(conn, user_id, value['chat_id'])
            return {}
        if path == '/messages/list':
            return appstore.list_messages(conn, user_id, value['chat_id'])
        if path == '/todos/list':
            return appstore.list_todos(conn, user_id, value['project_id'])
        if path == '/todos/create':
            return appstore.create_todo(conn, user_id, value['project_id'], value['text'],
                                        source_message_id=value.get('source_message_id'))
        if path == '/todos/update':
            return appstore.update_todo(conn, user_id, value['todo_id'], text=value.get('text'),
                                        completed=value.get('completed'))
        if path == '/todos/delete':
            return appstore.delete_todo(conn, user_id, value['todo_id'])
        if path == '/files/list':
            return appstore.list_files(conn, user_id, value['project_id'])
        if path == '/files/delete':
            appstore.delete_file(conn, user_id, value['file_id'])
            return {}
        if path == '/files/browse':
            return appstore.browse_files(conn, user_id)
        if path == '/files/attach':
            return appstore.attach_file(conn, user_id, value['project_id'], value['file_id'])
        if path == '/files/upload/start':
            return appstore.start_upload(conn, user_id, value['project_id'], value['name'], value['mime'],
                                         value['size_bytes'], value['sha256'])
        if path == '/files/upload/chunk':
            data = base64.b64decode(value['data_b64'], validate=True)
            appstore.put_chunk(conn, user_id, value['upload_id'], value['index'], data)
            return {}
        if path == '/files/upload/finish':
            return appstore.finish_upload(conn, user_id, value['upload_id'])
    raise ValueError('unhandled bridge operation')


def _admin_operation(path, value):
    session_token = value['session_token']
    with _connection() as conn:
        if path == '/admin/users/list':
            return adminstore.list_users(
                conn, session_token, query=value.get('query', ''), role=value.get('role'),
                status=value.get('status'), cursor=value.get('cursor'), limit=value.get('limit', 50))
        if path == '/admin/users/get':
            return adminstore.get_user(conn, session_token, value['user_id'])
        if path == '/admin/users/roles/set':
            return adminstore.set_roles(
                conn, session_token, value['user_id'], value['roles'],
                value['expected_revision'], value['reason'])
        if path == '/admin/users/status/set':
            return adminstore.set_status(
                conn, session_token, value['user_id'], value['disabled'],
                value['expected_revision'], value['reason'])
        if path == '/admin/audit/list':
            return adminstore.list_audit(
                conn, session_token, target_user_id=value.get('target_user_id'),
                actor_id=value.get('actor_id'), operation=value.get('operation'),
                since=value.get('since'), until=value.get('until'),
                cursor=value.get('cursor'), limit=value.get('limit', 50))
    raise ValueError('unhandled admin operation')


def _finish_error(stream, code):
    if stream.terminal:
        return
    try:
        stream.error(code)
    except OSError:
        pass


def create_server(host='127.0.0.1', port=8765):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'PublicRagChat/3'
        sys_version = ''

        def log_message(self, *_args):
            return

        def _respond(self, status, payload):
            raw = _json_text(payload)
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except OSError:
                pass

        def _fail(self, status, code):
            self._respond(status, _error_payload(status, code))

        def do_GET(self):
            self._fail(405, 'invalid_request')

        def do_POST(self):
            signed_path = self.path
            if not signed_path.startswith(PATH + '/'):
                return self._fail(404, 'not_found')
            path = signed_path[len(PATH):]
            if path not in _OPERATION_NAMES:
                return self._fail(404, 'not_found')
            if self.headers.get('Transfer-Encoding') is not None:
                return self._fail(400, 'invalid_request')
            raw_length = self.headers.get('Content-Length')
            try:
                length = int(raw_length) if raw_length is not None and raw_length.strip() == raw_length else -1
            except (TypeError, ValueError):
                length = -1
            if length < 0:
                return self._fail(400, 'invalid_request')
            if path == '/files/upload/chunk':
                limit = UPLOAD_BODY_LIMIT
            elif path == '/projects/brief/save':
                limit = BRIEF_BODY_LIMIT
            elif path == '/revenuecat-webhook':
                limit = WEBHOOK_BODY_LIMIT
            else:
                limit = BODY_LIMIT
            if length > limit:
                return self._fail(413, 'request_too_large')
            if self.headers.get('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/json':
                return self._fail(400, 'invalid_request')
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self._fail(400, 'invalid_request')
            try:
                value = json.loads(raw.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                return self._fail(400, 'invalid_request')
            if not isinstance(value, dict):
                return self._fail(400, 'invalid_request')
            timestamp = self.headers.get('X-RAG-Timestamp', '')
            nonce = self.headers.get('X-RAG-Nonce', '')
            signature = self.headers.get('X-RAG-Signature', '')
            if not verify(os.environ.get('SEVERUS_RAG_BRIDGE_HMAC_KEY', ''), 'POST', signed_path,
                          timestamp, nonce, raw, signature):
                return self._fail(401, 'unauthorized')
            if path != '/revenuecat-webhook' and path != '/auth/login' and path not in _EMAIL_AUTH_PATHS and (
                    not _valid_text(value.get('session_token'), max_chars=256, max_bytes=256)):
                return self._fail(401, 'unauthorized')
            valid = _validate_body(path, value)
            if valid == 'unsupported_type':
                return self._fail(400, 'unsupported_type')
            if not valid:
                return self._fail(400, 'invalid_request')

            started = time.monotonic()
            request_id = value['request_id']
            op = _OPERATION_NAMES[path]
            user = None
            user_ref = None
            status = 200
            code = None
            error_class = None
            failure = None
            try:
                if path == '/auth/login':
                    state.admit_signed_request(request_id, nonce)
                    status, payload, user = _login(value)
                    user_ref = _user_ref(user['id']) if user else None
                    if status == 200 and not _valid_login_result(payload.get('data')):
                        status, code, error_class = 502, 'invalid_response', 'invalid_response'
                        payload = _error_payload(status, code)
                    else:
                        code = payload.get('code')
                        if status != 200:
                            error_class = 'authentication_failed' if status == 401 else 'login_rate_limited'
                    self._respond(status, payload)
                    _log(status, started, request_id=request_id, op=op, user_ref=user_ref,
                         code=code, error_class=error_class)
                    return

                if path in _EMAIL_AUTH_PATHS:
                    state.admit_signed_request(request_id, nonce)
                    result = _email_auth_operation(path, value)
                    status = 200
                    if path == '/auth/email/consume' and not _valid_login_result(result):
                        status = 502
                        code, error_class = 'invalid_response', 'invalid_response'
                        payload = _error_payload(status, code)
                    else:
                        code = None
                        error_class = None
                        payload = {'data': result}
                    self._respond(status, payload)
                    _log(status, started, request_id=request_id, op=op, user_ref=None,
                         code=code, error_class=error_class)
                    return

                if path == '/revenuecat-webhook':
                    state.admit_signed_request(request_id, nonce)
                    result = _revenuecat_webhook_operation(value['payload'])
                    if not _valid_operation_response(path, result, value):
                        status, code, error_class = 502, 'invalid_response', 'invalid_response'
                        self._fail(status, code)
                    else:
                        self._respond(200, {'data': result})
                    _log(status, started, request_id=request_id, op=op, user_ref=None,
                         code=code, error_class=error_class)
                    return

                user = _resolve_user(value['session_token'])
                if user is None:
                    status, code, error_class = 401, 'unauthorized', 'authentication_failed'
                    self._fail(status, code)
                    _log(status, started, request_id=request_id, op=op, user_ref=None,
                         code=code, error_class=error_class)
                    return
                user_ref = _user_ref(user['id'])

                if path == '/ask':
                    state.admit_ask(user_ref, request_id, nonce)
                    prepared = orchestrator.prepare_ask(user['id'], value['chat_id'], value['question'],
                                                        mentions=value['mentions'])
                    stream = _NDJSONStream(self, route_mode=value['route_mode'])
                    try:
                        stream.start()
                        result = orchestrator.ask(prepared, value['question'], request_id=request_id,
                                                 route_mode=value['route_mode'], on_progress=stream.progress)
                        stream.result(result, request_id)
                        _log(200, started, request_id=request_id, op=op, user_ref=user_ref, route=stream.route,
                             last_stage=stream.last_stage, result=result, client_disconnected=stream.disconnected)
                    except _UNAVAILABLE as error:
                        _finish_error(stream, 'service_unavailable')
                        _log(503, started, request_id=request_id, op=op, user_ref=user_ref, route=stream.route,
                             last_stage=stream.last_stage, code='service_unavailable',
                             error_class=_error_class(error), provider_status=_provider_status(error),
                             client_disconnected=stream.disconnected)
                    except _TIMEOUTS as error:
                        _finish_error(stream, 'timeout')
                        _log(504, started, request_id=request_id, op=op, user_ref=user_ref, route=stream.route,
                             last_stage=stream.last_stage, code='timeout', error_class=_error_class(error),
                             provider_status=_provider_status(error), client_disconnected=stream.disconnected)
                    except Exception as error:
                        _finish_error(stream, 'service_error')
                        _log(502, started, request_id=request_id, op=op, user_ref=user_ref, route=stream.route,
                             last_stage=stream.last_stage, code='service_error',
                             error_class=_error_class(error), provider_status=_provider_status(error),
                             client_disconnected=stream.disconnected, error=error)
                    return

                state.admit_signed_request(request_id, nonce)
                if path == '/billing/sync' and not _BILLING_SYNC_LIMITER.admit(user['id']):
                    raise state.QuotaExceeded()
                if path in _ADMIN_PATHS:
                    result = _admin_operation(path, value)
                elif path in ('/billing/status', '/billing/sync'):
                    result = _billing_operation(path, user['id'])
                else:
                    result = _store_operation(path, value, user['id'], user)
                if not _valid_operation_response(path, result, value):
                    status, code, error_class = 502, 'invalid_response', 'invalid_response'
                    self._fail(status, code)
                else:
                    self._respond(200, {'data': result})
            except state.ReplayDetected:
                status, code, error_class = 409, 'replayed_request', 'replay_detected'
                self._fail(status, code)
            except state.DuplicateRequest:
                status, code, error_class = 409, 'duplicate_request', 'duplicate_request'
                self._fail(status, code)
            except state.QuotaExceeded:
                status, code, error_class = 429, 'quota_exceeded', 'quota_exceeded'
                self._fail(status, code)
            except adminstore.AdminError as error:
                mapping = {
                    'unauthorized': (401, 'unauthorized', 'authentication_failed'),
                    'forbidden': (403, 'forbidden', 'authorization_failed'),
                    'stale_user': (409, 'stale_user', 'stale_user'),
                    'self_protection': (409, 'self_protection', 'self_protection'),
                    'last_admin': (409, 'last_admin', 'last_admin'),
                    'conflict': (409, 'conflict', 'conflict'),
                    'already_bootstrapped': (409, 'conflict', 'conflict'),
                    'invalid_request': (400, 'invalid_request', 'invalid_request'),
                }
                mapped = mapping.get(error.code) if isinstance(error.code, str) else None
                if mapped is None:
                    status, code, error_class, failure = (
                        503, 'service_unavailable', 'internal_error', error)
                else:
                    status, code, error_class = mapped
                self._fail(status, code)
            except appstore.Conflict:
                status, code, error_class = 409, 'conflict', 'compare_and_set_conflict'
                self._fail(status, code)
            except appstore.NotFound:
                status, code, error_class = 404, 'not_found', 'not_found'
                self._fail(status, code)
            except appstore.QuotaExceeded:
                status, code, error_class = 429, 'quota_exceeded', 'quota_exceeded'
                self._fail(status, code)
            except appstore.Invalid as error:
                code = error.code if isinstance(error.code, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,63}', error.code) else 'invalid_request'
                status, error_class = 400, 'invalid_request'
                self._fail(status, code)
            except billing.ConfigurationError as error:
                status, code, error_class, failure = (
                    503, 'service_unavailable', 'billing_configuration', error)
                self._fail(status, code)
            except billing.ProviderError as error:
                status, code, error_class, failure = (
                    503, 'service_unavailable', 'billing_provider', error)
                self._fail(status, code)
            except ValueError as error:
                if path == '/revenuecat-webhook':
                    status, code, error_class = 400, 'invalid_request', 'invalid_request'
                else:
                    status, code, error_class, failure = (
                        503, 'service_unavailable', 'internal_error', error)
                self._fail(status, code)
            except Exception as error:
                status, code, error_class, failure = 503, 'service_unavailable', 'internal_error', error
                self._fail(status, code)
            _log(status, started, request_id=request_id, op=op, user_ref=user_ref,
                 code=code, error_class=error_class, error=failure)

    return _Server((host, port), Handler)


class _Server(ThreadingHTTPServer):
    # The default backlog of 5 overflowed under bursts of concurrent turns (kernel ListenOverflows);
    # the proxy then failed those requests as bridge_error before they reached the bridge.
    request_queue_size = 1024


def main():
    host = os.environ.get('SEVERUS_RAG_BRIDGE_HOST', '127.0.0.1')
    port = int(os.environ.get('SEVERUS_RAG_BRIDGE_PORT', '8765'))
    if host not in ('127.0.0.1', '::1', 'localhost'):
        raise SystemExit('The signed RAG bridge must bind to loopback only.')
    retrieval.context()
    _key_bytes(os.environ.get('SEVERUS_RAG_BRIDGE_HMAC_KEY', ''))
    retrieval.warm_up()
    print(json.dumps({'event': 'public_rag_chat_ready', 'host': host, 'port': port}), file=sys.stderr, flush=True)
    create_server(host, port).serve_forever()


if __name__ == "__main__":
    main()
