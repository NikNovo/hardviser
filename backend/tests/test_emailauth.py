import concurrent.futures
import hashlib

import pytest

from hardissoft_public_chat import adminstore, appstore, emailauth


RETURN_TO = '/projects/list?from=email'


def _request(conn, email='person@example.com', bucket='a' * 64, return_to=RETURN_TO):
    return emailauth.request_link(conn, email, bucket, return_to)


def _assert_code(error, code):
    assert error.value.code == code


def test_request_and_prepare_do_not_create_account_or_session(app_db):
    requested = _request(app_db)

    assert requested['email'] == 'person@example.com'
    assert len(requested['token']) == 43
    assert set(requested) == {'email', 'token', 'expires_at', 'return_to'}
    token_hash = app_db.execute('SELECT token_hash FROM email_auth_links').fetchone()[0]
    assert token_hash == hashlib.sha256(requested['token'].encode('ascii')).hexdigest()
    assert requested['token'] != token_hash
    assert app_db.execute('SELECT count(*) FROM users').fetchone()[0] == 0
    assert app_db.execute('SELECT count(*) FROM sessions').fetchone()[0] == 0

    prepared = emailauth.prepare_link(app_db, requested['token'])

    assert prepared['email'] == 'person@example.com'
    assert prepared['return_to'] == RETURN_TO
    assert set(prepared) == {'email', 'return_to', 'expires_at'}
    assert app_db.execute('SELECT count(*) FROM users').fetchone()[0] == 0
    assert app_db.execute('SELECT count(*) FROM sessions').fetchone()[0] == 0


def test_expired_and_consumed_links_are_rejected(app_db):
    expired = _request(app_db)
    expired_hash = hashlib.sha256(expired['token'].encode('ascii')).hexdigest()
    app_db.execute('''UPDATE email_auth_links
        SET created_at=clock_timestamp()-interval '2 seconds',
            expires_at=clock_timestamp()-interval '1 second'
        WHERE token_hash=%s''', (expired_hash,))
    with pytest.raises(appstore.Invalid) as invalid_expired:
        emailauth.prepare_link(app_db, expired['token'])
    _assert_code(invalid_expired, 'invalid_link')

    with pytest.raises(appstore.Invalid) as invalid_expired_consume:
        emailauth.consume_link(app_db, expired['token'])
    _assert_code(invalid_expired_consume, 'invalid_link')

    live = _request(app_db, email='another@example.com', bucket='b' * 64)
    consumed = emailauth.consume_link(app_db, live['token'])
    assert consumed['login'] == 'another@example.com'
    with pytest.raises(appstore.Invalid) as invalid_reuse:
        emailauth.consume_link(app_db, live['token'])
    _assert_code(invalid_reuse, 'invalid_link')


def test_email_consume_returns_the_same_full_identity_as_session_resolution(app_db):
    requested = _request(app_db, email='full-identity@example.com')

    login_result = emailauth.consume_link(app_db, requested['token'])
    identity = {key: login_result[key] for key in ('id', 'login', 'display_name', 'roles')}
    stored_id = app_db.execute('SELECT id FROM users WHERE email=%s',
                               ('full-identity@example.com',)).fetchone()[0]

    assert set(login_result) == {'id', 'login', 'display_name', 'roles', 'token', 'expires_at'}
    assert identity == {'id': str(stored_id), 'login': 'full-identity@example.com',
                        'display_name': None, 'roles': []}
    assert appstore.resolve_session(app_db, login_result['token']) == identity


def test_latest_requested_link_invalidates_older_link(app_db):
    first = _request(app_db, email='latest@example.com')
    app_db.execute("UPDATE email_auth_links SET created_at=now()-interval '61 seconds' WHERE email=%s",
                   ('latest@example.com',))
    second = _request(app_db, email='LATEST@example.com', bucket='b' * 64)

    with pytest.raises(appstore.Invalid) as invalid_old:
        emailauth.prepare_link(app_db, first['token'])
    _assert_code(invalid_old, 'invalid_link')
    assert emailauth.prepare_link(app_db, second['token'])['email'] == 'latest@example.com'


