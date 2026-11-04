"""Synthetic tests for owner-approved, read-only retrieval over the pinned RAG release."""
import os
import threading
import time
import unittest
from unittest.mock import patch

from hardissoft_public_chat import retrieval

RELEASE = 'release:' + 'a' * 64
ENV = {
    'HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION': retrieval.OWNER_EXCEPTION,
    'HIS_KB_PUBLIC_CHAT_RELEASE_ID': RELEASE,
    'HIS_KB_PUBLIC_CHAT_COLLECTIONS': 'beta,alpha',
}


class FakeConnection:
    def __init__(self):
        self.statements = []
        self.rolled_back = False
        self.committed = False
        self.closed = False

    def execute(self, sql, *args):
        self.statements.append(sql)

    def rollback(self):
        self.rolled_back = True

    def commit(self):
        self.committed = True

    def close(self):
        self.closed = True


def row(text, **extra):
    value = {
        'text': text,
        'safe_locator': {'kind': 'pdf', 'page_index': 3},
        'modality': 'text',
        'language': 'en',
        'limitations': ['machine screened'],
        'citation_id': 'cite_private_marker',
        'rrf_score': 0.1,
        'content_role': 'source_content',
    }
    value.update(extra)
    return value


def no_database():
    raise AssertionError('database must not be opened')


