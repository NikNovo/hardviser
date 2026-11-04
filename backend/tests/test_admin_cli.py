import io
import os
import pwd

import pytest

from hardissoft_public_chat import adminstore, appstore, users


PASSWORD = 'correct horse battery staple'


class _NonClosingConnection:
    """Let the CLI close its owned handle without closing the fixture connection."""

    def __init__(self, conn):
        self._conn = conn

    def __getattr__(self, name):
        return getattr(self._conn, name)

    def close(self):
        pass


def _cli_connection(monkeypatch, conn):
    monkeypatch.setattr(users.appstore, 'connect', lambda: _NonClosingConnection(conn))


@pytest.fixture
def forged_operator_environment(monkeypatch):
    effective_user = pwd.getpwuid(os.geteuid()).pw_name
    forged_user = effective_user + '-forged-env'
    for name in ('LOGNAME', 'USER', 'LNAME', 'USERNAME', 'SUDO_USER'):
        monkeypatch.setenv(name, forged_user)
    return effective_user


def test_bootstrap_admin_cli_grants_existing_uuid_and_writes_operator_audit(
        app_db, monkeypatch, forged_operator_environment):
    target = appstore.create_user(app_db, 'chosen-user', PASSWORD)
    app_db.commit()
    _cli_connection(monkeypatch, app_db)

    result = users.main(['bootstrap-admin', target['id'], '--reason', 'Initial grant'])

    assert result == 0
    assert app_db.execute('''SELECT role FROM user_roles WHERE user_id=%s''',
                          (target['id'],)).fetchall() == [('admin',)]
    audit = app_db.execute('''SELECT actor_kind,actor_id,actor_label,operation,
        target_user_id,before_state,after_state,reason FROM admin_audit''').fetchone()
    assert audit[0:4] == ('operator', None, forged_operator_environment, 'admin.bootstrap')
    assert str(audit[4]) == target['id']
    assert audit[5] == {'roles': [], 'disabled_at': None, 'revision': 0}
    assert audit[6]['roles'] == ['admin']
    assert audit[6]['revision'] == 1
    assert audit[7] == 'Initial grant'


def test_bootstrap_cli_rejects_a_second_grant_without_audit_or_mutation(
        app_db, monkeypatch, capsys):
    first = appstore.create_user(app_db, 'first-account', PASSWORD)
    target = appstore.create_user(app_db, 'second-account', PASSWORD)
    adminstore.bootstrap_admin(app_db, first['id'], 'Initial grant', 'test-operator')
    _cli_connection(monkeypatch, app_db)
    before_audit_count = app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0]
    app_db.commit()

    result = users.main(['bootstrap-admin', target['id'], '--reason', 'Second grant'])

    assert result == 2
    assert 'already_bootstrapped' in capsys.readouterr().err
    assert app_db.execute('SELECT count(*) FROM user_roles WHERE role=%s',
                          ('admin',)).fetchone()[0] == 1
    assert app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0] == before_audit_count


def test_disable_cli_audits_operator_disable(app_db, monkeypatch, forged_operator_environment):
    target = appstore.create_user(app_db, 'disable-me', PASSWORD)
    token, _ = appstore.create_session(app_db, target['id'])
    _cli_connection(monkeypatch, app_db)

    result = users.main(['disable', 'disable-me', '--reason', 'Account requested closure'])

    assert result == 0
    user = app_db.execute('SELECT disabled_at FROM users WHERE id=%s',
                          (target['id'],)).fetchone()
    assert user[0] is not None
    assert appstore.resolve_session(app_db, token) is None
    audit = app_db.execute('''SELECT actor_kind,actor_label,operation,target_user_id,
        before_state,after_state,reason FROM admin_audit''').fetchone()
    assert audit[0:3] == ('operator', forged_operator_environment, 'admin.users.status.set')
    assert str(audit[3]) == target['id']
    assert audit[4] == {'roles': [], 'disabled_at': None, 'revision': 0}
    assert audit[5]['disabled_at'] is not None
    assert audit[5]['revision'] == 1
    assert audit[6] == 'Account requested closure'


