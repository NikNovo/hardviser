import hashlib

from hardissoft_public_chat import appstore, ingest


def _pdf_with_text(text):
    stream = ('BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET\n').encode('ascii')
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        b'/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        b'<< /Length ' + str(len(stream)).encode('ascii') + b' >>\nstream\n' + stream + b'endstream',
    ]
    data = bytearray(b'%PDF-1.4\n')
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(str(number).encode('ascii') + b' 0 obj\n' + body + b'\nendobj\n')
    xref_offset = len(data)
    data.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:
        data.extend(('%010d 00000 n \n' % offset).encode('ascii'))
    data.extend(b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n')
    data.extend(str(xref_offset).encode('ascii') + b'\n%%EOF\n')
    return bytes(data)


def _upload(conn, user, project, name, mime, data):
    result = appstore.start_upload(conn, user['id'], project['id'], name, mime,
                                   len(data), hashlib.sha256(data).hexdigest())
    for index, offset in enumerate(range(0, len(data), result['chunk_bytes'])):
        appstore.put_chunk(conn, user['id'], result['upload_id'], index,
                           data[offset:offset + result['chunk_bytes']])
    return appstore.finish_upload(conn, user['id'], result['upload_id'])


def test_ingestion_extracts_text_and_pdf_pages(app_db, caplog):
    user = appstore.create_user(app_db, 'ingest-user', 'correct horse battery staple')
    project = appstore.create_project(app_db, user['id'], 'Ingestion project')
    txt_marker = 'TXT extraction marker for ingestion'
    pdf_marker = 'PDF extraction marker for ingestion'
    txt_file = _upload(app_db, user, project, 'notes.txt', 'text/plain', txt_marker.encode('utf-8'))
    pdf_file = _upload(app_db, user, project, 'notes.pdf', 'application/pdf', _pdf_with_text(pdf_marker))

    assert ingest.process_pending(app_db, limit=10) == 2
    app_db.commit()

    statuses = {row['id']: row['status'] for row in appstore.list_files(app_db, user['id'], project['id'])}
    assert statuses[txt_file['id']] == 'ready'
    assert statuses[pdf_file['id']] == 'ready'
    chunks = app_db.execute('SELECT file_id,page,text FROM file_chunks ORDER BY file_id').fetchall()
    extracted = {str(row[0]): (row[1], row[2]) for row in chunks}
    assert txt_marker in extracted[txt_file['id']][1]
    assert extracted[txt_file['id']][0] is None
    assert pdf_marker in extracted[pdf_file['id']][1]
    assert extracted[pdf_file['id']][0] == 1
    assert txt_marker not in caplog.text
    assert pdf_marker not in caplog.text