class RetrievalTests(unittest.TestCase):
    def test_owner_exception_is_required_before_any_database_access(self):
        for token in (None, '', 'yes', retrieval.OWNER_EXCEPTION + 'x'):
            env = dict(ENV)
            if token is None:
                env.pop('HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION')
            else:
                env['HIS_KB_PUBLIC_CHAT_OWNER_EXCEPTION'] = token
            with self.subTest(token=token), patch.dict(os.environ, env, clear=True), \
                    patch.object(retrieval, '_open_connection', side_effect=no_database):
                with self.assertRaises(retrieval.RetrievalUnavailable):
                    retrieval.retrieve(['buck converter'], deadline=time.monotonic() + 30)

    def test_release_pin_and_collection_allowlist_are_required(self):
        cases = [
            {'HIS_KB_PUBLIC_CHAT_RELEASE_ID': ''},
            {'HIS_KB_PUBLIC_CHAT_RELEASE_ID': 'release:abc'},
            {'HIS_KB_PUBLIC_CHAT_RELEASE_ID': RELEASE + ' '},
            {'HIS_KB_PUBLIC_CHAT_COLLECTIONS': ''},
            {'HIS_KB_PUBLIC_CHAT_COLLECTIONS': 'alpha,bad/collection'},
        ]
        for override in cases:
            with self.subTest(override=override), patch.dict(os.environ, dict(ENV, **override), clear=True):
                with self.assertRaises(retrieval.RetrievalUnavailable):
                    retrieval.context()

    def test_context_is_global_operator_retrieval_for_the_pinned_release(self):
        with patch.dict(os.environ, ENV, clear=True):
            context = retrieval.context()
        self.assertEqual(context['scope'], {'kind': 'global'})
        self.assertEqual(context['purpose'], 'internal_retrieval')
        self.assertIs(context['operator'], True)
        self.assertIs(context['allow_machine_screened'], True)
        self.assertEqual(context['release_id'], RELEASE)
        self.assertEqual(context['allowed_collections'], ['alpha', 'beta'])
        self.assertRegex(context['grant_fingerprint'], r'^[0-9a-f]{64}$')

    def test_each_query_runs_in_its_own_rolled_back_transaction(self):
        connections, borrowed, requests = [], [], []

        def open_connection():
            connection = FakeConnection()
            connections.append(connection)
            return connection

        def search(request, context):
            requests.append(request)
            with retrieval.catalog.connect() as connection:
                borrowed.append(connection)
            return {'results': [row('excerpt for ' + request['query'])]}

        with patch.dict(os.environ, ENV, clear=True), \
                patch.object(retrieval, '_open_connection', side_effect=open_connection), \
                patch.object(retrieval.hybrid, 'search', side_effect=search):
            evidence = retrieval.retrieve(['one', 'two'], deadline=time.monotonic() + 30)

        self.assertEqual(len(connections), 2)
        for connection in connections:
            self.assertTrue(connection.rolled_back)
            self.assertTrue(connection.closed)
            self.assertFalse(connection.committed)
            self.assertTrue(connection.statements[0].startswith('SET LOCAL statement_timeout'))
            self.assertIn('SET LOCAL max_parallel_workers_per_gather = 0', connection.statements)
        self.assertEqual({id(connection) for connection in borrowed}, {id(connection) for connection in connections})
        self.assertEqual(sorted(request['query'] for request in requests), ['one', 'two'])
        for request in requests:
            self.assertEqual((request['top_k'], request['mode'], request['operation']), (5, 'hybrid', 'explain'))
        self.assertEqual([item['text'] for item in evidence], ['excerpt for one', 'excerpt for two'])

    def test_results_are_interleaved_deduplicated_redacted_and_projected(self):
        results = {
            'first': [row('Alpha one. Contact bob@example.com'), row('Shared excerpt', safe_locator={'kind': 'forum', 'post_id': 'p1'})],
            'second': [row('Beta one'), row('Shared excerpt')],
        }
        with patch.dict(os.environ, ENV, clear=True), \
                patch.object(retrieval, '_open_connection', side_effect=FakeConnection), \
                patch.object(retrieval.hybrid, 'search', side_effect=lambda request, context: {'results': results[request['query']]}):
            evidence = retrieval.retrieve(['first', 'second'], deadline=time.monotonic() + 30)

        self.assertEqual([item['ref'] for item in evidence], ['e1', 'e2', 'e3'])
        self.assertEqual([item['text'] for item in evidence], ['Alpha one. Contact [REDACTED:email]', 'Beta one', 'Shared excerpt'])
        self.assertEqual(evidence[2]['safe_locator'], None)
        self.assertEqual(evidence[0]['safe_locator'], {'kind': 'pdf', 'page_index': 3})
        for item in evidence:
            self.assertEqual(set(item), {'ref', 'text', 'safe_locator', 'modality', 'language', 'limitations'})
        self.assertNotIn('cite_private_marker', repr(evidence))
        self.assertNotIn('bob@example.com', repr(evidence))

    def test_excerpts_respect_item_and_total_byte_budgets(self):
        long_rows = [row(str(index) + 'é' * 3000) for index in range(5)]
        with patch.dict(os.environ, ENV, clear=True), \
                patch.object(retrieval, '_open_connection', side_effect=FakeConnection), \
                patch.object(retrieval.hybrid, 'search', side_effect=lambda request, context: {'results': long_rows}):
            evidence = retrieval.retrieve(['first', 'second'], deadline=time.monotonic() + 30)
        sizes = [len(item['text'].encode('utf-8')) for item in evidence]
        self.assertTrue(all(size <= retrieval.MAX_ITEM_BYTES for size in sizes))
        self.assertLessEqual(sum(sizes), retrieval.MAX_TOTAL_BYTES)
        self.assertEqual(len(evidence), 5)

    def test_vector_failure_falls_back_to_lexical_mode(self):
        modes, connections = [], []

        def search(request, context):
            modes.append(request['mode'])
            if request['mode'] == 'hybrid':
                raise RuntimeError('pinned vector specification mismatch')
            return {'results': [row('lexical result')]}

        def open_connection():
            connections.append(FakeConnection())
            return connections[-1]

        with patch.dict(os.environ, ENV, clear=True), \
                patch.object(retrieval, '_open_connection', side_effect=open_connection), \
                patch.object(retrieval.hybrid, 'search', side_effect=search):
            evidence = retrieval.retrieve(['query'], deadline=time.monotonic() + 30)
        self.assertEqual(modes, ['hybrid', 'lexical'])
        self.assertEqual([item['text'] for item in evidence], ['lexical result'])
        # The fallback runs after a rollback, so it must disable parallel plans again.
        self.assertEqual(connections[0].statements.count('SET LOCAL max_parallel_workers_per_gather = 0'), 2)

    def test_search_without_a_free_slot_fails_fast_and_skips_the_database(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()  # held by another turn for longer than this turn can wait
        started = time.monotonic()
        with patch.dict(os.environ, ENV, clear=True), patch.object(retrieval, '_SLOTS', slots), \
                patch.object(retrieval, '_open_connection', side_effect=no_database):
            with self.assertRaises(retrieval.RetrievalBusy):
                retrieval.retrieve(['query'], deadline=started + retrieval.MIN_SEARCH_SECONDS + 0.3)
        self.assertLess(time.monotonic() - started, 2)

    def test_queued_search_runs_when_a_slot_frees(self):
        slots = threading.BoundedSemaphore(1)
        slots.acquire()
        threading.Timer(0.2, slots.release).start()
        with patch.dict(os.environ, ENV, clear=True), patch.object(retrieval, '_SLOTS', slots), \
                patch.object(retrieval, '_open_connection', side_effect=FakeConnection), \
                patch.object(retrieval.hybrid, 'search', side_effect=lambda request, context: {'results': [row('queued')]}):
            evidence = retrieval.retrieve(['query'], deadline=time.monotonic() + 30)
        self.assertEqual([item['text'] for item in evidence], ['queued'])
        self.assertTrue(slots.acquire(blocking=False))

    def test_failed_search_releases_its_slot(self):
        slots = threading.BoundedSemaphore(1)

        def search(request, context):
            raise LookupError('database failure')

        with patch.dict(os.environ, ENV, clear=True), patch.object(retrieval, '_SLOTS', slots), \
                patch.object(retrieval, '_open_connection', side_effect=FakeConnection), \
                patch.object(retrieval.hybrid, 'search', side_effect=search):
            with self.assertRaises(LookupError):
                retrieval.retrieve(['query'], deadline=time.monotonic() + 30)
        self.assertTrue(slots.acquire(blocking=False))

    def test_exhausted_deadline_skips_the_database(self):
        with patch.dict(os.environ, ENV, clear=True), \
                patch.object(retrieval, '_open_connection', side_effect=no_database):
            with self.assertRaises(TimeoutError):
                retrieval.retrieve(['query'], deadline=time.monotonic() + 1)


if __name__ == '__main__':
    unittest.main()