def test_confirmation_reuses_one_case_insensitive_verified_identity(app_db):
    first = _request(app_db, email='Jane.Doe@example.com')
    first_session = emailauth.consume_link(app_db, first['token'])

    assert first_session['display_name'] is None
    assert first_session['roles'] == []
    appstore.update_account_profile(app_db, first_session['id'], 'Jane Doe')
    app_db.execute("INSERT INTO user_roles(user_id,role) VALUES (%s,'expert')",
                   (first_session['id'],))

    app_db.execute("UPDATE email_auth_links SET created_at=now()-interval '61 seconds' WHERE email=%s",
                   ('jane.doe@example.com',))
    second = _request(app_db, email='JANE.DOE@EXAMPLE.COM', bucket='b' * 64)
    second_session = emailauth.consume_link(app_db, second['token'])

    assert first_session['id'] == second_session['id']
    assert first_session['login'] == second_session['login'] == 'jane.doe@example.com'
    assert second_session['display_name'] == 'Jane Doe'
    assert second_session['roles'] == ['expert']
    assert app_db.execute('SELECT count(*) FROM users WHERE email=%s',
                          ('jane.doe@example.com',)).fetchone()[0] == 1
    assert appstore.resolve_session(app_db, first_session['token']) == {
        'id': first_session['id'], 'login': 'jane.doe@example.com',
        'display_name': 'Jane Doe', 'roles': ['expert']}


def test_disabled_verified_account_cannot_consume_email_link(app_db):
    user = appstore.create_user(app_db, 'disabled-email-user', 'legacy password')
    app_db.execute('UPDATE users SET email=%s WHERE id=%s', ('disabled@example.com', user['id']))
    requested = _request(app_db, email='disabled@example.com')
    assert emailauth.prepare_link(app_db, requested['token'])['email'] == 'disabled@example.com'

    adminstore.operator_disable(app_db, user['id'], 'test disable', 'test')
    with pytest.raises(appstore.Invalid) as disabled:
        emailauth.consume_link(app_db, requested['token'])
    _assert_code(disabled, 'invalid_link')
    assert app_db.execute('SELECT count(*) FROM users WHERE email=%s',
                          ('disabled@example.com',)).fetchone()[0] == 1
    assert app_db.execute('SELECT count(*) FROM sessions WHERE user_id=%s', (user['id'],)).fetchone()[0] == 0


def test_concurrent_consumption_creates_exactly_one_session(app_db):
    requested = _request(app_db, email='concurrent@example.com')
    app_db.commit()

    def consume_once():
        conn = appstore.connect()
        try:
            result = emailauth.consume_link(conn, requested['token'])
            conn.commit()
            return ('success', result)
        except appstore.Invalid as error:
            conn.rollback()
            return ('invalid', error.code)
        finally:
            conn.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _index: consume_once(), range(2)))

    assert [result[0] for result in results].count('success') == 1
    assert [result[0] for result in results].count('invalid') == 1
    assert app_db.execute('SELECT count(*) FROM users WHERE email=%s',
                          ('concurrent@example.com',)).fetchone()[0] == 1
    assert app_db.execute('SELECT count(*) FROM sessions').fetchone()[0] == 1


def test_email_minimum_interval_and_hourly_limit(app_db):
    _request(app_db, email='email-limit@example.com')
    with pytest.raises(appstore.QuotaExceeded):
        _request(app_db, email='email-limit@example.com', bucket='b' * 64)

    for _ in range(4):
        app_db.execute("UPDATE email_auth_links SET created_at=now()-interval '61 seconds' WHERE email=%s",
                       ('email-limit@example.com',))
        _request(app_db, email='email-limit@example.com', bucket='b' * 64)
    assert app_db.execute('SELECT count(*) FROM email_auth_links WHERE email=%s',
                          ('email-limit@example.com',)).fetchone()[0] == 5
    with pytest.raises(appstore.QuotaExceeded):
        _request(app_db, email='email-limit@example.com', bucket='b' * 64)


def test_client_hourly_limit_is_shared_across_emails(app_db):
    bucket = 'c' * 64
    for index in range(20):
        _request(app_db, email=f'client-{index}@example.com', bucket=bucket)

    with pytest.raises(appstore.QuotaExceeded):
        _request(app_db, email='client-over@example.com', bucket=bucket)
    assert app_db.execute('SELECT count(*) FROM email_auth_links WHERE client_bucket=%s',
                          (bucket,)).fetchone()[0] == 20


def test_global_utc_daily_limit_is_shared_across_clients(app_db):
    for index in range(100):
        _request(app_db, email=f'global-{index}@example.com', bucket=f'{index:064x}')

    with pytest.raises(appstore.QuotaExceeded):
        _request(app_db, email='global-over@example.com', bucket='f' * 64)
    assert app_db.execute('SELECT count(*) FROM email_auth_links').fetchone()[0] == 100


@pytest.mark.parametrize('email', ['not-an-email', 'two@@example.com', 'person@example'])
def test_invalid_email_is_rejected(app_db, email):
    with pytest.raises(appstore.Invalid):
        _request(app_db, email=email)


@pytest.mark.parametrize('return_to', ['https://evil.example', '//evil.example', '/ok#fragment', '/\\evil'])
def test_return_path_cannot_redirect_outside_the_app(app_db, return_to):
    with pytest.raises(appstore.Invalid):
        _request(app_db, return_to=return_to)
