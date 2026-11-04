"""Tests for authenticated app operations and the per-user NDJSON chat bridge."""
import contextlib
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

from hardissoft_public_chat import service, state

KEY = 'a' * 64
USER_ID = '12345678-1234-5678-1234-567812345678'
SESSION = 'secret-session-token-value'
IDENTITY = {'id': USER_ID, 'login': 'safe-login', 'display_name': 'Safe User', 'roles': []}


def body(**extra):
    return {'request_id': str(uuid.uuid4()), **extra}


def answer(request_id):
    return {'request_id': request_id, 'message_id': str(uuid.uuid4()), 'route': 'technical',
            'answer': 'Synthetic response.', 'recommendations': [], 'unknowns': [],
            'follow_up_questions': {'general': [], 'technical': []}, 'model': 'muse-spark-1.3',
            'usage': {'prompt_tokens': 4, 'completion_tokens': 2}}


class FakeConnection:
    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class StoreError(Exception):
    def __init__(self, code='invalid'):
        self.code = code


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


class QuotaExceeded(Exception):
    pass


class AdminStoreError(Exception):
    def __init__(self, code):
        self.code = code


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {
            'SEVERUS_RAG_BRIDGE_HMAC_KEY': KEY,
            'HIS_KB_PUBLIC_CHAT_STATE_DB': str(Path(self.tmp.name) / 'state.sqlite3'),
        })
        self.environment.start()
        self.server = service.create_server(host='127.0.0.1', port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.store = types.SimpleNamespace(
            connect=Mock(return_value=FakeConnection()), Invalid=StoreError, NotFound=NotFound,
            Conflict=Conflict, QuotaExceeded=QuotaExceeded,
            authenticate=Mock(return_value=IDENTITY),
            create_session=Mock(return_value=('new-session-token', '2030-01-01T00:00:00+00:00')),
            resolve_session=Mock(return_value=IDENTITY),
            account_identity=Mock(return_value=IDENTITY),
            update_account_profile=Mock(return_value=IDENTITY),
            revoke_session=Mock(return_value=None),
        )
        for name in ('list_projects', 'create_project', 'update_project', 'delete_project',
                     'list_chats', 'create_chat', 'update_chat', 'delete_chat', 'list_messages',
                     'list_files', 'browse_files', 'attach_file', 'delete_file', 'start_upload',
                     'put_chunk', 'finish_upload', 'list_todos', 'create_todo', 'update_todo',
                     'delete_todo', 'save_project_brief'):
            setattr(self.store, name, Mock(return_value={'stored': name}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.environment.stop()
        self.tmp.cleanup()

    def post(self, path, value):
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
        headers = {'Content-Type': 'application/json', 'Content-Length': str(len(raw)),
                   'X-RAG-Timestamp': timestamp, 'X-RAG-Nonce': nonce,
                   'X-RAG-Signature': service.sign(KEY, 'POST', path, timestamp, nonce, raw)}
        import http.client
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        connection.request('POST', path, body=raw, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read()
        connection.close()
        return result

    def authed(self, **extra):
        return body(session_token=SESSION, **extra)

    def with_store(self):
        return patch.object(service, 'appstore', self.store, create=True)

    def test_authentication_is_required_and_old_root_ask_is_removed(self):
        with self.with_store():
            status, raw = self.post(service.PATH + '/projects/list', body())
            self.assertEqual(status, 401)
            self.assertEqual(json.loads(raw)['code'], 'unauthorized')
            status, raw = self.post(service.PATH, body(session_token=SESSION, question='old route'))
            self.assertEqual(status, 404)
        self.store.list_projects.assert_not_called()

    def test_every_app_operation_routes_to_its_store_function(self):
        cases = [
            ('/auth/login', body(client_bucket='b' * 64, login='safe-login', password='secret-password'), 'authenticate'),
            ('/auth/logout', self.authed(), 'revoke_session'),
            ('/auth/me', self.authed(), 'account_identity'),
            ('/account/profile/update', self.authed(display_name='Updated User'), 'update_account_profile'),
            ('/projects/list', self.authed(), 'list_projects'),
            ('/projects/create', self.authed(name='Project', brief_text=''), 'create_project'),
            ('/projects/update', self.authed(project_id=USER_ID, name='Renamed'), 'update_project'),
            ('/projects/delete', self.authed(project_id=USER_ID), 'delete_project'),
            ('/projects/brief/save', self.authed(project_id=USER_ID, field='notes', text='Notes',
                                                expected_text='', source_message_id=USER_ID), 'save_project_brief'),
            ('/chats/list', self.authed(project_id=USER_ID), 'list_chats'),
            ('/chats/create', self.authed(project_id=USER_ID, title='Chat'), 'create_chat'),
            ('/chats/update', self.authed(chat_id=USER_ID, mode='technical', pinned=[]), 'update_chat'),
            ('/chats/delete', self.authed(chat_id=USER_ID), 'delete_chat'),
            ('/messages/list', self.authed(chat_id=USER_ID), 'list_messages'),
            ('/todos/list', self.authed(project_id=USER_ID), 'list_todos'),
            ('/todos/create', self.authed(project_id=USER_ID, text='Create a test plan',
                                          source_message_id=USER_ID), 'create_todo'),
            ('/todos/update', self.authed(todo_id=USER_ID, text='Update the test plan', completed=False),
             'update_todo'),
            ('/todos/delete', self.authed(todo_id=USER_ID), 'delete_todo'),
            ('/files/list', self.authed(project_id=USER_ID), 'list_files'),
            ('/files/browse', self.authed(), 'browse_files'),
            ('/files/attach', self.authed(project_id=USER_ID, file_id=USER_ID), 'attach_file'),
            ('/files/delete', self.authed(file_id=USER_ID), 'delete_file'),
            ('/files/upload/start', self.authed(project_id=USER_ID, name='notes.txt', mime='text/plain',
                                                size_bytes=10, sha256='c' * 64), 'start_upload'),
            ('/files/upload/chunk', self.authed(upload_id=USER_ID, index=0, data_b64='aGVsbG8='), 'put_chunk'),
            ('/files/upload/finish', self.authed(upload_id=USER_ID), 'finish_upload'),
        ]
        for suffix, value, method in cases:
            with self.subTest(path=suffix), self.with_store():
                status, raw = self.post(service.PATH + suffix, value)
                self.assertEqual(status, 200, raw)
                self.assertIn('data', json.loads(raw))
                getattr(self.store, method).assert_called()
    def test_billing_status_and_sync_use_session_user_and_strict_response(self):
        snapshot = {
            'environment': 'sandbox', 'plan': 'free',
            'expires_at': None, 'verified_at': None,
        }
        with self.with_store(), patch.dict(os.environ, {
                'REVENUECAT_ENVIRONMENT': 'sandbox',
                'REVENUECAT_API_KEY': 'sandbox-secret-key',
                'REVENUECAT_PROJECT_ID': '73c96e0c',
                'REVENUECAT_APP_ID': 'app96e448cc36',
        }), patch.object(service.billing, 'status', return_value=snapshot) as read_status, \
                patch.object(service.billing, 'sync_user', return_value=snapshot) as sync_user:
            status, raw = self.post(service.PATH + '/billing/status', self.authed())
            self.assertEqual(status, 200, raw)
            self.assertEqual(json.loads(raw)['data'], snapshot)
            self.assertEqual(read_status.call_args.args[1], USER_ID)
            status, raw = self.post(service.PATH + '/billing/sync', self.authed())
            self.assertEqual(status, 200, raw)
            self.assertEqual(json.loads(raw)['data'], snapshot)
            sync_user.assert_called_once_with(USER_ID)
            status, raw = self.post(
                service.PATH + '/billing/status', self.authed(user_id=USER_ID))
            self.assertEqual(status, 400)
            read_status.return_value = {**snapshot, 'user_id': USER_ID}
            status, raw = self.post(service.PATH + '/billing/status', self.authed())
            self.assertEqual(status, 502)
            self.assertEqual(json.loads(raw)['code'], 'invalid_response')

    def test_revenuecat_webhook_uses_only_signed_dedicated_bridge_operation(self):
        payload = {'api_version': '1.0', 'event': {'id': 'evt-test', 'type': 'TEST'}}
        with patch.object(service.billing, 'process_webhook', return_value='ignored') as process:
            status, raw = self.post(service.PATH + '/revenuecat-webhook', body(payload=payload))
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['data'], {'accepted': True})
        process.assert_called_once_with(payload)

    def test_billing_sync_limiter_is_per_authenticated_user_and_expires(self):
        limiter = service._BillingSyncLimiter()
        with patch.object(service.time, 'monotonic', side_effect=(0.0, 1.0, 2.0, 16.0)):
            self.assertTrue(limiter.admit(USER_ID))
            self.assertFalse(limiter.admit(USER_ID))
            self.assertTrue(limiter.admit('22345678-1234-5678-1234-567812345678'))
            self.assertTrue(limiter.admit(USER_ID))

    def test_per_operation_validation_rejects_missing_fields_and_extra_messages_limit(self):
        cases = [
            ('/projects/create', self.authed(name='Project')),
            ('/projects/update', self.authed(project_id=USER_ID)),
            ('/chats/list', self.authed()),
            ('/chats/update', self.authed(chat_id=USER_ID, limit=4)),
            ('/messages/list', self.authed(chat_id=USER_ID, limit=1)),
            ('/todos/list', self.authed()),
            ('/todos/create', self.authed(project_id=USER_ID, text='')),
            ('/todos/update', self.authed(todo_id=USER_ID)),
            ('/todos/update', self.authed(todo_id=USER_ID, completed=1)),
            ('/todos/delete', self.authed(todo_id='not-a-uuid')),
            ('/projects/brief/save', self.authed(project_id=USER_ID, field='invalid',
                                                text='New', expected_text='')),
            ('/projects/brief/save', self.authed(project_id=USER_ID, field='notes', text='New')),
            ('/files/browse', self.authed(project_id=USER_ID)),
            ('/files/attach', self.authed(project_id=USER_ID)),
            ('/files/upload/start', self.authed(project_id=USER_ID, name='x.txt', mime='text/plain',
                                                size_bytes=True, sha256='c' * 64)),
            ('/files/upload/chunk', self.authed(upload_id=USER_ID, index=0, data_b64='not-base64')),
        ]
        with self.with_store():
            for suffix, value in cases:
                with self.subTest(path=suffix):
                    status, raw = self.post(service.PATH + suffix, value)
                    self.assertEqual(status, 400)
                    self.assertEqual(json.loads(raw)['code'], 'invalid_request')
        for name in ('create_project', 'update_project', 'list_chats', 'update_chat', 'list_messages',
                     'list_todos', 'create_todo', 'update_todo', 'delete_todo', 'save_project_brief',
                     'browse_files', 'attach_file', 'start_upload', 'put_chunk'):
            getattr(self.store, name).assert_not_called()

    def test_admin_dispatch_passes_raw_session_and_rejects_unexpected_dto_fields(self):
        self.store.resolve_session.return_value = {**IDENTITY, 'roles': ['admin']}
        admin_user = {
            'id': USER_ID, 'login': 'safe-login', 'display_name': 'Safe User', 'roles': ['expert'],
            'email': 'safe@example.test', 'created_at': '2026-11-02T12:00:00+00:00',
            'disabled_at': None, 'revision': 2,
        }
        admin = types.SimpleNamespace(
            list_users=Mock(return_value={'items': [admin_user], 'next_cursor': None}),
            AdminError=AdminStoreError)
        value = self.authed(query='alice', role='expert', status='active', limit=20)
        with self.with_store(), patch.object(service, 'adminstore', admin, create=True):
            status, raw = self.post(service.PATH + '/admin/users/list', value)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['data']['items'], [admin_user])
        args, kwargs = admin.list_users.call_args
        self.assertEqual(args[1], SESSION)
        self.assertEqual(kwargs, {
            'query': 'alice', 'role': 'expert', 'status': 'active', 'cursor': None, 'limit': 20})

        admin.list_users.return_value = {
            'items': [{**admin_user, 'password_hash': 'must-not-leave-the-bridge'}],
            'next_cursor': None,
        }
        with self.with_store(), patch.object(service, 'adminstore', admin, create=True):
            status, raw = self.post(service.PATH + '/admin/users/list', self.authed())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(raw)['code'], 'invalid_response')
        self.assertNotIn('must-not-leave-the-bridge', raw.decode())

    def test_admin_store_errors_keep_their_http_authorization_meaning(self):
        self.store.resolve_session.return_value = {**IDENTITY, 'roles': ['admin']}
        admin = types.SimpleNamespace(
            list_users=Mock(), AdminError=AdminStoreError)
        for error, expected_status, expected_code in (
                ('forbidden', 403, 'forbidden'),
                ('stale_user', 409, 'stale_user'),
                ('self_protection', 409, 'self_protection'),
                ('last_admin', 409, 'last_admin')):
            with self.subTest(error=error):
                admin.list_users.side_effect = AdminStoreError(error)
                with self.with_store(), patch.object(service, 'adminstore', admin, create=True):
                    status, raw = self.post(service.PATH + '/admin/users/list', self.authed())
                self.assertEqual(status, expected_status)
                self.assertEqual(json.loads(raw)['code'], expected_code)

    def test_profile_update_returns_self_identity_and_identity_secrets_never_leave_bridge(self):
        updated = {**IDENTITY, 'display_name': 'Ada Lovelace'}
        self.store.update_account_profile.return_value = updated
        with self.with_store():
            status, raw = self.post(
                service.PATH + '/account/profile/update',
                self.authed(display_name='Ada Lovelace'))
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['data'], updated)
        args, _ = self.store.update_account_profile.call_args
        self.assertEqual(args[1:], (USER_ID, 'Ada Lovelace'))

        with self.with_store():
            status, raw = self.post(service.PATH + '/auth/me', self.authed())
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['data'], IDENTITY)

        self.store.account_identity.return_value = {**IDENTITY, 'password_hash': 'private-secret'}
        with self.with_store():
            status, raw = self.post(service.PATH + '/auth/me', self.authed())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(raw)['code'], 'invalid_response')
        self.assertNotIn('private-secret', raw.decode())

    def test_brief_save_accepts_maximum_fields_with_json_escaping(self):
        escaped = '\x01' * 8192
        with self.with_store():
            status, raw = self.post(service.PATH + '/projects/brief/save', self.authed(
                project_id=USER_ID, field='notes', text=escaped, expected_text=escaped))
            self.assertEqual(status, 200, raw)
            self.store.save_project_brief.assert_called_once()

    def test_stale_brief_conflict_maps_to_http_409(self):
        self.store.save_project_brief.side_effect = Conflict()
        with self.with_store():
            status, raw = self.post(service.PATH + '/projects/brief/save', self.authed(
                project_id=USER_ID, field='notes', text='New', expected_text='Old'))
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(raw)['code'], 'conflict')


    def test_new_upload_limit_accepts_ten_mib_and_rejects_one_byte_more(self):
        with self.with_store():
            status, raw = self.post(service.PATH + '/files/upload/start', self.authed(
                project_id=USER_ID, name='ten-mib.txt', mime='text/plain',
                size_bytes=10 * 1024 * 1024, sha256='c' * 64))
            self.assertEqual(status, 200, raw)
            self.store.start_upload.assert_called_once()
            self.store.start_upload.reset_mock()

            status, raw = self.post(service.PATH + '/files/upload/start', self.authed(
                project_id=USER_ID, name='too-large.txt', mime='text/plain',
                size_bytes=10 * 1024 * 1024 + 1, sha256='c' * 64))
            self.assertEqual(status, 400, raw)
            self.assertEqual(json.loads(raw)['code'], 'invalid_request')
            self.store.start_upload.assert_not_called()

    def test_login_response_and_unsupported_upload_type_are_sanitized(self):
        output = io.StringIO()
        self.store.start_upload.side_effect = StoreError('unsupported_type')
        with contextlib.redirect_stderr(output), self.with_store():
            status, raw = self.post(service.PATH + '/auth/login', body(
                client_bucket='b' * 64, login='private-login-marker', password='private-password-marker'))
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(raw)['data'], {
                **IDENTITY, 'token': 'new-session-token',
                'expires_at': '2030-01-01T00:00:00+00:00'})
            self.store.account_identity.assert_called_once()
            status, raw = self.post(service.PATH + '/files/upload/start', self.authed(
                project_id=USER_ID, name='private-file-marker.exe', mime='application/x-msdownload',
                size_bytes=10, sha256='c' * 64))
            self.assertEqual(status, 400)
            self.assertEqual(json.loads(raw)['code'], 'unsupported_type')
        logs = output.getvalue()
        for secret in ('private-login-marker', 'private-password-marker', 'new-session-token', 'private-file-marker'):
            self.assertNotIn(secret, logs)

    def test_login_throttles_after_ten_failures_per_login_and_client_bucket(self):
        login = 'limited-' + uuid.uuid4().hex[:20]
        bucket = uuid.uuid4().hex * 2
        self.store.authenticate.return_value = None
        statuses = []
        with self.with_store():
            for _ in range(11):
                status, _ = self.post(service.PATH + '/auth/login', body(
                    client_bucket=bucket, login=login, password='bad-password'))
                statuses.append(status)
        self.assertEqual(statuses, [401] * 10 + [429])
        self.assertEqual(self.store.authenticate.call_count, 10)

    def test_ask_routes_server_context_and_emits_message_id_result(self):
        value = self.authed(chat_id=USER_ID, question='private question marker?', mentions=[], route_mode='technical')
        expected = answer(value['request_id'])

        def generate(prepared, question, *, request_id, route_mode, on_progress):
            for event in (
                {'type': 'progress', 'stage': 'classifying'},
                {'type': 'progress', 'stage': 'classified', 'route': 'technical'},
                {'type': 'progress', 'stage': 'project_context', 'available': True},
                {'type': 'progress', 'stage': 'reading_files', 'count': 1},
                {'type': 'progress', 'stage': 'searching', 'queries': ['safe query']},
                {'type': 'progress', 'stage': 'answering'},
            ):
                on_progress(event)
            return expected

        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.with_store(), \
                patch.object(service.orchestrator, 'prepare_ask', return_value={'project_context': 'from database'}, create=True) as prepare, \
                patch.object(service.orchestrator, 'ask', side_effect=generate) as generate_mock:
            status, raw = self.post(service.PATH + '/ask', value)
        self.assertEqual(status, 200)
        events = [json.loads(line) for line in raw.decode().splitlines()]
        self.assertEqual([event.get('stage') for event in events[:-1]],
                         ['accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'searching', 'answering'])
        self.assertEqual(events[-1]['data'], expected)
        prepare.assert_called_once()
        generate_mock.assert_called_once()
        for secret in ('secret-session-token-value', 'safe-login', 'private question marker?', 'safe query'):
            self.assertNotIn(secret, output.getvalue())

    def test_public_email_auth_routes_are_unauthenticated_and_return_internal_shapes(self):
        request_result = {'email': 'person@example.com', 'token': 't' * 43,
                          'expires_at': '2030-01-01T00:15:00+00:00', 'return_to': '/projects/list'}
        prepare_result = {'email': 'person@example.com',
                          'expires_at': '2030-01-01T00:15:00+00:00', 'return_to': '/projects/list'}
        consume_result = {**IDENTITY, 'login': 'person@example.com',
                          'token': 'ordinary-session-token',
                          'expires_at': '2030-01-01T12:00:00+00:00'}
        cases = (
            ('/auth/email/request', {'email': 'person@example.com', 'client_bucket': 'b' * 64,
                                     'return_to': '/projects/list'}, request_result),
            ('/auth/email/prepare', {'token': 't' * 43, 'client_bucket': 'b' * 64}, prepare_result),
            ('/auth/email/consume', {'token': 't' * 43, 'client_bucket': 'b' * 64}, consume_result),
        )
        with self.with_store(), \
                patch.object(service.emailauth, 'request_link', return_value=request_result) as request_link, \
                patch.object(service.emailauth, 'prepare_link', return_value=prepare_result) as prepare_link, \
                patch.object(service.emailauth, 'consume_link', return_value=consume_result) as consume_link:
            for suffix, fields, expected in cases:
                status, raw = self.post(service.PATH + suffix, body(**fields))
                self.assertEqual(status, 200, raw)
                self.assertEqual(json.loads(raw)['data'], expected)
        request_link.assert_called_once()
        prepare_link.assert_called_once()
        consume_link.assert_called_once()
        self.store.authenticate.assert_not_called()
        self.store.resolve_session.assert_not_called()

        with self.with_store(), patch.object(
                service.emailauth, 'prepare_link', side_effect=StoreError('invalid_link')):
            status, raw = self.post(service.PATH + '/auth/email/prepare',
                                    body(token='t' * 43, client_bucket='c' * 64))
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw)['code'], 'invalid_link')

        with self.with_store(), patch.object(
                service.emailauth, 'request_link', side_effect=QuotaExceeded('limited')):
            status, raw = self.post(service.PATH + '/auth/email/request', body(
                email='person@example.com', client_bucket='d' * 64, return_to='/'))
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(raw)['code'], 'quota_exceeded')

    def test_per_user_ask_limits_are_five_per_minute_and_fifty_per_day(self):
        now = 86400 * 3
        user_ref = 'd' * 64
        for index in range(5):
            state.admit_ask(user_ref, str(uuid.uuid4()), f'{index:032x}', now)
        with self.assertRaises(state.QuotaExceeded):
            state.admit_ask(user_ref, str(uuid.uuid4()), 'f' * 32, now)
        state.admit_ask('e' * 64, str(uuid.uuid4()), 'e' * 32, now)

        daily_ref = 'c' * 64
        for index in range(50):
            state.admit_ask(daily_ref, str(uuid.uuid4()), f'{index + 100:032x}', now + (index // 5) * 61)
        with self.assertRaises(state.QuotaExceeded):
            state.admit_ask(daily_ref, str(uuid.uuid4()), 'a' * 32, now + 1200)

    def test_broken_stream_writer_is_recorded_without_aborting_progress(self):
        class Writer:
            def __init__(self):
                self.writes = 0
                self.data = bytearray()

            def write(self, data):
                self.writes += 1
                if self.writes > 1:
                    raise BrokenPipeError('private client detail')
                self.data.extend(data)
                return len(data)

            def flush(self):
                pass

        class Handler:
            def __init__(self):
                self.wfile = Writer()
                self.close_connection = False

            def send_response(self, *_args):
                pass

            def send_header(self, *_args):
                pass

            def end_headers(self):
                pass

        stream = service._NDJSONStream(Handler(), route_mode='technical')
        stream.start()
        for event in (
            {'type': 'progress', 'stage': 'classifying'},
            {'type': 'progress', 'stage': 'classified', 'route': 'technical'},
            {'type': 'progress', 'stage': 'project_context', 'available': True},
            {'type': 'progress', 'stage': 'reading_files', 'count': 1},
            {'type': 'progress', 'stage': 'searching', 'queries': ['safe query']},
            {'type': 'progress', 'stage': 'answering'},
        ):
            stream.progress(event)
        request_id = str(uuid.uuid4())
        stream.result(answer(request_id), request_id)
        self.assertTrue(stream.disconnected)
        self.assertTrue(stream.terminal)
        self.assertEqual(stream.last_stage, 'result')


if __name__ == '__main__':
    unittest.main()
