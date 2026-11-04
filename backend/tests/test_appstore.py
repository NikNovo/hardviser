import concurrent.futures
import hashlib
from datetime import datetime
import threading
import time

import pytest

from hardissoft_public_chat import adminstore, appstore

MAX_FILE_BYTES = appstore.MAX_FILE_BYTES


def _user(conn, login):
    return appstore.create_user(conn, login, 'correct horse battery staple')


def _project(conn, user, name):
    return appstore.create_project(conn, user['id'], name)


def _file(conn, user, project, name, data=b'file contents', mime='text/plain'):
    digest = hashlib.sha256(data).hexdigest()
    upload = appstore.start_upload(conn, user['id'], project['id'], name, mime, len(data), digest)
    for index, offset in enumerate(range(0, len(data), upload['chunk_bytes'])):
        appstore.put_chunk(conn, user['id'], upload['upload_id'], index,
                           data[offset:offset + upload['chunk_bytes']])
    result = appstore.finish_upload(conn, user['id'], upload['upload_id'])
    conn.execute("UPDATE files SET status='ready' WHERE id=%s", (result['id'],))
    return result


def _assert_code(exc, code):
    assert exc.value.code == code


def test_scrypt_authentication_and_disabled_users(app_db):
    user = appstore.create_user(app_db, 'Alice', 'correct horse battery staple')
    stored = app_db.execute('SELECT password_hash FROM users WHERE id=%s', (user['id'],)).fetchone()[0]

    assert user['login'] == 'alice'
    assert stored.startswith('scrypt$')
    assert 'correct horse battery staple' not in stored
    assert appstore.authenticate(app_db, 'ALICE', 'correct horse battery staple') == user
    assert appstore.authenticate(app_db, 'alice', 'wrong password') is None
    assert appstore.authenticate(app_db, 'missing', 'wrong password') is None

    adminstore.operator_disable(app_db, user['id'], 'test disable', 'test')
    assert appstore.authenticate(app_db, 'alice', 'correct horse battery staple') is None


def test_sessions_expire_and_revoke(app_db):
    user = _user(app_db, 'session-user')
    token, expires_at = appstore.create_session(app_db, user['id'])
    token_hash = hashlib.sha256(token.encode('ascii')).hexdigest()
    row = app_db.execute('SELECT token_hash, expires_at FROM sessions WHERE user_id=%s',
                         (user['id'],)).fetchone()
    identity = {'id': user['id'], 'login': 'session-user',
                'display_name': None, 'roles': []}

    assert row[0] == token_hash
    assert appstore.account_identity(app_db, user['id']) == identity
    assert appstore.resolve_session(app_db, token) == identity
    assert datetime.fromisoformat(expires_at) == row[1]

    app_db.execute("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=%s",
                   (token_hash,))
    assert appstore.resolve_session(app_db, token) is None

    fresh, _ = appstore.create_session(app_db, user['id'])
    appstore.revoke_session(app_db, fresh)
    assert appstore.resolve_session(app_db, fresh) is None


def test_identity_uses_explicit_roles_not_legacy_admin_login(app_db):
    user = appstore.create_user(app_db, 'admin', 'correct horse battery staple')
    token, _ = appstore.create_session(app_db, user['id'])

    assert appstore.account_identity(app_db, user['id']) == {
        'id': user['id'], 'login': 'admin', 'display_name': None, 'roles': []}
    app_db.execute('''INSERT INTO user_roles(user_id,role)
        VALUES (%s,'expert'),(%s,'admin')''', (user['id'], user['id']))
    identity = {'id': user['id'], 'login': 'admin', 'display_name': None,
                'roles': ['admin', 'expert']}
    assert appstore.account_identity(app_db, user['id']) == identity
    assert appstore.resolve_session(app_db, token) == identity


