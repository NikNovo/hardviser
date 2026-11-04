"""Real HTTP coverage for admin bridge authorization and effective DB privileges."""
import http.client
import json
import time
import uuid

import pytest

from hardissoft_public_chat import appstore, service

KEY = 'e' * 64


def _signed_post(server, suffix, token, **fields):
    path = service.PATH + suffix
    payload = {'request_id': str(uuid.uuid4()), **fields}
    if token is not None:
        payload['session_token'] = token
    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
    try:
        connection.request('POST', path, body=raw, headers={
            'Content-Type': 'application/json',
            'X-RAG-Timestamp': timestamp,
            'X-RAG-Nonce': nonce,
            'X-RAG-Signature': service.sign(KEY, 'POST', path, timestamp, nonce, raw),
        })
        response = connection.getresponse()
        return response.status, response.getheader('Cache-Control'), json.loads(response.read())
    finally:
        connection.close()


def _user_with_session(conn, login):
    user = appstore.create_user(conn, login, 'correct horse battery staple')
    token, _ = appstore.create_session(conn, user['id'])
    return user, token


def test_admin_http_rechecks_identity_and_runs_as_app_runtime(app_db, monkeypatch, tmp_path):
    primary, primary_token = _user_with_session(app_db, 'phase0-admin-one')
    secondary, secondary_token = _user_with_session(app_db, 'phase0-admin-two')
    ordinary, ordinary_token = _user_with_session(app_db, 'phase0-ordinary')
    owner = appstore.create_user(app_db, 'phase0-owner', 'correct horse battery staple')
    app_db.execute('INSERT INTO user_roles(user_id, role) VALUES (%s, %s), (%s, %s)',
                   (primary['id'], 'admin', secondary['id'], 'admin'))
    foreign_project = appstore.create_project(app_db, owner['id'], 'Private project')
    app_db.commit()

    monkeypatch.setenv('PGOPTIONS', '-c role=app_runtime')
    monkeypatch.setenv('SEVERUS_RAG_BRIDGE_HMAC_KEY', KEY)
    monkeypatch.setenv('HIS_KB_PUBLIC_CHAT_STATE_DB', str(tmp_path / 'state.sqlite3'))
    with appstore.connect() as runtime_conn:
        assert runtime_conn.execute('SELECT current_database(), current_user').fetchone() == (
            'hardissoft_app_test', 'app_runtime')

    server = service.create_server('127.0.0.1', 0)
    import threading
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, payload = _signed_post(server, '/admin/users/list', None)
        assert status == 401
        assert payload['code'] == 'unauthorized'

        status, _, payload = _signed_post(server, '/admin/users/list', ordinary_token)
        assert status == 403
        assert payload['code'] == 'forbidden'

        status, cache_control, payload = _signed_post(
            server, '/admin/users/roles/set', primary_token, user_id=secondary['id'],
            roles=['expert'], expected_revision=0, reason='Phase 0 HTTP role change')
        assert status == 200
        assert cache_control == 'no-store'
        assert set(payload['data']) == {
            'id', 'login', 'display_name', 'roles', 'email', 'created_at', 'disabled_at', 'revision'}
        assert payload['data']['id'] == secondary['id']
        assert payload['data']['roles'] == ['expert']
        assert payload['data']['revision'] == 1

        status, _, payload = _signed_post(server, '/admin/audit/list', primary_token, limit=10)
        assert status == 200
        assert len(payload['data']['items']) == 1
        audit = payload['data']['items'][0]
        assert audit['operation'] == 'admin.users.roles.set'
        assert audit['target_user_id'] == secondary['id']
        assert audit['reason'] == 'Phase 0 HTTP role change'

        # The same session loses its admin role after the mutation; the next request
        # must re-check current roles instead of trusting the role it previously had.
        status, _, payload = _signed_post(server, '/admin/users/list', secondary_token)
        assert status == 403
        assert payload['code'] == 'forbidden'

        status, _, payload = _signed_post(
            server, '/admin/users/status/set', primary_token, user_id=secondary['id'],
            disabled=True, expected_revision=1, reason='Disable test account')
        assert status == 200
        assert payload['data']['disabled_at'] is not None
        status, _, payload = _signed_post(server, '/projects/list', secondary_token)
        assert status == 401
        assert payload['code'] == 'unauthorized'

        status, _, payload = _signed_post(
            server, '/projects/update', primary_token, project_id=foreign_project['id'], name='Intrusion')
        assert status == 404
        assert payload['code'] == 'not_found'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

