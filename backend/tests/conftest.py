from pathlib import Path
import os

import psycopg
import pytest


BASE_VERSIONS = {
    '001_app.sql', '002_file_kinds.sql',
    '003_todos_briefs_file_imports.sql', '004_email_auth.sql',
}
ADMIN_VERSION = '005_admin_roles.sql'
BILLING_VERSION = '006_sandbox_billing.sql'
ALLOWED_VERSIONS = BASE_VERSIONS | {ADMIN_VERSION, BILLING_VERSION}
TEST_DB_LOCK = 5142026110299
BASE_TABLES = {
    'schema_migrations', 'users', 'sessions', 'projects', 'chats',
    'files', 'file_chunks', 'messages', 'upload_sessions', 'blob_gc',
    'todos', 'file_imports', 'email_auth_links',
}
BILLING_TABLES = {
    'revenuecat_billing_snapshots', 'revenuecat_webhook_events',
    'revenuecat_webhook_event_users',
}


TEST_DATABASE = 'hardissoft_app_test'
TEST_HOSTS = frozenset(('127.0.0.1', '::1', 'localhost'))


def _test_settings():
    if os.environ.get('HIS_APP_TEST_DATABASE') != TEST_DATABASE:
        pytest.fail('set HIS_APP_TEST_DATABASE=hardissoft_app_test for the disposable test database')
    test_host = os.environ.get('HIS_APP_TEST_HOST', '127.0.0.1')
    if test_host not in TEST_HOSTS:
        pytest.fail('HIS_APP_TEST_HOST must be a loopback address')
    try:
        test_port = int(os.environ.get('HIS_APP_TEST_PORT', '5432'))
    except ValueError:
        pytest.fail('Invalid HIS_APP_TEST_PORT')
    if not 1 <= test_port <= 65535:
        pytest.fail('Invalid HIS_APP_TEST_PORT')
    test_user = os.environ.get('HIS_APP_TEST_USER', 'app_runtime')
    if test_user != 'app_runtime':
        pytest.fail('HIS_APP_TEST_USER must be the restricted app_runtime role')
    admin_user = os.environ.get('HIS_APP_TEST_ADMIN_USER', 'postgres')
    if not admin_user or admin_user == test_user:
        pytest.fail('HIS_APP_TEST_ADMIN_USER must be separate from app_runtime')
    return test_host, test_port, test_user, admin_user



@pytest.fixture(scope='session')
def admin_schema():
    test_host, test_port, _, admin_user = _test_settings()
    with psycopg.connect(
        host=test_host,
        port=test_port, dbname=TEST_DATABASE,
        user=admin_user,
    ) as conn:
        database, owner = conn.execute('''
            SELECT datname,pg_get_userbyid(datdba)
            FROM pg_database WHERE datname=current_database()
        ''').fetchone()
        if (database, owner) != ('hardissoft_app_test', 'app_owner'):
            pytest.fail('Unexpected test database or owner')
        if not conn.execute('SELECT pg_try_advisory_lock(%s)', (TEST_DB_LOCK,)).fetchone()[0]:
            pytest.fail('Another test session owns the disposable database')
        if conn.execute('''
            SELECT count(*) FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
        ''').fetchone()[0]:
            pytest.fail('Another connection is using the disposable database')
        if conn.execute("SELECT to_regclass('public.schema_migrations')").fetchone()[0] is None:
            pytest.fail('Provision base migrations 001–004 before running tests')
        versions = {row[0] for row in conn.execute('SELECT version FROM schema_migrations')}
        if not BASE_VERSIONS <= versions or not versions <= ALLOWED_VERSIONS:
            pytest.fail('Missing base migrations or unexpected test schema version')
        rows = conn.execute('''
            SELECT c.relname,pg_get_userbyid(c.relowner)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(%s)
        ''', (sorted(BASE_TABLES),)).fetchall()
        if {name for name, _ in rows} != BASE_TABLES or any(owner != 'app_owner' for _, owner in rows):
            pytest.fail('Base tables must exist and belong to app_owner')
        conn.execute('SET LOCAL ROLE app_owner')
        for version in (ADMIN_VERSION, BILLING_VERSION):
            if version not in versions:
                migration = Path(__file__).resolve().parents[1] / 'migrations' / version
                conn.execute(migration.read_text(), prepare=False)
                conn.execute('INSERT INTO schema_migrations(version) VALUES (%s)', (version,))
        conn.execute('SELECT display_name,admin_revision FROM users LIMIT 0')
        rows = conn.execute('''
            SELECT c.relname,pg_get_userbyid(c.relowner)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r'
              AND c.relname IN ('user_roles','admin_audit')
        ''').fetchall()
        if dict(rows) != {'user_roles': 'app_owner', 'admin_audit': 'app_owner'}:
            pytest.fail('Admin tables must belong to app_owner')
        rows = conn.execute('''
            SELECT c.relname,pg_get_userbyid(c.relowner)
            FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(%s)
        ''', (sorted(BILLING_TABLES),)).fetchall()
        if dict(rows) != {name: 'app_owner' for name in BILLING_TABLES}:
            pytest.fail('Billing tables must exist and belong to app_owner')
        conn.commit()
        yield conn


@pytest.fixture
def app_db(admin_schema, monkeypatch, tmp_path):
    """Use only the explicitly named throwaway database; never touch production."""
    test_host, test_port, test_user, _ = _test_settings()
    monkeypatch.setenv('HIS_APP_DB_NAME', TEST_DATABASE)
    monkeypatch.setenv('HIS_APP_DB_USER', test_user)
    monkeypatch.setenv('HIS_APP_DB_HOST', test_host)
    monkeypatch.setenv('HIS_APP_DB_PORT', str(test_port))
    monkeypatch.delenv('HIS_APP_DB_PASSWORD', raising=False)
    monkeypatch.setenv('HIS_APP_DATA_ROOT', str(tmp_path / 'app-data'))

    admin_schema.execute('SET LOCAL ROLE app_owner')
    admin_schema.execute('''TRUNCATE admin_audit,user_roles,email_auth_links,file_chunks,messages,chats,
        upload_sessions,files,projects,sessions,revenuecat_webhook_event_users,
        revenuecat_webhook_events,revenuecat_billing_snapshots,users,blob_gc
        RESTART IDENTITY CASCADE''')
    admin_schema.commit()

    from hardissoft_public_chat import appstore

    conn = appstore.connect()
    try:
        assert conn.execute('SELECT current_database(),current_user').fetchone() == (
            'hardissoft_app_test', 'app_runtime')
        yield conn
    finally:
        conn.rollback()
        conn.close()


