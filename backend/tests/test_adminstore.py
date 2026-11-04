import concurrent.futures
import hashlib
import threading

import psycopg
import pytest

from hardissoft_public_chat import adminstore, appstore


PASSWORD = 'correct horse battery staple'
ADMIN_FIELDS = {'id', 'login', 'email', 'display_name', 'roles',
                'created_at', 'disabled_at', 'revision'}
AUDIT_FIELDS = {'id', 'created_at', 'actor_kind', 'actor_id', 'actor_label',
                'operation', 'target_user_id', 'before', 'after', 'reason'}


def _user(conn, login):
    user = appstore.create_user(conn, login, PASSWORD)
    token, _ = appstore.create_session(conn, user['id'])
    return user, token


def _first_admin(conn, login='first-admin'):
    user, token = _user(conn, login)
    adminstore.bootstrap_admin(conn, user['id'], 'Initial administrator', 'test-operator')
    return user, token


def _audit_count(conn):
    return conn.execute('SELECT count(*) FROM admin_audit').fetchone()[0]


def test_existing_session_sees_role_grant_and_revocation_without_losing_workspace(app_db):
    owner, owner_token = _first_admin(app_db, 'owner')
    target, target_token = _user(app_db, 'second-admin')

    promoted = adminstore.set_roles(app_db, owner_token, target['id'], ['admin'], 0,
                                    'Assign admin')
    app_db.commit()

    visible = adminstore.list_users(app_db, target_token)['items']
    assert {user['id'] for user in visible} == {owner['id'], target['id']}
    assert all(set(user) == ADMIN_FIELDS for user in visible)
    assert appstore.resolve_session(app_db, target_token)['roles'] == ['admin']

    adminstore.set_roles(app_db, owner_token, target['id'], [], promoted['revision'],
                         'Remove admin')
    app_db.commit()
    with pytest.raises(adminstore.AdminError) as denied:
        adminstore.list_users(app_db, target_token)
    assert denied.value.code == 'forbidden'
    assert appstore.resolve_session(app_db, target_token)['roles'] == []


def test_invalid_expired_or_revoked_admin_session_is_unauthorized_and_active_nonadmin_forbidden(app_db):
    owner, admin_token = _first_admin(app_db)
    ordinary, ordinary_token = _user(app_db, 'ordinary')

    for token in ('not-a-token', 'missing-session-token'):
        with pytest.raises(adminstore.AdminError) as denied:
            adminstore.require_admin(app_db, token)
        assert denied.value.code == 'unauthorized'

    with pytest.raises(adminstore.AdminError) as forbidden:
        adminstore.get_user(app_db, ordinary_token, ordinary['id'])
    assert forbidden.value.code == 'forbidden'

    appstore.revoke_session(app_db, admin_token)
    with pytest.raises(adminstore.AdminError) as revoked:
        adminstore.require_admin(app_db, admin_token)
    assert revoked.value.code == 'unauthorized'

    expired_token, _ = appstore.create_session(app_db, owner['id'])
    token_hash = hashlib.sha256(expired_token.encode('ascii')).hexdigest()
    app_db.execute('''UPDATE sessions SET expires_at=now()-interval '1 second'
        WHERE token_hash=%s''', (token_hash,))
    with pytest.raises(adminstore.AdminError) as expired:
        adminstore.require_admin(app_db, expired_token)
    assert expired.value.code == 'unauthorized'
    assert appstore.resolve_session(app_db, ordinary_token)['roles'] == []