def test_profile_update_changes_only_display_name_and_preserves_session_identity(app_db):
    user = _user(app_db, 'profile-user')
    token, _ = appstore.create_session(app_db, user['id'])
    app_db.execute("INSERT INTO user_roles(user_id,role) VALUES (%s,'expert')", (user['id'],))
    unchanged = app_db.execute('SELECT email,password_hash,disabled_at FROM users WHERE id=%s',
                               (user['id'],)).fetchone()

    identity = appstore.update_account_profile(app_db, user['id'], 'Ada Lovelace 🧮')

    assert identity == {'id': user['id'], 'login': 'profile-user',
                        'display_name': 'Ada Lovelace 🧮', 'roles': ['expert']}
    assert appstore.resolve_session(app_db, token) == identity
    assert app_db.execute('SELECT display_name,admin_revision FROM users WHERE id=%s',
                          (user['id'],)).fetchone() == ('Ada Lovelace 🧮', 0)
    assert app_db.execute('SELECT email,password_hash,disabled_at FROM users WHERE id=%s',
                          (user['id'],)).fetchone() == unchanged


@pytest.mark.parametrize('display_name', ['', ' leading', 'trailing ', '\tname',
                                          'line\nbreak', 'x' * 81])
def test_profile_update_rejects_noncanonical_display_names(app_db, display_name):
    user = _user(app_db, 'profile-invalid')

    with pytest.raises(appstore.Invalid) as invalid:
        appstore.update_account_profile(app_db, user['id'], display_name)
    _assert_code(invalid, 'display_name')


def test_profile_update_accepts_eighty_unicode_code_points(app_db):
    user = _user(app_db, 'profile-boundary')
    display_name = '🧮' * 80

    identity = appstore.update_account_profile(app_db, user['id'], display_name)

    assert len(identity['display_name']) == 80
    assert identity['display_name'] == display_name


def test_password_authentication_does_not_change_profile_identity(app_db):
    user = appstore.create_user(app_db, 'profile-auth', 'correct horse battery staple')
    appstore.update_account_profile(app_db, user['id'], 'Account name')

    assert appstore.authenticate(app_db, 'profile-auth', 'correct horse battery staple') == user
    assert appstore.account_identity(app_db, user['id']) == {
        'id': user['id'], 'login': 'profile-auth',
        'display_name': 'Account name', 'roles': []}


def test_identity_and_session_creation_hide_unknown_or_disabled_users(app_db):
    with pytest.raises(appstore.NotFound):
        appstore.account_identity(app_db, '00000000-0000-0000-0000-000000000001')

    user = _user(app_db, 'disabled-identity')
    app_db.execute('UPDATE users SET disabled_at=clock_timestamp() WHERE id=%s', (user['id'],))
    with pytest.raises(appstore.NotFound):
        appstore.account_identity(app_db, user['id'])
    with pytest.raises(appstore.NotFound):
        appstore.create_session(app_db, user['id'])


def test_create_session_waits_for_concurrent_disable(app_db):
    user = _user(app_db, 'session-disable-race')
    app_db.commit()
    disabling = appstore.connect()
    disabling.execute('UPDATE users SET disabled_at=clock_timestamp() WHERE id=%s',
                      (user['id'],))
    attempting = threading.Event()
    worker_pid = {}

    def create_session():
        conn = appstore.connect()
        try:
            worker_pid['pid'] = conn.execute('SELECT pg_backend_pid()').fetchone()[0]
            attempting.set()
            appstore.create_session(conn, user['id'])
            conn.commit()
            return 'created'
        except appstore.NotFound:
            conn.rollback()
            return 'not_found'
        finally:
            conn.close()

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as workers:
        future = workers.submit(create_session)
        try:
            assert attempting.wait(timeout=5)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                wait = app_db.execute('''SELECT wait_event_type FROM pg_stat_activity
                    WHERE pid=%s''', (worker_pid['pid'],)).fetchone()
                if wait is not None and wait[0] == 'Lock':
                    break
                time.sleep(0.01)
            assert wait is not None and wait[0] == 'Lock'
        finally:
            disabling.commit()
            disabling.close()
        assert future.result(timeout=5) == 'not_found'
    assert app_db.execute('SELECT count(*) FROM sessions WHERE user_id=%s',
                          (user['id'],)).fetchone()[0] == 0


