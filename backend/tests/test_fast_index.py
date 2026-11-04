"""Synthetic tests for the cached authorized-subset retrieval index."""
import unittest
from unittest.mock import patch

import numpy as np

from hardissoft_public_chat import fast_index

KEY = ('release:' + 'a' * 64, '3', 'policy-md5', 'grant', 'config')


def make_index(segments, candidates=None, rows=None):
    """segments: list of (chunk_id, vector) grouped contiguously by chunk."""
    chunk_ids, starts, vectors = [], [], []
    for chunk_id, vector in segments:
        if not chunk_ids or chunk_ids[-1] != chunk_id:
            chunk_ids.append(chunk_id)
            starts.append(len(vectors))
        vectors.append(vector)
    matrix = np.asarray(vectors, dtype=np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    candidates = frozenset(chunk_ids if candidates is None else candidates)
    rows = {chunk_id: {'chunk_id': chunk_id} for chunk_id in chunk_ids} if rows is None else rows
    return fast_index._Index(KEY, candidates, rows, chunk_ids, np.asarray(starts), matrix)


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=()):
        rows = self.rows

        class Result:
            def fetchall(self):
                return rows
        return Result()


class FastIndexTests(unittest.TestCase):
    def test_vector_rank_is_best_segment_pair_cosine_then_chunk_id(self):
        rng = np.random.default_rng(7)
        segments = []
        for number in range(40):
            for _ in range(int(rng.integers(1, 4))):
                segments.append(('c%02d' % number, rng.normal(size=8).tolist()))
        index = make_index(segments)
        queries = [rng.normal(size=8).tolist() for _ in range(2)]

        def cosine(left, right):
            left, right = np.asarray(left), np.asarray(right)
            return float(left @ right / np.linalg.norm(left) / np.linalg.norm(right))

        best = {}
        for chunk_id, vector in segments:
            score = max(cosine(vector, query) for query in queries)
            best[chunk_id] = max(best.get(chunk_id, -2), score)
        expected = sorted(best, key=lambda chunk_id: (-round(best[chunk_id], 5), chunk_id))[:10]
        produced = fast_index._vector_rank(index, {'segments': [{'embedding': q} for q in queries]}, limit=10)
        self.assertEqual(produced, expected)

    def test_vector_rank_ties_break_by_chunk_id(self):
        index = make_index([('b', [1, 0]), ('a', [1, 0]), ('c', [0, 1])])
        self.assertEqual(fast_index._vector_rank(index, {'segments': [{'embedding': [1, 0]}]}, limit=3), ['a', 'b', 'c'])

    def test_lexical_rank_orders_like_lexical_rank_within_authorized_candidates(self):
        index = make_index([('a', [1, 0]), ('b', [1, 0]), ('c', [1, 0]), ('d', [1, 0])], candidates={'a', 'b', 'c'})
        rows = [
            {'chunk_id': 'a', 'matched_ids': [], 'score': 0.9},
            {'chunk_id': 'b', 'matched_ids': ['stm32f4'], 'score': 0.1},
            {'chunk_id': 'c', 'matched_ids': ['stm32f4', 'usb-c'], 'score': 0.0},
            # Not an authorized candidate: neither ranked nor counted in id frequencies.
            {'chunk_id': 'd', 'matched_ids': ['usb-c'], 'score': 5.0},
            {'chunk_id': 'e', 'matched_ids': ['stm32f4'], 'score': 0.5},
        ]
        produced = fast_index._lexical_rank(FakeConnection(rows), 'STM32F4 with USB-C', index, candidates=None)
        self.assertEqual(produced, ['c', 'b', 'a'])

    def test_rarer_identifier_outranks_common_one(self):
        index = make_index([(name, [1, 0]) for name in 'abcd'])
        rows = [
            {'chunk_id': 'a', 'matched_ids': ['common-1'], 'score': 0.5},
            {'chunk_id': 'b', 'matched_ids': ['common-1'], 'score': 0.5},
            {'chunk_id': 'c', 'matched_ids': ['common-1'], 'score': 0.5},
            {'chunk_id': 'd', 'matched_ids': ['rare-2'], 'score': 0.0},
        ]
        produced = fast_index._lexical_rank(FakeConnection(rows), 'common-1 rare-2', index, candidates=None)
        self.assertEqual(produced[0], 'd')

    def test_changed_policy_makes_the_index_unavailable_and_triggers_a_rebuild(self):
        stale = make_index([('a', [1, 0])])
        context = {'policy_revision': 4, 'grant_fingerprint': 'grant'}  # revision moved on from '3'
        with patch.object(fast_index, '_index', stale), \
                patch.object(fast_index.vector, 'prepare_query', return_value={'segments': [{'embedding': [1, 0]}]}), \
                patch.object(fast_index.catalog, 'authorized_candidates', return_value=(None, context, {'release_id': KEY[0]})), \
                patch.object(fast_index, '_policy_fingerprint', return_value='policy-md5'), \
                patch.object(fast_index.vector, 'embedding_spec', return_value={'config_hash': 'config'}), \
                patch.object(fast_index, '_start_build') as start_build:
            with self.assertRaises(fast_index.Unavailable):
                fast_index.search(object(), 'query', {'grant_fingerprint': 'grant'})
        start_build.assert_called_once()

    def test_policy_table_change_without_revision_bump_also_invalidates(self):
        stale = make_index([('a', [1, 0])])
        context = {'policy_revision': 3, 'grant_fingerprint': 'grant'}
        with patch.object(fast_index, '_index', stale), \
                patch.object(fast_index.vector, 'prepare_query', return_value={'segments': [{'embedding': [1, 0]}]}), \
                patch.object(fast_index.catalog, 'authorized_candidates', return_value=(None, context, {'release_id': KEY[0]})), \
                patch.object(fast_index, '_policy_fingerprint', return_value='other-md5'), \
                patch.object(fast_index.vector, 'embedding_spec', return_value={'config_hash': 'config'}), \
                patch.object(fast_index, '_start_build'):
            with self.assertRaises(fast_index.Unavailable):
                fast_index.search(object(), 'query', {'grant_fingerprint': 'grant'})

    def test_vector_hits_without_an_authorized_row_are_never_selected(self):
        rows = {'a': {'chunk_id': 'a', 'content_role': 'source_content', 'evidence_source_group_id': 'g1',
                      'retrieval_text': 'kept', 'safe_locator': {}, 'modality': 'text', 'language': 'en',
                      'limitations': []}}
        index = make_index([('a', [1, 0]), ('b', [1, 0.01])], rows=rows)
        context = {'policy_revision': 3, 'grant_fingerprint': 'grant'}
        with patch.object(fast_index, '_index', index), \
                patch.object(fast_index.vector, 'prepare_query', return_value={'segments': [{'embedding': [1, 0]}]}), \
                patch.object(fast_index.catalog, 'authorized_candidates', return_value=(None, context, {'release_id': KEY[0]})), \
                patch.object(fast_index, '_policy_fingerprint', return_value='policy-md5'), \
                patch.object(fast_index.vector, 'embedding_spec', return_value={'config_hash': 'config'}), \
                patch.object(fast_index, '_lexical_rank', return_value=['b']), \
                patch.object(fast_index.structured, 'rank', return_value=[]):
            results = fast_index.search(object(), 'query', {'grant_fingerprint': 'grant'})
        self.assertEqual([result['text'] for result in results], ['kept'])


if __name__ == '__main__':
    unittest.main()
