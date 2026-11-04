#!/usr/bin/env python3
"""Exercise authenticated API, isolation, and billing failure against the disposable local fixture."""
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from threading import Thread
import uuid


TEST_DATABASE = 'hardissoft_app_test'
TEST_HOSTS = {'127.0.0.1', '::1', 'localhost'}
if sys.version_info[:3] != (3, 10, 12):
    raise SystemExit('HTTP smoke requires CPython 3.10.12.')
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path[:0] = [
    str(BACKEND_DIR / 'vendor' / 'knowledge-base' / 'src'),
    str(BACKEND_DIR),
]


def _signed_post(service, server, key, suffix, **fields):
    path = service.PATH + suffix
    payload = {'request_id': str(uuid.uuid4()), **fields}
    raw = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    timestamp = str(int(time.time()))
    nonce = uuid.uuid4().hex
    connection = HTTPConnection('127.0.0.1', server.server_port, timeout=10)
    try:
        connection.request('POST', path, body=raw, headers={
            'Content-Type': 'application/json',
            'X-RAG-Timestamp': timestamp,
            'X-RAG-Nonce': nonce,
            'X-RAG-Signature': service.sign(key, 'POST', path, timestamp, nonce, raw),
        })
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()




def _under_home(path):
    root = path.expanduser().resolve()
    try:
        root.relative_to(Path.home().resolve())
    except ValueError:
        raise SystemExit('HIS_APP_TEST_KB_ROOT must resolve under the current user home.') from None
    return root


