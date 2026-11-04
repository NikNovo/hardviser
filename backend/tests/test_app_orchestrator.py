"""Persistence and context-selection tests for app-backed chat turns."""
import types
import unittest
from unittest.mock import Mock, patch

from hardissoft_public_chat import orchestrator, service

USER_ID = '12345678-1234-5678-1234-567812345678'
CHAT_ID = '22345678-1234-5678-1234-567812345678'
PROJECT_ID = '32345678-1234-5678-1234-567812345678'
MENTION_ID = '42345678-1234-5678-1234-567812345678'
PINNED_ID = '52345678-1234-5678-1234-567812345678'
QUESTION = 'Which project file documents the regulator choice?'


class FakeConnection:
    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class OrchestratorAppTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.chat = {'id': CHAT_ID, 'project_id': PROJECT_ID, 'pinned': [PINNED_ID]}
        self.project = {'id': PROJECT_ID, 'name': 'Prototype board', 'brief_text': 'Input supply is 12 V.'}
        self.files = [
            {'id': MENTION_ID, 'name': 'mentioned.txt', 'status': 'ready'},
            {'id': PINNED_ID, 'name': 'pinned.txt', 'status': 'ready'},
            {'id': '62345678-1234-5678-1234-567812345678', 'name': 'other.txt', 'status': 'ready'},
        ]
        self.excerpts = [{'file_id': MENTION_ID, 'name': 'mentioned.txt', 'page': 2,
                          'kind': 'document', 'content_level': 'full',
                          'text': 'The project chose a buck regulator.'}]
        self.store = types.SimpleNamespace(
            connect=Mock(side_effect=lambda: FakeConnection()),
            get_chat=Mock(side_effect=self.get_chat), get_project=Mock(side_effect=self.get_project),
            recent_user_questions=Mock(return_value=['Earlier project question?']),
            list_files=Mock(side_effect=lambda *_args: list(self.files)),
            search_project_files=Mock(side_effect=self.search_project_files),
            add_user_message=Mock(side_effect=self.add_user_message),
            add_assistant_message=Mock(side_effect=self.add_assistant_message),
        )

    def get_chat(self, _conn, _user_id, _chat_id):
        return dict(self.chat)

    def get_project(self, _conn, _user_id, _project_id):
        return dict(self.project)

    def search_project_files(self, _conn, _user_id, _project_id, _query, *, file_ids, limit, max_bytes):
        self.calls.append(('search', file_ids, limit, max_bytes))
        return list(self.excerpts)

    def add_user_message(self, _conn, _user_id, _chat_id, content, mentions, request_id):
        self.calls.append(('user', content, mentions, request_id))
        return {'id': '72345678-1234-5678-1234-567812345678'}

    def add_assistant_message(self, _conn, _chat_id, content, payload, route, request_id, status='complete'):
        self.calls.append(('assistant', content, payload, route, request_id, status))
        return {'id': '82345678-1234-5678-1234-567812345678'}

    def prepare(self, mentions):
        return orchestrator.prepare_ask(USER_ID, CHAT_ID, QUESTION, mentions=mentions)

    def answer_model(self, messages, *, stage, **_kwargs):
        self.calls.append(('model', stage, messages))
        if stage == 'plan':
            data = {'route': 'general', 'queries': []}
        else:
            data = {'answer': 'The file records the buck regulator choice.', 'recommendations': [], 'unknowns': [],
                    'follow_up_questions': {'general': [], 'technical': []}}
        return {'data': data, 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}

    def test_mentions_then_pinned_then_all_ready_files_are_selected(self):
        with patch.object(orchestrator, 'appstore', self.store, create=True):
            prepared = self.prepare([MENTION_ID])
            self.assertEqual(self.store.search_project_files.call_args.kwargs['file_ids'], [MENTION_ID])
            self.store.search_project_files.reset_mock()
            self.chat['pinned'] = [PINNED_ID]
            self.prepare([])
            self.assertEqual(self.store.search_project_files.call_args.kwargs['file_ids'], [PINNED_ID])
            self.store.search_project_files.reset_mock()
            self.chat['pinned'] = []
            self.prepare([])
            self.assertIsNone(self.store.search_project_files.call_args.kwargs['file_ids'])
            self.assertEqual(prepared['project_context'], {'name': 'Prototype board', 'text': 'Input supply is 12 V.'})
            self.store.recent_user_questions.assert_called_with(
                unittest.mock.ANY, CHAT_ID, limit=6, max_bytes=8192)

    def test_generation_uses_database_history_and_brief_and_persists_both_messages(self):
        with patch.object(orchestrator, 'appstore', self.store, create=True), \
                patch.object(orchestrator.muse, 'complete', side_effect=self.answer_model):
            prepared = self.prepare([MENTION_ID])
            events = []
            result = orchestrator.ask(prepared, QUESTION, request_id='92345678-1234-5678-1234-567812345678',
                                      route_mode='auto', on_progress=events.append)
        self.assertEqual(result['message_id'], '82345678-1234-5678-1234-567812345678')
        self.assertEqual(result['answer'], 'The file records the buck regulator choice.')
        self.assertEqual([event['stage'] for event in events],
                         ['classifying', 'classified', 'project_context', 'reading_files', 'answering'])
        self.assertEqual(events[3]['count'], 1)
        user_index = next(i for i, call in enumerate(self.calls) if call[0] == 'user')
        first_model_index = next(i for i, call in enumerate(self.calls) if call[0] == 'model')
        assistant_index = next(i for i, call in enumerate(self.calls) if call[0] == 'assistant')
        self.assertLess(user_index, first_model_index)
        self.assertLess(first_model_index, assistant_index)
        user_call = self.store.add_user_message.call_args
        self.assertEqual(user_call.args[1:5], (USER_ID, CHAT_ID, QUESTION, [MENTION_ID]))
        prompt_text = str([call[2] for call in self.calls if call[0] == 'model'])
        self.assertIn('Earlier project question?', prompt_text)
        self.assertIn('Input supply is 12 V.', prompt_text)
        self.assertIn('The project chose a buck regulator.', prompt_text)
        self.assertEqual(result['route'], 'general')

    def test_client_disconnect_does_not_stop_generation_or_assistant_persistence(self):
        class Writer:
            def __init__(self):
                self.writes = 0

            def write(self, data):
                self.writes += 1
                if self.writes > 1:
                    raise BrokenPipeError('private client detail')
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

        request_id = '92345678-1234-5678-1234-567812345678'
        with patch.object(orchestrator, 'appstore', self.store, create=True), \
                patch.object(orchestrator.muse, 'complete', side_effect=self.answer_model):
            prepared = self.prepare([MENTION_ID])
            stream = service._NDJSONStream(Handler(), route_mode='auto')
            stream.start()
            result = orchestrator.ask(prepared, QUESTION, request_id=request_id, route_mode='auto',
                                      on_progress=stream.progress)
            stream.result(result, request_id)
        self.assertTrue(stream.disconnected)
        self.assertEqual(result['message_id'], '82345678-1234-5678-1234-567812345678')
        self.assertTrue(self.store.add_user_message.called)
        self.assertTrue(self.store.add_assistant_message.called)
        self.assertEqual(self.store.add_assistant_message.call_args.args[6], 'complete')

    def test_generation_failure_persists_fixed_error_assistant_message(self):
        with patch.object(orchestrator, 'appstore', self.store, create=True), \
                patch.object(orchestrator.muse, 'complete', side_effect=RuntimeError('private provider detail')):
            prepared = self.prepare([])
            with self.assertRaises(RuntimeError):
                orchestrator.ask(prepared, QUESTION, request_id='92345678-1234-5678-1234-567812345678',
                                 route_mode='auto')
        assistant_call = self.store.add_assistant_message.call_args
        self.assertEqual(assistant_call.args[1], CHAT_ID)
        self.assertEqual(assistant_call.args[3:7], (None, None, '92345678-1234-5678-1234-567812345678', 'error'))
        self.assertNotIn('private provider detail', assistant_call.args[2])
        self.assertTrue(assistant_call.args[2])


if __name__ == '__main__':
    unittest.main()
