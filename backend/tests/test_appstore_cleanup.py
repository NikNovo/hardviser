import hashlib

from hardissoft_public_chat import appstore


def _upload(conn, user, project, name, data):
    digest = hashlib.sha256(data).hexdigest()
    upload = appstore.start_upload(conn, user['id'], project['id'], name, 'text/plain',
                                   len(data), digest)
    appstore.put_chunk(conn, user['id'], upload['upload_id'], 0, data)
    result = appstore.finish_upload(conn, user['id'], upload['upload_id'])
    conn.execute("UPDATE files SET status='ready' WHERE id=%s", (result['id'],))
    return result, digest


def test_project_and_chat_mutations_return_updated_records(app_db):
    user = appstore.create_user(app_db, 'mutation-user', 'correct horse battery staple')
    project = appstore.create_project(app_db, user['id'], 'Before', 'initial brief')
    changed_project = appstore.update_project(app_db, user['id'], project['id'],
                                              name='After', brief_text='updated brief')
    assert changed_project['name'] == 'After'
    assert changed_project['brief_text'] == 'updated brief'
    assert appstore.get_project(app_db, user['id'], project['id']) == changed_project

    chat = appstore.create_chat(app_db, user['id'], project['id'])
    changed_chat = appstore.update_chat(app_db, user['id'], chat['id'], title='Renamed',
                                        mode='technical')
    assert changed_chat['project_id'] == project['id']
    assert changed_chat['title'] == 'Renamed'
    assert changed_chat['mode'] == 'technical'
    assert appstore.get_chat(app_db, user['id'], chat['id']) == changed_chat


def test_delete_file_unpins_and_queues_blob_cleanup(app_db):
    user = appstore.create_user(app_db, 'cleanup-user', 'correct horse battery staple')
    project = appstore.create_project(app_db, user['id'], 'Cleanup project')
    chat = appstore.create_chat(app_db, user['id'], project['id'])
    file_row, digest = _upload(app_db, user, project, 'cleanup.txt', b'cleanup content')
    appstore.update_chat(app_db, user['id'], chat['id'], pinned=[file_row['id']])
    app_db.execute('INSERT INTO file_chunks(file_id,idx,text) VALUES(%s,0,%s)',
                   (file_row['id'], 'private extracted text'))

    assert appstore.delete_file(app_db, user['id'], file_row['id']) == {}
    assert appstore.list_files(app_db, user['id'], project['id']) == []
    assert appstore.get_chat(app_db, user['id'], chat['id'])['pinned'] == []
    assert app_db.execute('SELECT count(*) FROM file_chunks WHERE file_id=%s',
                          (file_row['id'],)).fetchone()[0] == 0
    assert app_db.execute('SELECT count(*) FROM blob_gc WHERE sha256=%s',
                          (digest,)).fetchone()[0] == 1


def test_delete_project_schedules_blobs_for_garbage_collection(app_db):
    user = appstore.create_user(app_db, 'project-delete-user', 'correct horse battery staple')
    project = appstore.create_project(app_db, user['id'], 'Delete project')
    _, digest = _upload(app_db, user, project, 'project.txt', b'project content')

    assert appstore.delete_project(app_db, user['id'], project['id']) == {}
    assert appstore.list_projects(app_db, user['id']) == []
    assert app_db.execute('SELECT count(*) FROM blob_gc WHERE sha256=%s',
                          (digest,)).fetchone()[0] == 1


def test_error_assistant_message_accepts_null_route_and_payload(app_db):
    user = appstore.create_user(app_db, 'error-message-user', 'correct horse battery staple')
    project = appstore.create_project(app_db, user['id'], 'Error message project')
    chat = appstore.create_chat(app_db, user['id'], project['id'])

    message = appstore.add_assistant_message(
        app_db, chat['id'], 'The answer could not be generated.', None, None,
        '00000000-0000-0000-0000-000000000005', 'error')
    assert message['id']
    assert message['status'] == 'error'
    assert message['route'] is None
    assert message['payload'] is None
    assert appstore.list_messages(app_db, user['id'], chat['id']) == [message]
