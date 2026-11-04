"""Server-side file classification, upload limits, and ingest integration tests."""
import hashlib

import pytest

from hardissoft_public_chat import appstore, ingest, service


MAX_NEW_UPLOAD_BYTES = 10 * 1024 * 1024
LEGACY_STORED_FILE_BYTES = 100 * 1024 * 1024


def _user(conn, login):
    return appstore.create_user(conn, login, 'correct horse battery staple')


def _upload(conn, user, project, name, data, mime=''):
    started = appstore.start_upload(conn, user['id'], project['id'], name, mime, len(data),
                                    hashlib.sha256(data).hexdigest())
    for index, offset in enumerate(range(0, len(data), started['chunk_bytes'])):
        appstore.put_chunk(conn, user['id'], started['upload_id'], index,
                           data[offset:offset + started['chunk_bytes']])
    return appstore.finish_upload(conn, user['id'], started['upload_id'])


def test_upload_type_uses_extension_and_mime_is_advisory(app_db):
    user = _user(app_db, 'formats-user')
    project = appstore.create_project(app_db, user['id'], 'Format project')
    step = b'ISO-10303-21;\nHEADER;\nENDSEC;\n'

    result = _upload(app_db, user, project, 'MODEL.STEP', step, 'application/x-unusual')
    listed = appstore.list_files(app_db, user['id'], project['id'])[0]
    assert result['kind'] == 'cad3d'
    assert result['content_level'] == 'summary'
    assert listed['kind'] == 'cad3d'
    assert listed['content_level'] == 'summary'
    assert listed['mime'] == 'application/x-unusual'

    with pytest.raises(appstore.Invalid) as unsupported:
        appstore.start_upload(app_db, user['id'], project['id'], 'payload.exe', '', 0,
                              hashlib.sha256(b'').hexdigest())
    assert unsupported.value.code == 'unsupported_type'
    with pytest.raises(appstore.Invalid) as long_mime:
        appstore.start_upload(app_db, user['id'], project['id'], 'another.txt', 'x' * 101, 0,
                              hashlib.sha256(b'').hexdigest())
    assert long_mime.value.code == 'mime'


def test_new_upload_and_user_storage_limits_are_enforced(app_db):
    user = _user(app_db, 'large-user')
    project = appstore.create_project(app_db, user['id'], 'Large uploads')
    other_project = appstore.create_project(app_db, user['id'], 'Storage quota')
    digest = hashlib.sha256(b'x').hexdigest()

    started = appstore.start_upload(app_db, user['id'], project['id'], 'large.txt', '', MAX_NEW_UPLOAD_BYTES, digest)
    assert started['chunk_bytes'] == 2 * 1024 * 1024
    with pytest.raises(appstore.Invalid) as too_large:
        appstore.start_upload(app_db, user['id'], project['id'], 'too-large.txt', '',
                              MAX_NEW_UPLOAD_BYTES + 1, digest)
    assert too_large.value.code == 'file_size'

    app_db.execute("""INSERT INTO files(project_id,name,mime,size_bytes,sha256,status)
        SELECT %s,'used-' || n,'',%s,repeat('a',64),'ready' FROM generate_series(1,52) AS n""",
        (project['id'], LEGACY_STORED_FILE_BYTES))
    with pytest.raises(appstore.QuotaExceeded) as storage:
        appstore.start_upload(app_db, user['id'], other_project['id'], 'next.step', '', 1, digest)
    assert storage.value.code == 'storage'


def test_service_upload_schema_enforces_new_upload_limit_and_file_metadata():
    value = {
        'request_id': '12345678-1234-5678-1234-567812345678',
        'session_token': 'session',
        'project_id': '22345678-1234-5678-1234-567812345678',
        'name': 'board.STEP', 'mime': '', 'size_bytes': MAX_NEW_UPLOAD_BYTES,
        'sha256': 'a' * 64,
    }
    assert service._validate_body('/files/upload/start', value) is True
    assert service._validate_body('/files/upload/start',
                                  {**value, 'size_bytes': MAX_NEW_UPLOAD_BYTES + 1}) is False
    assert service._validate_body('/files/upload/start', {**value, 'name': 'payload.exe'}) == 'unsupported_type'
    assert service._validate_body('/files/upload/start', {**value, 'mime': 'x' * 101}) is False


def test_ingest_indexes_summary_and_stored_metadata_as_ready_files(app_db, monkeypatch):
    user = _user(app_db, 'ingest-formats-user')
    project = appstore.create_project(app_db, user['id'], 'Ingest formats')
    schematic = b'''(kicad_sch (version 20231120) (property "Reference" "U1")
      (property "Value" "Controller") (label "DATA_READY"))'''
    proprietary = b'private proprietary payload bytes'
    schematic_row = _upload(app_db, user, project, 'controller.kicad_sch', schematic)
    stored_row = _upload(app_db, user, project, 'controller.dwg', proprietary)
    monkeypatch.setattr(ingest, '_embed', lambda texts: [[0.01] * 384 for _ in texts])

    assert ingest.process_pending(app_db, limit=2) == 2
    app_db.commit()
    files = {row['id']: row for row in appstore.list_files(app_db, user['id'], project['id'])}
    assert files[schematic_row['id']]['status'] == 'ready'
    assert files[schematic_row['id']]['kind'] == 'schematic'
    assert files[schematic_row['id']]['content_level'] == 'summary'
    assert files[stored_row['id']]['status'] == 'ready'
    assert files[stored_row['id']]['kind'] == 'stored'
    assert files[stored_row['id']]['content_level'] == 'stored'

    chunks = app_db.execute('SELECT file_id,text FROM file_chunks ORDER BY file_id,idx').fetchall()
    summary_text = next(row[1] for row in chunks if str(row[0]) == schematic_row['id'])
    stored_chunks = [row[1] for row in chunks if str(row[0]) == stored_row['id']]
    assert summary_text.startswith('[KiCad schematic summary — not the full design]')
    assert 'DATA_READY' in summary_text
    assert len(stored_chunks) == 1
    assert stored_chunks[0].startswith('[Stored DWG — content not readable]')
    assert 'private proprietary payload bytes' not in stored_chunks[0]


def test_partial_content_levels_are_carried_into_answer_context():
    from hardissoft_public_chat import orchestrator

    file_excerpts = [
        {'file_id': '32345678-1234-5678-1234-567812345678', 'name': 'board.step', 'page': None,
         'kind': 'cad3d', 'content_level': 'summary', 'text': '[STEP summary — not the full design] Part: bracket'},
        {'file_id': '42345678-1234-5678-1234-567812345678', 'name': 'design.dwg', 'page': None,
         'kind': 'stored', 'content_level': 'stored', 'text': '[Stored DWG — content not readable] Name: design.dwg'},
    ]
    calls = []

    def model_call(messages, **_kwargs):
        calls.extend(messages)
        return {'data': {'answer': 'The excerpts are partial.', 'recommendations': [], 'unknowns': [],
                         'follow_up_questions': {'general': [], 'technical': []}}}

    orchestrator.build_answer('Summarize these files.', [], [], route='general',
                              project_context={'name': 'Board', 'text': ''}, model_call=model_call,
                              timeout=5, file_excerpts=file_excerpts)
    prompt = '\n'.join(message['content'] for message in calls)
    assert 'content_level' in prompt and 'summary' in prompt and 'stored' in prompt
    assert 'partial' in prompt.casefold()
    assert 'geometry' in prompt.casefold() and 'routing' in prompt.casefold()