def test_role_and_status_changes_enforce_self_protection_and_revision(app_db):
    owner, owner_token = _first_admin(app_db)
    peer, peer_token = _user(app_db, 'peer')
    promoted = adminstore.set_roles(app_db, owner_token, peer['id'], ['admin', 'expert'], 0,
                                    'Assign peer roles')
    assert promoted['roles'] == ['admin', 'expert']

    count = _audit_count(app_db)
    with pytest.raises(adminstore.AdminError) as self_demote:
        adminstore.set_roles(app_db, owner_token, owner['id'], ['expert'], 1,
                             'Attempt self-demotion')
    assert self_demote.value.code == 'self_protection'
    with pytest.raises(adminstore.AdminError) as self_disable:
        adminstore.set_status(app_db, owner_token, owner['id'], True, 1,
                              'Attempt self-disable')
    assert self_disable.value.code == 'self_protection'
    assert _audit_count(app_db) == count

    current = adminstore.get_user(app_db, owner_token, peer['id'])
    with pytest.raises(adminstore.AdminError) as stale:
        adminstore.set_roles(app_db, owner_token, peer['id'], ['expert'], 0,
                             'Stale revision')
    assert stale.value.code == 'stale_user'
    assert adminstore.get_user(app_db, owner_token, peer['id']) == current
    assert _audit_count(app_db) == count

    with pytest.raises(appstore.Invalid):
        adminstore.set_roles(app_db, owner_token, peer['id'], ['admin', 'expert'],
                             1 << 53, 'Unsafe revision')

    unchanged = adminstore.set_roles(app_db, owner_token, peer['id'], ['expert', 'admin'],
                                     current['revision'], 'Already current')
    assert unchanged == current
    assert _audit_count(app_db) == count

    unchanged_status = adminstore.set_status(
        app_db, owner_token, peer['id'], False, current['revision'], 'Already active')
    assert unchanged_status == current
    assert _audit_count(app_db) == count

    assert appstore.resolve_session(app_db, peer_token)['roles'] == ['admin', 'expert']



def test_sole_admin_self_demotion_is_self_protection_without_audit(app_db):
    admin, token = _first_admin(app_db, 'sole-admin-self-protection')
    before = adminstore.get_user(app_db, token, admin['id'])
    audit_count = _audit_count(app_db)

    with pytest.raises(adminstore.AdminError) as denied:
        adminstore.set_roles(app_db, token, admin['id'], [], before['revision'],
                             'Attempt sole-admin self-demotion')

    assert denied.value.code == 'self_protection'
    after = adminstore.get_user(app_db, token, admin['id'])
    assert after['roles'] == ['admin']
    assert after['revision'] == before['revision']
    assert _audit_count(app_db) == audit_count


def test_last_active_admin_cannot_be_disabled_by_operator(app_db):
    admin, _ = _first_admin(app_db)
    before = adminstore.get_user(app_db, appstore.create_session(app_db, admin['id'])[0],
                                 admin['id'])
    audit_count = _audit_count(app_db)

    with pytest.raises(adminstore.AdminError) as last_admin:
        adminstore.operator_disable(app_db, admin['id'], 'Remove final admin', 'operator')

    assert last_admin.value.code == 'last_admin'
    assert adminstore.get_user(app_db, appstore.create_session(app_db, admin['id'])[0],
                               admin['id']) == before
    assert _audit_count(app_db) == audit_count


def test_status_reenable_does_not_revive_revoked_sessions_and_disabled_user_is_visible(app_db):
    admin, admin_token = _first_admin(app_db)
    target, target_token = _user(app_db, 'disabled-target')
    disabled = adminstore.set_status(app_db, admin_token, target['id'], True, 0,
                                     'Disable target')
    app_db.commit()
    assert disabled['disabled_at'] is not None
    assert appstore.resolve_session(app_db, target_token) is None
    assert [user['id'] for user in adminstore.list_users(
        app_db, admin_token, status='disabled')['items']] == [target['id']]

    current = adminstore.get_user(app_db, admin_token, target['id'])
    assert current['disabled_at'] is not None
    enabled = adminstore.set_status(app_db, admin_token, target['id'], False,
                                    current['revision'], 'Re-enable target')
    app_db.commit()
    assert enabled['disabled_at'] is None
    assert appstore.resolve_session(app_db, target_token) is None

    fresh_token, _ = appstore.create_session(app_db, target['id'])
    assert appstore.resolve_session(app_db, fresh_token)['id'] == target['id']


def test_mutation_and_audit_are_atomic_when_audit_insert_fails(app_db, monkeypatch):
    owner, owner_token = _first_admin(app_db)
    target, _ = _user(app_db, 'audit-failure-target')
    app_db.commit()
    before = adminstore.get_user(app_db, owner_token, target['id'])
    count = _audit_count(app_db)

    def fail_audit(*args, **kwargs):
        raise RuntimeError('audit insert failed')

    monkeypatch.setattr(adminstore, '_write_audit', fail_audit)
    with pytest.raises(RuntimeError, match='audit insert failed'):
        adminstore.set_roles(app_db, owner_token, target['id'], ['expert'], 0,
                             'Must roll back')
    app_db.rollback()

    after = adminstore.get_user(app_db, owner_token, target['id'])
    assert after['roles'] == before['roles'] == []
    assert after['revision'] == before['revision'] == 0
    assert _audit_count(app_db) == count