def test_disable_cli_preserves_last_active_admin(app_db, monkeypatch, capsys):
    admin = appstore.create_user(app_db, 'sole-admin', PASSWORD)
    adminstore.bootstrap_admin(app_db, admin['id'], 'Initial grant', 'test-operator')
    _cli_connection(monkeypatch, app_db)
    before = app_db.execute('''SELECT disabled_at,admin_revision FROM users WHERE id=%s''',
                            (admin['id'],)).fetchone()
    audit_count = app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0]
    app_db.commit()

    result = users.main(['disable', 'sole-admin', '--reason', 'Attempt to disable last admin'])

    assert result == 2
    assert 'last_admin' in capsys.readouterr().err
    assert app_db.execute('''SELECT disabled_at,admin_revision FROM users WHERE id=%s''',
                          (admin['id'],)).fetchone() == before
    assert app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0] == audit_count


def test_create_and_passwd_cli_remain_roleless(app_db, monkeypatch, capsys):
    _cli_connection(monkeypatch, app_db)
    monkeypatch.setattr(users.sys, 'stdin', io.StringIO(PASSWORD + '\n'))

    assert users.main(['create', 'new-operator-user', '--password-stdin']) == 0
    capsys.readouterr()
    user = app_db.execute('SELECT id FROM users WHERE login=%s',
                          ('new-operator-user',)).fetchone()
    assert app_db.execute('SELECT count(*) FROM user_roles WHERE user_id=%s',
                          (user[0],)).fetchone()[0] == 0
    assert appstore.authenticate(app_db, 'new-operator-user', PASSWORD) is not None

    monkeypatch.setattr(users.sys, 'stdin', io.StringIO('replacement password\n'))
    assert users.main(['passwd', 'new-operator-user', '--password-stdin']) == 0
    capsys.readouterr()
    assert appstore.authenticate(app_db, 'new-operator-user', PASSWORD) is None
    assert appstore.authenticate(app_db, 'new-operator-user', 'replacement password') is not None
    assert app_db.execute('SELECT count(*) FROM user_roles WHERE user_id=%s',
                          (user[0],)).fetchone()[0] == 0


def test_bootstrap_cli_refuses_disabled_target_without_creating_an_account(
        app_db, monkeypatch, capsys):
    target = appstore.create_user(app_db, 'disabled-bootstrap-target', PASSWORD)
    adminstore.operator_disable(app_db, target['id'], 'Disable before bootstrap', 'operator')
    app_db.commit()
    _cli_connection(monkeypatch, app_db)
    audit_count = app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0]

    result = users.main(['bootstrap-admin', target['id'], '--reason', 'Invalid grant'])

    assert result == 2
    capsys.readouterr()
    assert app_db.execute('SELECT count(*) FROM users WHERE id=%s',
                          (target['id'],)).fetchone()[0] == 1
    assert app_db.execute('SELECT count(*) FROM user_roles WHERE user_id=%s',
                          (target['id'],)).fetchone()[0] == 0
    assert app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0] == audit_count


def test_bootstrap_and_disable_cli_require_reasons():
    with pytest.raises(SystemExit):
        users._parser().parse_args([
            'bootstrap-admin', '00000000-0000-4000-8000-000000000000'])
    with pytest.raises(SystemExit):
        users._parser().parse_args(['disable', 'someone'])


@pytest.mark.parametrize('command', ['bootstrap-admin', 'disable'])
def test_operator_cli_cannot_commit_without_effective_os_identity(
        command, app_db, monkeypatch, forged_operator_environment):
    target = appstore.create_user(app_db, 'missing-os-identity', PASSWORD)
    app_db.commit()
    _cli_connection(monkeypatch, app_db)

    def unknown_uid(uid):
        raise KeyError(uid)

    monkeypatch.setattr(pwd, 'getpwuid', unknown_uid)
    target_argument = target['id'] if command == 'bootstrap-admin' else target['login']

    assert users.main([command, target_argument, '--reason', 'Identity must be known']) != 0
    assert app_db.execute(
        'SELECT disabled_at,admin_revision FROM users WHERE id=%s',
        (target['id'],),
    ).fetchone() == (None, 0)
    assert app_db.execute('SELECT count(*) FROM user_roles').fetchone()[0] == 0
    assert app_db.execute('SELECT count(*) FROM admin_audit').fetchone()[0] == 0