@pytest.mark.parametrize('roles', [[], ['expert'], ['admin'], ['admin', 'expert']])
def test_foreign_project_chat_file_and_message_operations_are_hidden(app_db, roles):
    owner = _user(app_db, 'owner')
    other = _user(app_db, 'other')
    for role in roles:
        app_db.execute('INSERT INTO user_roles(user_id,role) VALUES (%s,%s)',
                       (other['id'], role))
    foreign_project = _project(app_db, owner, 'Owner project')
    other_project = _project(app_db, other, 'Other project')
    foreign_chat = appstore.create_chat(app_db, owner['id'], foreign_project['id'])
    other_chat = appstore.create_chat(app_db, other['id'], other_project['id'])
    foreign_file = _file(app_db, owner, foreign_project, 'owner.txt')
    appstore.add_user_message(app_db, owner['id'], foreign_chat['id'], 'owner question',
                              [foreign_file['id']], '00000000-0000-0000-0000-000000000001')
    appstore.add_assistant_message(app_db, foreign_chat['id'], 'owner answer', None, 'general',
                                   '00000000-0000-0000-0000-000000000002', 'complete')

    operations = [
        lambda: appstore.get_project(app_db, other['id'], foreign_project['id']),
        lambda: appstore.update_project(app_db, other['id'], foreign_project['id'], name='changed'),
        lambda: appstore.delete_project(app_db, other['id'], foreign_project['id']),
        lambda: appstore.list_chats(app_db, other['id'], foreign_project['id']),
        lambda: appstore.list_files(app_db, other['id'], foreign_project['id']),
        lambda: appstore.get_chat(app_db, other['id'], foreign_chat['id']),
        lambda: appstore.update_chat(app_db, other['id'], foreign_chat['id'], title='changed'),
        lambda: appstore.delete_chat(app_db, other['id'], foreign_chat['id']),
        lambda: appstore.list_messages(app_db, other['id'], foreign_chat['id']),
        lambda: appstore.add_user_message(app_db, other['id'], foreign_chat['id'], 'intrusion', [],
                                          '00000000-0000-0000-0000-000000000003'),
        lambda: appstore.delete_file(app_db, other['id'], foreign_file['id']),
    ]
    for operation in operations:
        with pytest.raises(appstore.NotFound):
            operation()

    with pytest.raises(appstore.Invalid) as pinned:
        appstore.update_chat(app_db, other['id'], other_chat['id'], pinned=[foreign_file['id']])
    _assert_code(pinned, 'pinned')
    with pytest.raises(appstore.Invalid) as mentioned:
        appstore.add_user_message(app_db, other['id'], other_chat['id'], 'intrusion',
                                  [foreign_file['id']], '00000000-0000-0000-0000-000000000004')
    _assert_code(mentioned, 'mentions')
    with pytest.raises(appstore.NotFound):
        appstore.search_project_files(app_db, other['id'], other_project['id'], 'owner',
                                      file_ids=[foreign_file['id']])


def test_upload_type_file_size_and_storage_quotas(app_db):
    user = _user(app_db, 'quota-user')
    project = _project(app_db, user, 'Quota project')
    digest = hashlib.sha256(b'x').hexdigest()

    with pytest.raises(appstore.Invalid) as unsupported:
        appstore.start_upload(app_db, user['id'], project['id'], 'bad.bin', 'application/octet-stream',
                              1, digest)
    _assert_code(unsupported, 'unsupported_type')
    assert app_db.execute('SELECT count(*) FROM upload_sessions').fetchone()[0] == 0

    with pytest.raises(appstore.QuotaExceeded) as too_large:
        appstore.start_upload(app_db, user['id'], project['id'], 'large.txt', 'text/plain',
                              MAX_FILE_BYTES + 1, digest)
    _assert_code(too_large, 'file_size')

    full_project = _project(app_db, user, 'Second project')
    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s, 'stored-' || n, 'text/plain', %s, repeat('a',64), 'ready'
        FROM generate_series(1,52) AS n""", (project['id'], MAX_FILE_BYTES))
    with pytest.raises(appstore.QuotaExceeded) as storage:
        appstore.start_upload(app_db, user['id'], full_project['id'], 'next.txt', 'text/plain', 1, digest)
    _assert_code(storage, 'storage')


def test_failed_files_do_not_consume_storage_or_project_file_quota(app_db):
    user = _user(app_db, 'failed-quota-user')
    project = _project(app_db, user, 'Failed quota project')
    digest = hashlib.sha256(b'x').hexdigest()
    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s, 'failed-' || n, 'text/plain', %s, repeat('b',64), 'failed'
        FROM generate_series(1,205) AS n""", (project['id'], MAX_FILE_BYTES))

    upload = appstore.start_upload(app_db, user['id'], project['id'], 'accepted.txt', 'text/plain', 1, digest)
    assert upload['chunk_bytes'] == 2 * 1024 * 1024
    assert app_db.execute('SELECT count(*) FROM upload_sessions').fetchone()[0] == 1