def main():
    if os.environ.get('HIS_APP_TEST_DATABASE') != TEST_DATABASE:
        raise SystemExit('Set HIS_APP_TEST_DATABASE=hardissoft_app_test for the HTTP smoke check.')
    host = os.environ.get('HIS_APP_TEST_HOST', '127.0.0.1')
    if host not in TEST_HOSTS:
        raise SystemExit('HIS_APP_TEST_HOST must be a loopback address.')
    try:
        port = int(os.environ.get('HIS_APP_TEST_PORT', '5432'))
    except ValueError:
        raise SystemExit('HIS_APP_TEST_PORT must be in 1..65535.') from None
    if not 1 <= port <= 65535:
        raise SystemExit('HIS_APP_TEST_PORT must be in 1..65535.')

    test_root = _under_home(Path(os.environ.get(
        'HIS_APP_TEST_KB_ROOT', str(Path.home() / '.cache' / 'hardviser-test' / 'knowledge-base')
    )))
    connection_config = test_root / 'runtime' / 'postgres' / 'connection.json'
    if connection_config.exists() or connection_config.is_symlink():
        raise SystemExit('Refusing a test KB root containing PostgreSQL connection configuration.')

    for name in (
        'HIS_APP_DB_HOST', 'HIS_APP_DB_PORT', 'HIS_APP_DB_NAME', 'HIS_APP_DB_USER',
        'HIS_APP_DB_PASSWORD', 'HIS_APP_DATA_ROOT', 'HIS_KB_ROOT',
        'HIS_KB_PUBLIC_CHAT_STATE_DB', 'HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION',
        'HIS_KB_PUBLIC_CHAT_RELEASE_ID', 'HIS_KB_PUBLIC_CHAT_COLLECTIONS',
        'SEVERUS_RAG_BRIDGE_HMAC_KEY', 'MODEL_API_KEY', 'HIS_APP_BACKUP_DB_HOST',
        'HIS_APP_BACKUP_DB_PORT', 'HIS_APP_BACKUP_DB_NAME', 'HIS_APP_BACKUP_DB_USER',
        'HIS_APP_BACKUP_CONFIG_FILE', 'HIS_APP_BACKUP_PG_DUMP', 'HIS_APP_BACKUP_AGE',
        'HIS_APP_BACKUP_RCLONE', 'HIS_APP_BACKUP_AGE_RECIPIENT',
        'HIS_APP_BACKUP_RCLONE_DESTINATION', 'CREDENTIALS_DIRECTORY', 'RCLONE_CONFIG',
        'SEVERUS_RAG_BRIDGE_HOST', 'SEVERUS_RAG_BRIDGE_PORT', 'REVENUECAT_ENVIRONMENT',
        'REVENUECAT_API_KEY', 'REVENUECAT_PROJECT_ID', 'REVENUECAT_APP_ID',
        'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGOPTIONS',
        'PGSERVICE', 'PGSERVICEFILE', 'PGSSLMODE',
    ):
        os.environ.pop(name, None)

    with tempfile.TemporaryDirectory(prefix='hardviser-http-smoke-') as temp_name:
        temp_root = Path(temp_name)
        os.environ.update({
            'HIS_APP_TEST_DATABASE': TEST_DATABASE,
            'HIS_APP_TEST_HOST': host,
            'HIS_APP_TEST_PORT': str(port),
            'HIS_APP_DB_HOST': host,
            'HIS_APP_DB_PORT': str(port),
            'HIS_APP_DB_NAME': TEST_DATABASE,
            'HIS_APP_DB_USER': 'app_runtime',
            'HIS_APP_DATA_ROOT': str(temp_root / 'app-data'),
            'HIS_KB_ROOT': str(test_root),
            'HIS_KB_PUBLIC_CHAT_STATE_DB': str(temp_root / 'state.sqlite3'),
            'SEVERUS_RAG_BRIDGE_HMAC_KEY': os.urandom(32).hex(),
            'HIS_KB_PUBLIC_CHAT_RELEASE_ID': 'release:' + 'a' * 64,
            'HIS_KB_PUBLIC_CHAT_COLLECTIONS': 'alpha,beta',
            'TOKENIZERS_PARALLELISM': 'false',
        })
        from hardissoft_public_chat import appstore, retrieval, service
        os.environ['HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION'] = retrieval.OWNER_EXCEPTION

        user_ids = []
        server = None
        worker = None
        try:
            with appstore.connect() as conn:
                identity = conn.execute('SELECT current_database(),current_user').fetchone()
                if identity != (TEST_DATABASE, 'app_runtime'):
                    raise SystemExit('HTTP smoke refused an unexpected database identity.')
                owner_login = 'smoke-' + uuid.uuid4().hex[:16]
                foreign_login = 'smoke-foreign-' + uuid.uuid4().hex[:12]
                owner_password = 'smoke-' + uuid.uuid4().hex
                owner = appstore.create_user(conn, owner_login, owner_password)
                user_ids.append(owner['id'])
                foreign = appstore.create_user(conn, foreign_login, 'smoke-' + uuid.uuid4().hex)
                user_ids.append(foreign['id'])
                foreign_project = appstore.create_project(conn, foreign['id'], 'Smoke isolation fixture')

            if any(name in os.environ for name in (
                    'REVENUECAT_ENVIRONMENT', 'REVENUECAT_API_KEY',
                    'REVENUECAT_PROJECT_ID', 'REVENUECAT_APP_ID')):
                raise SystemExit('HTTP smoke requires billing provider configuration to be absent.')

            # This loads the real checksum-verified CPU encoder; there is no fake encoder fallback.
            retrieval.warm_up()
            server = service.create_server('127.0.0.1', 0)
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            key = os.environ['SEVERUS_RAG_BRIDGE_HMAC_KEY']

            status, payload = _signed_post(
                service, server, key, '/auth/login', client_bucket='b' * 64,
                login=owner_login, password=owner_password)
            login = payload.get('data') if isinstance(payload, dict) else None
            if (status != 200 or not isinstance(login, dict)
                    or login.get('id') != owner['id']
                    or login.get('login') != owner_login
                    or not isinstance(login.get('token'), str)):
                raise SystemExit(f'HTTP smoke login failed with status {status}.')
            token = login['token']

            status, payload = _signed_post(
                service, server, key, '/auth/me', session_token=token)
            identity = payload.get('data') if isinstance(payload, dict) else None
            if (status != 200 or not isinstance(identity, dict)
                    or identity.get('id') != owner['id']
                    or identity.get('login') != owner_login):
                raise SystemExit(f'HTTP smoke identity check failed with status {status}.')

            status, payload = _signed_post(
                service, server, key, '/projects/update', session_token=token,
                project_id=foreign_project['id'], name='smoke-forbidden-update')
            if status != 404 or payload.get('code') != 'not_found':
                raise SystemExit(f'HTTP smoke foreign-project isolation failed with status {status}.')

            status, payload = _signed_post(
                service, server, key, '/billing/sync', session_token=token)
            if status != 503 or payload.get('code') != 'service_unavailable':
                raise SystemExit(f'HTTP smoke billing fail-closed check failed with status {status}.')
            with appstore.connect() as conn:
                snapshot_count = conn.execute(
                    'SELECT count(*) FROM revenuecat_billing_snapshots WHERE user_id=%s',
                    (owner['id'],),
                ).fetchone()[0]
            if snapshot_count:
                raise SystemExit('HTTP smoke billing failure unexpectedly wrote an entitlement snapshot.')
        finally:
            if server is not None:
                if worker is not None and worker.is_alive():
                    server.shutdown()
                server.server_close()
                if worker is not None:
                    worker.join(timeout=10)
            if user_ids:
                with appstore.connect() as conn:
                    conn.execute('DELETE FROM users WHERE id=ANY(%s::uuid[])', (user_ids,))

    print('HTTP smoke passed: login, identity, project isolation, and billing fail-closed checks.')


if __name__ == '__main__':
    main()
