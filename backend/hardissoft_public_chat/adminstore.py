"""Session-authorized administration of account roles and status."""
from datetime import datetime

from psycopg.types.json import Jsonb

from . import appstore


ADMIN_LOCK = 5142026110200
_ADMIN_ROLES = frozenset(('admin', 'expert'))
_AUDIT_OPERATIONS = frozenset((
    'admin.users.roles.set', 'admin.users.status.set', 'admin.bootstrap'))
_ADMIN_ERRORS = frozenset((
    'unauthorized', 'forbidden', 'stale_user', 'self_protection',
    'last_admin', 'already_bootstrapped'))

_MAX_SAFE_INTEGER = (1 << 53) - 1


class AdminError(RuntimeError):
    def __init__(self, code):
        if code not in _ADMIN_ERRORS:
            raise ValueError('unknown admin error code')
        self.code = code
        super().__init__(code)


def _lock_membership(conn):
    conn.execute('SELECT pg_advisory_xact_lock(%s)', (ADMIN_LOCK,))


def _admin_user(conn, user_id, *, lock=False):
    query = '''SELECT u.id,COALESCE(u.email,u.login) AS login,u.email,u.display_name,
                      ARRAY(SELECT r.role FROM user_roles r
                            WHERE r.user_id=u.id ORDER BY r.role) AS roles,
                      u.created_at,u.disabled_at,u.admin_revision AS revision
               FROM users u WHERE u.id=%s'''
    if lock:
        query += ' FOR UPDATE OF u'
    row = appstore._execute(conn, query, (user_id,)).fetchone()
    if row is None:
        raise appstore.NotFound()
    return {
        'id': appstore._id(row['id']),
        'login': row['login'],
        'email': row['email'],
        'display_name': row['display_name'],
        'roles': list(row['roles']),
        'created_at': appstore._iso(row['created_at']),
        'disabled_at': appstore._iso(row['disabled_at']),
        'revision': row['revision'],
    }


def _state(user):
    return {
        'roles': list(user['roles']),
        'disabled_at': user['disabled_at'],
        'revision': user['revision'],
    }


def _write_audit(conn, *, actor, operation, target_id, before, after, reason):
    actor_id = appstore._uuid(actor['id']) if actor.get('id') is not None else None
    conn.execute('''INSERT INTO admin_audit
        (actor_kind,actor_id,actor_label,operation,target_user_id,
         before_state,after_state,reason)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s)''',
        (actor['kind'], actor_id, actor.get('label'), operation, target_id,
         Jsonb(before), Jsonb(after), reason))


def _reason(value):
    if not isinstance(value, str):
        raise appstore.Invalid('reason')
    value = value.strip()
    if not 1 <= len(value) <= 500 or '\x00' in value:
        raise appstore.Invalid('reason')
    return value


def _operator(value):
    if not isinstance(value, str):
        raise appstore.Invalid('operator')
    value = value.strip()
    if not 1 <= len(value) <= 128 or '\x00' in value:
        raise appstore.Invalid('operator')
    return value


def _revision(value):
    if (isinstance(value, bool) or not isinstance(value, int) or value < 0
            or value > _MAX_SAFE_INTEGER):
        raise appstore.Invalid('expected_revision')
    return value