def test_user_listing_uses_literal_search_filters_and_nonoverlapping_keyset_pages(app_db):
    _, admin_token = _first_admin(app_db)
    percent, _ = _user(app_db, 'literal-percent')
    underscore, _ = _user(app_db, 'literal-underscore')
    expert, _ = _user(app_db, 'expert-user')
    app_db.execute('UPDATE users SET email=%s WHERE id=%s',
                   ('name%percent@example.test', percent['id']))
    app_db.execute('UPDATE users SET email=%s WHERE id=%s',
                   ('name_under@example.test', underscore['id']))
    adminstore.set_roles(app_db, admin_token, expert['id'], ['expert'], 0, 'Add expert')

    assert [user['id'] for user in adminstore.list_users(
        app_db, admin_token, query='%', limit=100)['items']] == [percent['id']]
    assert [user['id'] for user in adminstore.list_users(
        app_db, admin_token, query='_', limit=100)['items']] == [underscore['id']]
    assert [user['id'] for user in adminstore.list_users(
        app_db, admin_token, role='expert', limit=100)['items']] == [expert['id']]

    expected = [str(row[0]) for row in app_db.execute(
        'SELECT id FROM users ORDER BY created_at DESC,id DESC').fetchall()]
    gathered = []
    cursor = None
    while True:
        page = adminstore.list_users(app_db, admin_token, cursor=cursor, limit=2)
        assert len(page['items']) <= 2
        gathered.extend(user['id'] for user in page['items'])
        cursor = page['next_cursor']
        if cursor is None:
            break
    assert gathered == expected
    assert len(gathered) == len(set(gathered))

    with pytest.raises(appstore.Invalid):
        adminstore.list_users(app_db, admin_token, limit=0)
    with pytest.raises(appstore.Invalid):
        adminstore.list_users(app_db, admin_token, limit=101)


def test_audit_listing_returns_whitelisted_states_and_keyset_pages(app_db):
    owner, owner_token = _first_admin(app_db)
    target, _ = _user(app_db, 'audit-target')
    changed = adminstore.set_roles(app_db, owner_token, target['id'], ['expert'], 0,
                                   'Assign expert')
    adminstore.set_status(app_db, owner_token, target['id'], True, changed['revision'],
                          'Disable expert')

    first = adminstore.list_audit(app_db, owner_token, target_user_id=target['id'], limit=1)
    assert len(first['items']) == 1
    entry = first['items'][0]
    assert set(entry) == AUDIT_FIELDS
    assert set(entry['before']) == {'roles', 'disabled_at', 'revision'}
    assert set(entry['after']) == {'roles', 'disabled_at', 'revision'}
    assert entry['actor_kind'] == 'user'
    assert entry['actor_id'] == owner['id']
    assert entry['actor_label'] is None
    assert entry['reason'] == 'Disable expert'
    assert first['next_cursor'] is not None

    second = adminstore.list_audit(app_db, owner_token, target_user_id=target['id'],
                                   cursor=first['next_cursor'], limit=1)
    assert len(second['items']) == 1
    assert second['items'][0]['id'] != entry['id']
    assert second['next_cursor'] is None
    role_entry = second['items'][0]
    filtered = adminstore.list_audit(
        app_db, owner_token, target_user_id=target['id'], actor_id=owner['id'],
        operation='admin.users.roles.set', since=role_entry['created_at'],
        until=role_entry['created_at'])
    assert [item['id'] for item in filtered['items']] == [role_entry['id']]
    assert {item['operation'] for item in first['items'] + second['items']} == {
        'admin.users.roles.set', 'admin.users.status.set'}