def test_project_file_quota_counts_live_files(app_db):
    user = _user(app_db, 'file-count-user')
    project = _project(app_db, user, 'Full project')
    digest = hashlib.sha256(b'x').hexdigest()
    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s, 'ready-' || n, 'text/plain', 1, repeat('c',64), 'ready'
        FROM generate_series(1,200) AS n""", (project['id'],))

    with pytest.raises(appstore.QuotaExceeded) as too_many:
        appstore.start_upload(app_db, user['id'], project['id'], 'next.txt', 'text/plain', 1, digest)
    _assert_code(too_many, 'files')


def test_upload_chunks_are_sequential_and_finish_verifies_sha256(app_db):
    user = _user(app_db, 'upload-user')
    project = _project(app_db, user, 'Upload project')
    data = b'first chunk and second chunk'
    digest = hashlib.sha256(data).hexdigest()
    upload = appstore.start_upload(app_db, user['id'], project['id'], 'ordered.txt', 'text/plain',
                                  len(data), digest)

    with pytest.raises(appstore.Invalid) as sequence:
        appstore.put_chunk(app_db, user['id'], upload['upload_id'], 1, b'wrong order')
    _assert_code(sequence, 'chunk_order')
    appstore.put_chunk(app_db, user['id'], upload['upload_id'], 0, data[:8])
    appstore.put_chunk(app_db, user['id'], upload['upload_id'], 1, data[8:])
    result = appstore.finish_upload(app_db, user['id'], upload['upload_id'])
    assert result['status'] == 'pending'
    assert result['sha256'] == digest
    assert (appstore.file_path(digest)).read_bytes() == data

    bad = appstore.start_upload(app_db, user['id'], project['id'], 'bad-sha.txt', 'text/plain',
                                len(data), hashlib.sha256(b'not the upload').hexdigest())
    appstore.put_chunk(app_db, user['id'], bad['upload_id'], 0, data)
    with pytest.raises(appstore.Invalid) as mismatch:
        appstore.finish_upload(app_db, user['id'], bad['upload_id'])
    _assert_code(mismatch, 'upload_integrity')
    assert app_db.execute("SELECT count(*) FROM files WHERE name='bad-sha.txt'").fetchone()[0] == 0


def test_search_returns_only_own_ready_project_files(app_db):
    from hardissoft_kb.search import vector

    alice = _user(app_db, 'search-alice')
    bob = _user(app_db, 'search-bob')
    alice_project = _project(app_db, alice, 'Alice search')
    bob_project = _project(app_db, bob, 'Bob search')
    alice_file = _file(app_db, alice, alice_project, 'alice.txt', b'private alpha document')
    bob_file = _file(app_db, bob, bob_project, 'bob.txt', b'private alpha document')
    failed_file = _file(app_db, bob, bob_project, 'failed.txt', b'private alpha failed')
    deleted_file = _file(app_db, bob, bob_project, 'deleted.txt', b'private alpha deleted')
    app_db.execute("UPDATE files SET status='failed' WHERE id=%s", (failed_file['id'],))
    app_db.execute('UPDATE files SET deleted_at=now() WHERE id=%s', (deleted_file['id'],))

    for file_row, text in ((alice_file, 'private alpha document'), (bob_file, 'private alpha document'),
                           (failed_file, 'private alpha failed'), (deleted_file, 'private alpha deleted')):
        embedding = vector.encode_texts([text], kind='passage')[0]
        vector_sql = '[' + ','.join(str(value) for value in embedding) + ']'
        app_db.execute('INSERT INTO file_chunks(file_id,idx,page,text,embedding) VALUES(%s,0,1,%s,%s::vector)',
                       (file_row['id'], text, vector_sql))

    found = appstore.search_project_files(app_db, bob['id'], bob_project['id'], 'private alpha')
    assert found
    assert {row['file_id'] for row in found} == {bob_file['id']}
    assert all(row['file_id'] != alice_file['id'] for row in found)

def test_todo_crud_is_owner_scoped_and_assistant_sources_must_match_project(app_db):
    owner = _user(app_db, 'todo-owner')
    other = _user(app_db, 'todo-other')
    project = _project(app_db, owner, 'Owner tasks')
    second_project = _project(app_db, owner, 'Second tasks')
    other_project = _project(app_db, other, 'Other tasks')
    chat = appstore.create_chat(app_db, owner['id'], project['id'])
    second_chat = appstore.create_chat(app_db, owner['id'], second_project['id'])
    other_chat = appstore.create_chat(app_db, other['id'], other_project['id'])
    assistant = appstore.add_assistant_message(
        app_db, chat['id'], 'A suggested task', None, 'general',
        '00000000-0000-0000-0000-000000000101', 'complete')
    other_assistant = appstore.add_assistant_message(
        app_db, other_chat['id'], 'Foreign answer', None, 'general',
        '00000000-0000-0000-0000-000000000102', 'complete')
    wrong_project_assistant = appstore.add_assistant_message(
        app_db, second_chat['id'], 'Other project answer', None, 'general',
        '00000000-0000-0000-0000-000000000103', 'complete')

    todo = appstore.create_todo(app_db, owner['id'], project['id'], 'Review the thermal plan',
                                source_message_id=assistant['id'])
    assert todo['project_id'] == project['id']
    assert todo['source_message_id'] == assistant['id']
    assert todo['source_chat_id'] == chat['id']
    assert todo['completed'] is False
    assert appstore.list_todos(app_db, owner['id'], project['id']) == [todo]

    completed = appstore.update_todo(app_db, owner['id'], todo['id'], completed=True)
    assert completed['completed'] is True
    assert appstore.list_todos(app_db, owner['id'], project['id'])[0]['completed'] is True
    updated = appstore.update_todo(app_db, owner['id'], todo['id'], text='Review the revised thermal plan')
    assert updated['text'] == 'Review the revised thermal plan'
    assert updated['completed'] is True

    for source in (other_assistant['id'], wrong_project_assistant['id']):
        with pytest.raises(appstore.NotFound):
            appstore.create_todo(app_db, owner['id'], project['id'], 'Invalid source', source_message_id=source)
    with pytest.raises(appstore.NotFound):
        appstore.list_todos(app_db, other['id'], project['id'])
    with pytest.raises(appstore.NotFound):
        appstore.update_todo(app_db, other['id'], todo['id'], completed=False)
    with pytest.raises(appstore.NotFound):
        appstore.delete_todo(app_db, other['id'], todo['id'])
    with pytest.raises(appstore.NotFound):
        appstore.create_todo(app_db, other['id'], other_project['id'], 'Foreign source',
                             source_message_id=assistant['id'])

    assert appstore.delete_todo(app_db, owner['id'], todo['id']) == {'deleted': True}
    assert appstore.list_todos(app_db, owner['id'], project['id']) == []


def test_brief_field_saves_compare_and_set_and_preserve_imported_notes(app_db):
    owner = _user(app_db, 'brief-owner')
    other = _user(app_db, 'brief-other')
    imported = 'Imported hardware brief'
    project = appstore.create_project(app_db, owner['id'], 'Owner brief', brief_text=imported)
    other_project = _project(app_db, other, 'Other brief')
    chat = appstore.create_chat(app_db, owner['id'], project['id'])
    assistant = appstore.add_assistant_message(
        app_db, chat['id'], 'Build a low-power sensor', None, 'general',
        '00000000-0000-0000-0000-000000000104', 'complete')

    saved = appstore.save_project_brief(
        app_db, owner['id'], project['id'], 'description', 'Build a low-power sensor', '',
        source_message_id=assistant['id'])
    assert saved['brief_fields']['description'] == 'Build a low-power sensor'
    assert saved['brief_fields']['notes'] == imported
    assert imported in saved['brief_text']
    assert 'Build a low-power sensor' in saved['brief_text']
    assert appstore.get_project(app_db, owner['id'], project['id']) == saved

    with pytest.raises(appstore.Conflict):
        appstore.save_project_brief(app_db, owner['id'], project['id'], 'description',
                                    'Stale overwrite', '')
    with pytest.raises(appstore.Invalid) as rendered_too_large:
        appstore.save_project_brief(app_db, owner['id'], project['id'], 'description',
                                    'x' * 8192, 'Build a low-power sensor')
    _assert_code(rendered_too_large, 'brief')
    with pytest.raises(appstore.NotFound):
        appstore.save_project_brief(app_db, other['id'], project['id'], 'description',
                                    'Foreign overwrite', 'Build a low-power sensor')
    with pytest.raises(appstore.NotFound):
        appstore.save_project_brief(app_db, owner['id'], project['id'], 'goal',
                                    'Foreign source', '', source_message_id=other_project['id'])


def test_file_browse_and_cross_project_attach_preserve_independent_ready_copy(app_db):
    owner = _user(app_db, 'files-owner')
    other = _user(app_db, 'files-other')
    source_project = _project(app_db, owner, 'Source project')
    target_project = _project(app_db, owner, 'Target project')
    other_project = _project(app_db, other, 'Other project')
    source = _file(app_db, owner, source_project, 'source.txt', b'copied hardware requirements')
    app_db.execute('INSERT INTO file_chunks(file_id,idx,page,text) VALUES(%s,0,1,%s)',
                   (source['id'], 'Copied searchable content'))
    legacy_size = 20 * 1024 * 1024
    legacy = app_db.execute('''INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        VALUES (%s,'legacy-large.pdf','application/pdf',%s,repeat('d',64),'ready')
        RETURNING id''', (source_project['id'], legacy_size)).fetchone()[0]
    app_db.execute("UPDATE files SET deleted_at=now() WHERE id=%s", (legacy,))

    browsed = appstore.browse_files(app_db, owner['id'])
    source_entry = next(row for row in browsed if row['id'] == source['id'])
    assert source_entry['project_id'] == source_project['id']
    assert source_entry['project_name'] == 'Source project'
    assert all(row['id'] != str(legacy) for row in browsed)
    assert all(row['project_id'] != other_project['id'] for row in browsed)
    assert appstore.browse_files(app_db, other['id']) == []

    attached = appstore.attach_file(app_db, owner['id'], target_project['id'], source['id'])
    assert attached['status'] == 'ready'
    assert attached['name'] == source['name']
    again = appstore.attach_file(app_db, owner['id'], target_project['id'], source['id'])
    assert again['id'] == attached['id']
    assert app_db.execute('SELECT count(*) FROM files WHERE project_id=%s AND deleted_at IS NULL',
                          (target_project['id'],)).fetchone()[0] == 1
    assert app_db.execute('SELECT count(*) FROM file_chunks WHERE file_id=%s',
                          (attached['id'],)).fetchone()[0] == 1

    with pytest.raises(appstore.NotFound):
        appstore.attach_file(app_db, other['id'], other_project['id'], source['id'])
    appstore.delete_file(app_db, owner['id'], attached['id'])
    reattached = appstore.attach_file(app_db, owner['id'], target_project['id'], source['id'])
    assert reattached['id'] != attached['id']
    assert reattached['status'] == 'ready'
    appstore.delete_file(app_db, owner['id'], source['id'])
    repeated_after_source_delete = appstore.attach_file(app_db, owner['id'], target_project['id'], source['id'])
    assert repeated_after_source_delete['id'] == reattached['id']
    assert appstore.list_files(app_db, owner['id'], target_project['id'])[0]['status'] == 'ready'
    assert app_db.execute('SELECT text FROM file_chunks WHERE file_id=%s', (reattached['id'],)).fetchone()[0] == \
        'Copied searchable content'
    assert app_db.execute('SELECT size_bytes FROM files WHERE id=%s', (reattached['id'],)).fetchone()[0] == len(
            b'copied hardware requirements')


def test_file_attach_enforces_user_storage_and_project_file_quotas(app_db):
    owner = _user(app_db, 'attach-quota-owner')
    project = _project(app_db, owner, 'Target')
    source_project = _project(app_db, owner, 'Source')
    source = _file(app_db, owner, source_project, 'source.txt')
    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s, 'storage-' || n, 'text/plain', %s, repeat('e',64), 'ready'
        FROM generate_series(1,52) AS n""", (project['id'], MAX_FILE_BYTES))
    with pytest.raises(appstore.QuotaExceeded) as storage:
        appstore.attach_file(app_db, owner['id'], project['id'], source['id'])
    _assert_code(storage, 'storage')

    other = _user(app_db, 'attach-count-owner')
    full_target = _project(app_db, other, 'Full target')
    other_source_project = _project(app_db, other, 'Source')
    other_source = _file(app_db, other, other_source_project, 'count-source.txt')
    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s, 'count-' || n, 'text/plain', 1, repeat('f',64), 'ready'
        FROM generate_series(1,200) AS n""", (full_target['id'],))
    with pytest.raises(appstore.QuotaExceeded) as count:
        appstore.attach_file(app_db, other['id'], full_target['id'], other_source['id'])
    _assert_code(count, 'files')


def test_upload_start_and_finish_enforce_new_file_limit_without_invalidating_stored_rows(app_db):
    owner = _user(app_db, 'new-upload-limit')
    project = _project(app_db, owner, 'Upload limits')
    digest = hashlib.sha256(b'x').hexdigest()
    upload = appstore.start_upload(app_db, owner['id'], project['id'], 'ten-mib.txt', 'text/plain',
                                   appstore.MAX_NEW_FILE_BYTES, digest)
    assert upload['chunk_bytes'] == 2 * 1024 * 1024

    with pytest.raises(appstore.Invalid) as too_large:
        appstore.start_upload(app_db, owner['id'], project['id'], 'too-large.txt', 'text/plain',
                              appstore.MAX_NEW_FILE_BYTES + 1, digest)
    _assert_code(too_large, 'file_size')

    oversized_upload_id = app_db.execute('''INSERT INTO upload_sessions
        (id,user_id,project_id,name,mime,size_bytes,sha256,received_bytes,next_index,expires_at)
        VALUES (gen_random_uuid(),%s,%s,'old-pending.txt','text/plain',%s,%s,%s,6,now()+interval '1 hour')
        RETURNING id''',
        (owner['id'], project['id'], appstore.MAX_NEW_FILE_BYTES + 1, digest,
         appstore.MAX_NEW_FILE_BYTES + 1)).fetchone()[0]
    with pytest.raises(appstore.Invalid) as finish_too_large:
        appstore.finish_upload(app_db, owner['id'], oversized_upload_id)
    _assert_code(finish_too_large, 'file_size')

    old_file = app_db.execute('''INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        VALUES (%s,'existing-large.pdf','application/pdf',%s,repeat('a',64),'ready')
        RETURNING id''', (project['id'], 20 * 1024 * 1024)).fetchone()[0]
    assert any(row['id'] == str(old_file) for row in appstore.list_files(app_db, owner['id'], project['id']))
    assert any(row['id'] == str(old_file) for row in appstore.browse_files(app_db, owner['id']))