def _limit(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 100:
        raise appstore.Invalid('limit')
    return value


def _timestamp(value, code):
    if isinstance(value, datetime):
        result = value
    elif isinstance(value, str):
        try:
            result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            raise appstore.Invalid(code) from None
    else:
        raise appstore.Invalid(code)
    if result.tzinfo is None or result.utcoffset() is None:
        raise appstore.Invalid(code)
    return result


def _cursor(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'at', 'id'}:
        raise appstore.Invalid('cursor')
    at = _timestamp(value['at'], 'cursor')
    user_id = appstore._uuid(value['id'], code='cursor')
    return at, user_id


def _page_size_and_cursor(limit, cursor):
    return _limit(limit), _cursor(cursor)


def _requested_roles(roles):
    if not isinstance(roles, (list, tuple)) or any(not isinstance(role, str) for role in roles):
        raise appstore.Invalid('roles')
    if any(role not in _ADMIN_ROLES for role in roles) or len(set(roles)) != len(roles):
        raise appstore.Invalid('roles')
    return sorted(roles)


def _active_admin_count(conn):
    row = appstore._execute(conn, '''SELECT count(*) AS count FROM users u
        JOIN user_roles r ON r.user_id=u.id
        WHERE r.role='admin' AND u.disabled_at IS NULL''').fetchone()
    return row['count']


def require_admin(conn, session_token):
    identity = appstore.resolve_session(conn, session_token)
    if identity is None:
        raise AdminError('unauthorized')
    if 'admin' not in identity.get('roles', ()):
        raise AdminError('forbidden')
    return identity


def list_users(conn, session_token, *, query='', role=None, status=None,
               cursor=None, limit=50):
    require_admin(conn, session_token)
    limit, cursor = _page_size_and_cursor(limit, cursor)
    if not isinstance(query, str) or len(query) > 254:
        raise appstore.Invalid('query')
    if role is not None and (not isinstance(role, str) or role not in _ADMIN_ROLES):
        raise appstore.Invalid('role')
    if status is not None and (not isinstance(status, str) or status not in ('active', 'disabled')):
        raise appstore.Invalid('status')

    conditions = []
    params = []
    if query:
        escaped = query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        pattern = '%' + escaped + '%'
        conditions.append("(u.login ILIKE %s ESCAPE E'\\\\' OR COALESCE(u.email,'') ILIKE %s ESCAPE E'\\\\')")
        params.extend((pattern, pattern))
    if role is not None:
        conditions.append('EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id=u.id AND r.role=%s)')
        params.append(role)
    if status == 'active':
        conditions.append('u.disabled_at IS NULL')
    elif status == 'disabled':
        conditions.append('u.disabled_at IS NOT NULL')
    if cursor is not None:
        conditions.append('(u.created_at,u.id) < (%s,%s)')
        params.extend(cursor)

    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    rows = appstore._execute(conn, '''SELECT u.id,COALESCE(u.email,u.login) AS login,
            u.email,u.display_name,
            ARRAY(SELECT r.role FROM user_roles r
                  WHERE r.user_id=u.id ORDER BY r.role) AS roles,
            u.created_at,u.disabled_at,u.admin_revision AS revision
        FROM users u''' + where + '''
        ORDER BY u.created_at DESC,u.id DESC LIMIT %s''',
        tuple(params + [limit + 1])).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [{
        'id': appstore._id(row['id']),
        'login': row['login'],
        'email': row['email'],
        'display_name': row['display_name'],
        'roles': list(row['roles']),
        'created_at': appstore._iso(row['created_at']),
        'disabled_at': appstore._iso(row['disabled_at']),
        'revision': row['revision'],
    } for row in rows]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = {'at': appstore._iso(last['created_at']), 'id': appstore._id(last['id'])}
    return {'items': items, 'next_cursor': next_cursor}


def get_user(conn, session_token, user_id):
    require_admin(conn, session_token)
    return _admin_user(conn, appstore._uuid(user_id))


def _check_expected_revision(user, expected_revision):
    if user['revision'] != expected_revision:
        raise AdminError('stale_user')


def set_roles(conn, session_token, user_id, roles, expected_revision, reason):
    _lock_membership(conn)
    actor = require_admin(conn, session_token)
    roles = _requested_roles(roles)
    expected_revision = _revision(expected_revision)
    reason = _reason(reason)
    target_id = appstore._uuid(user_id)
    before_user = _admin_user(conn, target_id, lock=True)
    _check_expected_revision(before_user, expected_revision)
    before = _state(before_user)
    if before_user['id'] == actor['id'] and 'admin' in before_user['roles'] and 'admin' not in roles:
        raise AdminError('self_protection')
    if roles == before_user['roles']:
        return before_user
    if ('admin' in before_user['roles'] and 'admin' not in roles
            and before_user['disabled_at'] is None and _active_admin_count(conn) <= 1):
        raise AdminError('last_admin')

    appstore._execute(conn, 'DELETE FROM user_roles WHERE user_id=%s', (target_id,))
    for role in roles:
        appstore._execute(conn, 'INSERT INTO user_roles(user_id,role) VALUES (%s,%s)',
                          (target_id, role))
    appstore._execute(conn, '''UPDATE users SET admin_revision=admin_revision+1
        WHERE id=%s''', (target_id,))
    after_user = _admin_user(conn, target_id)
    _write_audit(conn, actor={'kind': 'user', 'id': actor['id'], 'label': None},
                 operation='admin.users.roles.set', target_id=target_id,
                 before=before, after=_state(after_user), reason=reason)
    return after_user


def _change_status_locked(conn, actor, target_id, disabled, expected_revision, reason):
    if not isinstance(disabled, bool):
        raise appstore.Invalid('disabled')
    if expected_revision is not None:
        expected_revision = _revision(expected_revision)
    reason = _reason(reason)
    target_id = appstore._uuid(target_id)
    before_user = _admin_user(conn, target_id, lock=True)
    if expected_revision is not None:
        _check_expected_revision(before_user, expected_revision)
    before = _state(before_user)
    is_disabled = before_user['disabled_at'] is not None
    if is_disabled == disabled:
        return before_user
    if (disabled and actor is not None and before_user['id'] == actor['id']):
        raise AdminError('self_protection')
    if (disabled and 'admin' in before_user['roles'] and is_disabled is False
            and _active_admin_count(conn) <= 1):
        raise AdminError('last_admin')

    appstore._execute(conn, '''UPDATE users
        SET disabled_at=CASE WHEN %s THEN COALESCE(disabled_at,now()) ELSE NULL END,
            admin_revision=admin_revision+1
        WHERE id=%s''', (disabled, target_id))
    if disabled:
        appstore._execute(conn, '''UPDATE sessions SET revoked_at=COALESCE(revoked_at,now())
            WHERE user_id=%s''', (target_id,))
    after_user = _admin_user(conn, target_id)
    _write_audit(conn, actor=actor, operation='admin.users.status.set',
                 target_id=target_id, before=before, after=_state(after_user), reason=reason)
    return after_user


def set_status(conn, session_token, user_id, disabled, expected_revision, reason):
    _lock_membership(conn)
    identity = require_admin(conn, session_token)
    actor = {'kind': 'user', 'id': identity['id'], 'label': None}
    return _change_status_locked(conn, actor, user_id, disabled, expected_revision, reason)


def list_audit(conn, session_token, *, target_user_id=None, actor_id=None,
               operation=None, since=None, until=None, cursor=None, limit=50):
    require_admin(conn, session_token)
    limit, cursor = _page_size_and_cursor(limit, cursor)
    conditions = []
    params = []
    if target_user_id is not None:
        conditions.append('target_user_id=%s')
        params.append(appstore._uuid(target_user_id))
    if actor_id is not None:
        conditions.append('actor_id=%s')
        params.append(appstore._uuid(actor_id))
    if operation is not None and (
            not isinstance(operation, str) or operation not in _AUDIT_OPERATIONS):
        raise appstore.Invalid('operation')
    if operation is not None:
        conditions.append('operation=%s')
        params.append(operation)
    if since is not None:
        since = _timestamp(since, 'since')
        conditions.append('created_at >= %s')
        params.append(since)
    if until is not None:
        until = _timestamp(until, 'until')
        conditions.append('created_at <= %s')
        params.append(until)
    if since is not None and until is not None and since > until:
        raise appstore.Invalid('since_until')
    if cursor is not None:
        conditions.append('(created_at,id) < (%s,%s)')
        params.extend(cursor)

    where = ' WHERE ' + ' AND '.join(conditions) if conditions else ''
    rows = appstore._execute(conn, '''SELECT id,created_at,actor_kind,actor_id,actor_label,
            operation,target_user_id,before_state,after_state,reason
        FROM admin_audit''' + where + '''
        ORDER BY created_at DESC,id DESC LIMIT %s''',
        tuple(params + [limit + 1])).fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    items = [{
        'id': appstore._id(row['id']),
        'created_at': appstore._iso(row['created_at']),
        'actor_kind': row['actor_kind'],
        'actor_id': appstore._id(row['actor_id']),
        'actor_label': row['actor_label'],
        'operation': row['operation'],
        'target_user_id': appstore._id(row['target_user_id']),
        'before': row['before_state'],
        'after': row['after_state'],
        'reason': row['reason'],
    } for row in rows]
    next_cursor = None
    if has_more:
        last = rows[-1]
        next_cursor = {'at': appstore._iso(last['created_at']), 'id': appstore._id(last['id'])}
    return {'items': items, 'next_cursor': next_cursor}


def bootstrap_admin(conn, user_id, reason, operator):
    _lock_membership(conn)
    reason = _reason(reason)
    operator = _operator(operator)
    if appstore._execute(conn, "SELECT 1 FROM user_roles WHERE role='admin' LIMIT 1").fetchone():
        raise AdminError('already_bootstrapped')
    target_id = appstore._uuid(user_id)
    before_user = _admin_user(conn, target_id, lock=True)
    if before_user['disabled_at'] is not None:
        raise appstore.NotFound()
    before = _state(before_user)
    appstore._execute(conn, 'INSERT INTO user_roles(user_id,role) VALUES (%s,%s)',
                      (target_id, 'admin'))
    appstore._execute(conn, '''UPDATE users SET admin_revision=admin_revision+1
        WHERE id=%s''', (target_id,))
    after_user = _admin_user(conn, target_id)
    _write_audit(conn, actor={'kind': 'operator', 'id': None, 'label': operator},
                 operation='admin.bootstrap', target_id=target_id,
                 before=before, after=_state(after_user), reason=reason)
    return after_user


def operator_disable(conn, user_id, reason, operator):
    _lock_membership(conn)
    operator = _operator(operator)
    actor = {'kind': 'operator', 'id': None, 'label': operator}
    return _change_status_locked(conn, actor, user_id, True, None, reason)