def test_membership_lock_serializes_cross_demotions_and_rechecks_actor_session(app_db):
    first, first_token = _first_admin(app_db, 'race-first')
    second, second_token = _user(app_db, 'race-second')
    promoted = adminstore.set_roles(app_db, first_token, second['id'], ['admin'], 0,
                                    'Second administrator')
    assert promoted['roles'] == ['admin']
    app_db.commit()

    barrier = threading.Barrier(2)

    def remove_other(token, target_id):
        conn = appstore.connect()
        try:
            barrier.wait(timeout=10)
            try:
                adminstore.set_roles(conn, token, target_id, [], 1, 'Concurrent removal')
                conn.commit()
                return 'success'
            except adminstore.AdminError as error:
                conn.rollback()
                return error.code
        finally:
            conn.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(
            lambda args: remove_other(*args),
            ((first_token, second['id']), (second_token, first['id']))))

    assert results.count('success') == 1
    assert results.count('forbidden') == 1
    assert app_db.execute('''SELECT count(*) FROM user_roles r
        JOIN users u ON u.id=r.user_id
        WHERE r.role='admin' AND u.disabled_at IS NULL''').fetchone()[0] == 1


def test_membership_mutation_rejects_session_expired_while_waiting_for_lock(app_db):
    _, owner_token = _first_admin(app_db, 'expiry-lock-admin')
    target, _ = _user(app_db, 'expiry-lock-target')
    app_db.commit()
    audit_count = _audit_count(app_db)
    target_revision = app_db.execute(
        'SELECT admin_revision FROM users WHERE id=%s', (target['id'],)).fetchone()[0]

    guard = appstore.connect()
    transaction_started = threading.Event()
    workers = None

    def mutate_after_start():
        conn = appstore.connect()
        try:
            conn.execute('SELECT now()').fetchone()
            transaction_started.set()
            try:
                adminstore.set_roles(conn, owner_token, target['id'], ['expert'], 0,
                                     'Expired while waiting')
                conn.commit()
                return 'success'
            except adminstore.AdminError as error:
                conn.rollback()
                return error.code
        finally:
            conn.close()

    try:
        guard.execute('SELECT pg_advisory_xact_lock(%s)', (adminstore.ADMIN_LOCK,))
        workers = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = workers.submit(mutate_after_start)
        assert transaction_started.wait(timeout=10)
        expiry_conn = appstore.connect()
        try:
            token_hash = hashlib.sha256(owner_token.encode('ascii')).hexdigest()
            expiry_conn.execute('''UPDATE sessions SET expires_at=clock_timestamp()
                WHERE token_hash=%s''', (token_hash,))
            expiry_conn.commit()
        finally:
            expiry_conn.close()
        guard.commit()
        result = future.result(timeout=10)
    finally:
        try:
            guard.rollback()
        finally:
            try:
                guard.close()
            finally:
                if workers is not None:
                    workers.shutdown(wait=True)

    assert result == 'unauthorized'
    assert app_db.execute('SELECT count(*) FROM user_roles WHERE user_id=%s',
                          (target['id'],)).fetchone()[0] == 0
    assert app_db.execute('SELECT admin_revision FROM users WHERE id=%s',
                          (target['id'],)).fetchone()[0] == target_revision == 0
    assert _audit_count(app_db) == audit_count


def test_runtime_audit_privileges_are_append_only(app_db):
    target = appstore.create_user(app_db, 'audit-permission-target', PASSWORD)
    app_db.commit()
    app_db.execute('SET LOCAL ROLE app_runtime')
    audit_id = app_db.execute('''INSERT INTO admin_audit
        (actor_kind,actor_label,operation,target_user_id,before_state,after_state,reason)
        VALUES ('operator','test-operator','admin.bootstrap',%s,
          '{"roles":[],"disabled_at":null,"revision":0}'::jsonb,
          '{"roles":["admin"],"disabled_at":null,"revision":1}'::jsonb,
          'Privilege test') RETURNING id''',
        (appstore._uuid(target['id']),)).fetchone()[0]
    assert app_db.execute('SELECT reason FROM admin_audit WHERE id=%s',
                          (audit_id,)).fetchone()[0] == 'Privilege test'

    denied = (
        ('UPDATE admin_audit SET reason=%s WHERE id=%s', ('Changed', audit_id)),
        ('DELETE FROM admin_audit WHERE id=%s', (audit_id,)),
        ('TRUNCATE admin_audit', ()),
    )
    for sql, params in denied:
        app_db.execute('SAVEPOINT audit_privilege_check')
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            app_db.execute(sql, params)
        app_db.execute('ROLLBACK TO SAVEPOINT audit_privilege_check')
        app_db.execute('RELEASE SAVEPOINT audit_privilege_check')
    app_db.rollback()
