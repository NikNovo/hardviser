"""Ensure chat bridge logs exclude user and selected file content."""
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
import uuid

from hardissoft_public_chat import muse, service

KEY = 'a' * 64
TOKEN = 'private-session-token'
LOGIN = 'private-login-marker'
QUESTION = 'private-question-marker'
FILENAME = 'private-file-name-marker.txt'
USER_ID = '12345678-1234-5678-1234-567812345678'


class Connection:
    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class NotFound(Exception):
    pass


class Invalid(Exception):
    def __init__(self, code):
        self.code = code


class QuotaExceeded(Exception):
    pass


class ServiceLogSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {
            'SEVERUS_RAG_BRIDGE_HMAC_KEY': KEY,
            'HIS_KB_PUBLIC_CHAT_STATE_DB': str(Path(self.tmp.name) / 'state.sqlite3'),
        })
        self.env.start()
        self.store = types.SimpleNamespace(
            connect=Mock(return_value=Connection()), NotFound=NotFound, Invalid=Invalid,
            QuotaExceeded=QuotaExceeded,
            resolve_session=Mock(return_value={'id': USER_ID, 'login': LOGIN}),
        )
        self.server = service.create_server(host='127.0.0.1', port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()
        self.tmp.cleanup()

    def post_ask(self):
        request_id = str(uuid.uuid4())
        value = {'request_id': request_id, 'session_token': TOKEN,
                 'chat_id': USER_ID, 'question': QUESTION, 'mentions': [], 'route_mode': 'auto'}
        path = service.PATH + '/ask'
        raw = json.dumps(value, separators=(',', ':')).encode()
        timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
        headers = {'Content-Type': 'application/json', 'Content-Length': str(len(raw)),
                   'X-RAG-Timestamp': timestamp, 'X-RAG-Nonce': nonce,
                   'X-RAG-Signature': service.sign(KEY, 'POST', path, timestamp, nonce, raw)}
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('POST', path, body=raw, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return request_id, result

    def test_logs_exclude_token_login_question_file_name_and_file_text(self):
        answer = {'answer': 'Synthetic saved-file answer.', 'recommendations': [], 'unknowns': [],
                  'follow_up_questions': {'general': [], 'technical': []}}

        def ask(prepared, question, *, request_id, route_mode, on_progress):
            for event in (
                {'type': 'progress', 'stage': 'classifying'},
                {'type': 'progress', 'stage': 'classified', 'route': 'general'},
                {'type': 'progress', 'stage': 'project_context', 'available': True},
                {'type': 'progress', 'stage': 'reading_files', 'count': 1},
                {'type': 'progress', 'stage': 'answering'},
            ):
                on_progress(event)
            return {'request_id': request_id, 'message_id': str(uuid.uuid4()), 'route': 'general', **answer,
                    'model': muse.MODEL, 'usage': {'prompt_tokens': 2, 'completion_tokens': 3}}

        output = io.StringIO()
        with contextlib.redirect_stderr(output), \
                patch.object(service, 'appstore', self.store), \
                patch.object(service.orchestrator, 'prepare_ask', return_value={
                    'project_context': {'name': 'Project', 'text': ''},
                    'file_excerpts': [{'name': FILENAME, 'text': 'private file text marker'}]}), \
                patch.object(service.orchestrator, 'ask', side_effect=ask):
            _, (status, raw) = self.post_ask()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw.decode().splitlines()[-1])['type'], 'result')
        log = output.getvalue()
        for private_value in (TOKEN, LOGIN, QUESTION, FILENAME, 'private file text marker'):
            self.assertNotIn(private_value, log)
        self.assertIn('"op":"ask"', log)
        self.assertNotIn('"client_disconnected":true', log)

    def test_internal_error_logs_exception_class_but_never_its_message(self):
        class LeakyError(RuntimeError):
            pass

        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            service._log(503, time.monotonic(), request_id=str(uuid.uuid4()), op='ask', user_ref=None,
                         code='service_unavailable', error_class='internal_error',
                         error=LeakyError('private-exception-message ' + QUESTION))
        entry = json.loads(output.getvalue())
        self.assertTrue(entry['error_type'].endswith('LeakyError'))
        self.assertNotIn('private-exception-message', output.getvalue())
        self.assertNotIn(QUESTION, output.getvalue())

    def test_admin_mutation_logs_metadata_not_reason_email_or_session_token(self):
        token = 'private-admin-session-token'
        reason = 'private-admin-reason-marker'
        email = 'private-admin-email@example.test'
        identity = {'id': USER_ID, 'login': LOGIN, 'display_name': None, 'roles': ['admin']}
        admin_user = {'id': uuid.uuid4().__str__(), 'login': 'target-user',
                      'display_name': None, 'roles': [], 'email': email,
                      'created_at': '2026-11-02T12:00:00+00:00',
                      'disabled_at': None, 'revision': 1}
        self.store.resolve_session.return_value = identity

        class AdminError(Exception):
            def __init__(self, code):
                self.code = code

        admin = types.SimpleNamespace(set_roles=Mock(return_value=admin_user), AdminError=AdminError)
        request_id = str(uuid.uuid4())
        path = service.PATH + '/admin/users/roles/set'
        value = {'request_id': request_id, 'session_token': token, 'user_id': admin_user['id'],
                 'roles': [], 'expected_revision': 0, 'reason': reason}
        raw = json.dumps(value, separators=(',', ':')).encode()
        timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
        headers = {'Content-Type': 'application/json', 'Content-Length': str(len(raw)),
                   'X-RAG-Timestamp': timestamp, 'X-RAG-Nonce': nonce,
                   'X-RAG-Signature': service.sign(KEY, 'POST', path, timestamp, nonce, raw)}
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        output = io.StringIO()
        try:
            with contextlib.redirect_stderr(output), patch.object(service, 'appstore', self.store), \
                    patch.object(service, 'adminstore', admin, create=True):
                connection.request('POST', path, body=raw, headers=headers)
                response = connection.getresponse()
                payload = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(payload['data']['email'], email)
        finally:
            connection.close()
        log = output.getvalue()
        self.assertIn('\"request_id\":\"' + request_id + '\"', log)
        self.assertIn('\"op\":\"admin.users.roles.set\"', log)
        self.assertIn('\"status\":200', log)
        for private_value in (token, reason, email):
            self.assertNotIn(private_value, log)


if __name__ == '__main__':
    unittest.main()
