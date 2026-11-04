"""Per-operation validation boundaries for the signed app bridge."""
import io
import json
import time
import unittest
from unittest.mock import patch
import uuid

from hardissoft_public_chat import service

USER_ID = '12345678-1234-5678-1234-567812345678'
TOKEN = 'valid-session-token'


def request(**fields):
    return {'request_id': str(uuid.uuid4()), 'session_token': TOKEN, **fields}


class BridgeValidationTests(unittest.TestCase):
    def test_every_operation_rejects_unrecognized_fields(self):
        cases = {
            '/auth/login': {'request_id': str(uuid.uuid4()), 'client_bucket': 'a' * 64,
                            'login': 'admin', 'password': 'secret'},
            '/auth/logout': request(), '/auth/me': request(), '/projects/list': request(),
            '/account/profile/update': request(display_name='Ada Lovelace'),
            '/admin/users/list': request(),
            '/admin/users/get': request(user_id=USER_ID),
            '/admin/users/roles/set': request(user_id=USER_ID, roles=['admin'],
                                               expected_revision=0, reason='Reviewed'),
            '/admin/users/status/set': request(user_id=USER_ID, disabled=False,
                                                expected_revision=0, reason='Reviewed'),
            '/admin/audit/list': request(),
            '/projects/create': request(name='Project', brief_text=''),
            '/projects/update': request(project_id=USER_ID, name='Updated'),
            '/projects/delete': request(project_id=USER_ID), '/chats/list': request(project_id=USER_ID),
            '/chats/create': request(project_id=USER_ID),
            '/chats/update': request(chat_id=USER_ID, pinned=[]),
            '/chats/delete': request(chat_id=USER_ID), '/messages/list': request(chat_id=USER_ID),
            '/files/list': request(project_id=USER_ID), '/files/delete': request(file_id=USER_ID),
            '/files/upload/start': request(project_id=USER_ID, name='empty.txt', mime='text/plain',
                                           size_bytes=0, sha256='a' * 64),
            '/files/upload/chunk': request(upload_id=USER_ID, index=0, data_b64='aGVsbG8='),
            '/files/upload/finish': request(upload_id=USER_ID),
            '/ask': request(chat_id=USER_ID, question='Question?', mentions=[], route_mode='auto'),
            '/billing/status': request(), '/billing/sync': request(),
            '/revenuecat-webhook': {
                'request_id': str(uuid.uuid4()),
                'payload': {
                    'api_version': '1.0',
                    'event': {'id': 'evt-test', 'type': 'TEST'},
                },
            },
        }
        for path, value in cases.items():
            with self.subTest(path=path):
                self.assertTrue(service._validate_body(path, value))
                self.assertFalse(service._validate_body(path, {**value, 'unexpected': True}))

    def test_upload_accepts_advisory_mime_and_rejects_unsupported_names(self):
        value = request(project_id=USER_ID, name='empty.txt', mime='text/plain', size_bytes=0, sha256='a' * 64)
        self.assertTrue(service._validate_body('/files/upload/start', value))
        value['name'] = 'payload.exe'
        self.assertEqual(service._validate_body('/files/upload/start', value), 'unsupported_type')
        value['name'] = 'empty.txt'
        value['mime'] = 'application/x-msdownload'
        self.assertTrue(service._validate_body('/files/upload/start', value))
        value['mime'] = {'not': 'a mime string'}
        self.assertFalse(service._validate_body('/files/upload/start', value))
        value['mime'] = 'x' * 101
        self.assertFalse(service._validate_body('/files/upload/start', value))

    def test_login_bucket_type_is_rejected_without_validation_exception(self):
        value = {'request_id': str(uuid.uuid4()), 'client_bucket': 3, 'login': 'admin', 'password': 'password'}
        self.assertFalse(service._validate_body('/auth/login', value))

    def test_messages_list_rejects_any_wire_limit(self):
        value = request(chat_id=USER_ID)
        self.assertTrue(service._validate_body('/messages/list', value))
        value['limit'] = 1
        self.assertFalse(service._validate_body('/messages/list', value))

    def test_logs_only_the_short_user_hmac_reference(self):
        output = io.StringIO()
        started = time.monotonic()
        with patch('sys.stderr', output):
            service._log(200, started, request_id=str(uuid.uuid4()), op='projects.list',
                         user_ref='b' * 64)
        entry = json.loads(output.getvalue())
        self.assertEqual(entry['user_ref'], 'b' * 16)
        self.assertNotIn('b' * 64, output.getvalue())

    def test_profile_update_accepts_only_a_normalized_public_display_name(self):
        valid = request(display_name='Ada Lovelace')
        self.assertTrue(service._validate_body('/account/profile/update', valid))
        for display_name in ('', ' Ada', 'Ada ', 'x' * 81, 'Ada\nLovelace', 7):
            with self.subTest(display_name=display_name):
                self.assertFalse(service._validate_body(
                    '/account/profile/update', request(display_name=display_name)))
        self.assertTrue(service._validate_body(
            '/account/profile/update', request(display_name=None)))
        self.assertFalse(service._validate_body(
            '/account/profile/update', request(display_name='Ada', user_id=USER_ID)))

    def test_admin_user_filters_and_pagination_are_strict(self):
        valid = request(query='alice', role='admin', status='active', limit=100,
                        cursor={'at': '2026-11-02T12:30:00+00:00', 'id': USER_ID})
        self.assertTrue(service._validate_body('/admin/users/list', valid))
        invalid = (
            {'query': 'q' * 255},
            {'role': 'owner'},
            {'status': 'pending'},
            {'limit': True},
            {'limit': 101},
            {'cursor': {'at': '2026-11-02T12:30:00', 'id': USER_ID}},
            {'cursor': {'at': '2026-11-02T12:30:00+00:00', 'id': USER_ID, 'extra': 1}},
        )
        for extra in invalid:
            with self.subTest(extra=extra):
                self.assertFalse(service._validate_body('/admin/users/list', request(**extra)))

    def test_admin_mutations_reject_duplicate_roles_and_non_integer_revision(self):
        base = {'user_id': USER_ID, 'roles': ['admin', 'expert'],
                'expected_revision': 0, 'reason': 'Reviewed access request'}
        self.assertTrue(service._validate_body('/admin/users/roles/set', request(**base)))
        for extra in (
            {'roles': ['admin', 'admin']},
            {'roles': ['expert', 'admin']},
            {'roles': ['owner']},
            {'expected_revision': True},
            {'expected_revision': 2 ** 53},
            {'reason': ' untrimmed '},
        ):
            with self.subTest(extra=extra):
                self.assertFalse(service._validate_body(
                    '/admin/users/roles/set', request(**{**base, **extra})))
        self.assertTrue(service._validate_body(
            '/admin/users/roles/set', request(**{**base, 'roles': []})))
        self.assertTrue(service._validate_body('/admin/users/status/set', request(
            user_id=USER_ID, disabled=False, expected_revision=0, reason='Keep account active')))
        self.assertFalse(service._validate_body('/admin/users/status/set', request(
            user_id=USER_ID, disabled=0, expected_revision=0, reason='Keep account active')))

    def test_admin_audit_filters_require_valid_ordered_timestamps(self):
        valid = request(
            target_user_id=USER_ID, actor_id=USER_ID,
            operation='admin.users.roles.set',
            since='2026-11-02T12:00:00Z', until='2026-11-02T13:00:00+00:00',
            limit=50, cursor={'at': '2026-11-02T12:00:00Z', 'id': USER_ID})
        self.assertTrue(service._validate_body('/admin/audit/list', valid))
        self.assertFalse(service._validate_body('/admin/audit/list', request(
            since='2026-11-02T13:00:00Z', until='2026-11-02T12:00:00Z')))
        self.assertFalse(service._validate_body('/admin/audit/list', request(
            operation='admin.users.delete')))
        for operation in ([], {}):
            self.assertFalse(service._validate_body(
                '/admin/audit/list', request(operation=operation)))
        self.assertFalse(service._validate_body('/admin/audit/list', request(
            target_user_id='not-a-uuid')))

if __name__ == '__main__':
    unittest.main()
