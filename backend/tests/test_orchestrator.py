"""Synthetic tests for routing, uncited answers, progress, and the request deadline."""
import time
import unittest
from unittest.mock import patch

from hardissoft_public_chat import orchestrator

LONG_EXCERPT = 'é' * 700
EVIDENCE = [
    {'ref': 'e1', 'text': 'Use a buck converter above 1 A.', 'safe_locator': {'kind': 'pdf', 'page_index': 0},
     'modality': 'text', 'language': 'en', 'limitations': []},
    {'ref': 'e2', 'text': LONG_EXCERPT, 'safe_locator': None, 'modality': 'forum_text', 'language': 'en',
     'limitations': ['machine screened']},
]
CONTEXT = {'name': 'Prototype board', 'text': 'The input supply is 12 V.'}


class FakeModel:
    def __init__(self, **data_by_stage):
        self.data_by_stage = data_by_stage
        self.calls = []

    def __call__(self, messages, *, stage, schema_name, schema, timeout):
        self.calls.append({'messages': messages, 'stage': stage, 'schema_name': schema_name,
                           'schema': schema, 'timeout': timeout})
        return {'data': self.data_by_stage[stage], 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}


def answer_data(**overrides):
    data = {'answer': 'Pick a buck converter.', 'recommendations': [], 'unknowns': [],
            'follow_up_questions': {'general': [], 'technical': []}}
    data.update(overrides)
    return data


class PlannerTests(unittest.TestCase):
    def test_plans_technical_route_with_deduplicated_queries_and_project_context(self):
        model = FakeModel(plan={'route': 'technical', 'queries': [' buck converter selection ', 'Buck converter selection']})
        plan = orchestrator.plan_turn(
            'Which regulator should I choose?', [{'role': 'user', 'content': 'Input is 12 V.'}],
            project_context=CONTEXT, model_call=model, timeout=5)
        self.assertEqual(plan, {'route': 'technical', 'queries': ['buck converter selection']})
        self.assertEqual(model.calls[0]['messages'][1]['content'], 'Input is 12 V.')
        self.assertIn('Prototype board', model.calls[0]['messages'][-1]['content'])

    def test_general_route_requires_empty_search_queries(self):
        model = FakeModel(plan={'route': 'general', 'queries': []})
        plan = orchestrator.plan_turn('What did I decide?', [], project_context=None, model_call=model, timeout=5)
        self.assertEqual(plan, {'route': 'general', 'queries': []})

    def test_forced_technical_route_searches_even_for_general_sounding_question(self):
        model = FakeModel(plan={'route': 'technical', 'queries': ['wireless privacy and safety tradeoffs']})
        plan = orchestrator.plan_turn('What did I decide?', [], project_context=None, model_call=model, timeout=5,
                                      route_mode='technical')
        self.assertEqual(plan, {'route': 'technical', 'queries': ['wireless privacy and safety tradeoffs']})
        self.assertEqual(model.calls[0]['schema']['properties']['route']['enum'], ['technical'])
        self.assertEqual(model.calls[0]['schema']['properties']['queries']['minItems'], 1)
        self.assertIn('regardless of its wording', model.calls[0]['messages'][0]['content'])

    def test_forced_technical_mode_rejects_general_model_result(self):
        model = FakeModel(plan={'route': 'general', 'queries': []})
        with self.assertRaisesRegex(ValueError, 'forced technical'):
            orchestrator.plan_turn('What did I decide?', [], project_context=None, model_call=model, timeout=5,
                                   route_mode='technical')

    def test_rejects_invalid_route_query_combinations_and_modes(self):
        cases = [
            {'route': 'other', 'queries': []},
            {'route': 'general', 'queries': ['search anyway']},
            {'route': 'technical', 'queries': []},
            {'route': 'technical', 'queries': ['one', 'two', 'three']},
            {'route': 'technical', 'queries': ['   ']},
        ]
        for plan in cases:
            with self.subTest(plan=plan), self.assertRaises(ValueError):
                orchestrator.plan_turn('Question?', [], project_context=None, model_call=FakeModel(plan=plan), timeout=5)
        with self.assertRaisesRegex(ValueError, 'route_mode'):
            orchestrator.plan_turn('Question?', [], project_context=None,
                                   model_call=FakeModel(plan={'route': 'general', 'queries': []}), timeout=5,
                                   route_mode='unsupported')

    def test_rejects_invalid_context_and_history_before_provider_call(self):
        model = FakeModel(plan={'route': 'technical', 'queries': ['unused']})
        for context in ({'name': '', 'text': 'x'}, {'name': 'x', 'text': 'z' * 8193}, {'name': 'x', 'text': 'bad\x00text'}):
            with self.subTest(context=context), self.assertRaises(ValueError):
                orchestrator.plan_turn('Question?', [], project_context=context, model_call=model, timeout=5)
        with self.assertRaisesRegex(ValueError, 'history'):
            orchestrator.plan_turn('Question?', [{'role': 'assistant', 'content': 'previous answer'}],
                                   project_context=None, model_call=model, timeout=5)
        self.assertEqual(model.calls, [])


class AnswerTests(unittest.TestCase):
    def test_general_answer_has_no_knowledge_section_and_rejects_rag_evidence(self):
        model = FakeModel(answer=answer_data(answer='The project record does not mention a decision.'))
        result = orchestrator.build_answer('What did I decide?', [], [], route='general', project_context=CONTEXT,
                                           model_call=model, timeout=5)
        self.assertEqual(result['answer'], 'The project record does not mention a decision.')
        unused_model = FakeModel(answer=answer_data())
        with self.assertRaisesRegex(ValueError, 'cannot include'):
            orchestrator.build_answer('What did I decide?', [], EVIDENCE, route='general', project_context=CONTEXT,
                                      model_call=unused_model, timeout=5)
        self.assertEqual(unused_model.calls, [])

    def test_answer_schema_rejects_obsolete_general_knowledge_field(self):
        model = FakeModel(answer=answer_data(general_knowledge='obsolete output'))
        with self.assertRaisesRegex(ValueError, 'invalid object'):
            orchestrator.build_answer('Question?', [], [], route='general', project_context=None,
                                      model_call=model, timeout=5)
        self.assertNotIn('general_knowledge', orchestrator._answer_schema()['properties'])

    def test_inline_reference_markers_are_removed_from_every_user_facing_field(self):
        model = FakeModel(answer=answer_data(
            answer='See [e1] and [E99].', recommendations=['Try [e1].'], unknowns=['Need [e3].'],
            follow_up_questions={'general': ['What is [e2]?'], 'technical': ['Check [e3]?']}))
        result = orchestrator.build_answer('Question?', [], EVIDENCE, route='technical', project_context=CONTEXT,
                                           model_call=model, timeout=5)
        self.assertEqual(result['answer'], 'See  and .')
        self.assertEqual(result['recommendations'], ['Try .'])
        self.assertEqual(result['unknowns'], ['Need .'])
        self.assertEqual(result['follow_up_questions'], {'general': ['What is ?'], 'technical': ['Check ?']})
        self.assertFalse(any('[e' in value.lower() for value in [result['answer'], *result['recommendations'],
                         *result['unknowns'], *result['follow_up_questions']['general'],
                         *result['follow_up_questions']['technical']]))

    def test_follow_up_prompt_requires_self_contained_questions(self):
        model = FakeModel(answer=answer_data())
        orchestrator.build_answer('Question?', [{'role': 'user', 'content': 'Earlier topic.'}], EVIDENCE,
                                  route='technical', project_context=CONTEXT, model_call=model, timeout=5)
        self.assertIn('self-contained', model.calls[0]['messages'][0]['content'])
        self.assertIn('previous questions or answers', model.calls[0]['messages'][0]['content'])

    def test_long_answer_fields_are_bounded_and_questions_are_retained(self):
        model = FakeModel(answer=answer_data(
            answer='a' * 20000, recommendations=['r' * 2000] * 8, unknowns=['  ', 'u'],
            follow_up_questions={'general': ['G' * 500] * 4, 'technical': ['What is the input voltage?']}))
        result = orchestrator.build_answer('Question?', [], EVIDENCE, route='technical', project_context=CONTEXT,
                                           model_call=model, timeout=5)
        self.assertLessEqual(len(result['answer']), 8000)
        self.assertEqual(len(result['recommendations']), 6)
        self.assertTrue(all(len(item.encode('utf-8')) <= 512 for item in result['recommendations']))
        self.assertEqual(result['unknowns'], ['u'])
        self.assertEqual(len(result['follow_up_questions']['general']), 3)
        self.assertLessEqual(len(result['follow_up_questions']['general'][0]), 300)


class GenerationTests(unittest.TestCase):
    def test_general_project_budget_and_milestone_question_never_retrieves(self):
        stages, progress = [], []

        def complete(messages, *, request_id, stage, schema_name, schema, timeout):
            stages.append(stage)
            data = {'route': 'general', 'queries': []} if stage == 'plan' else answer_data(
                answer='The saved budget and milestone status are missing.',
                unknowns=['The project context does not contain a budget or milestone update.'])
            return {'data': data, 'usage': {'prompt_tokens': 10, 'completion_tokens': 20}}

        with patch.object(orchestrator.muse, 'complete', side_effect=complete), \
                patch.object(orchestrator.retrieval, 'retrieve') as retrieve:
            result = orchestrator._generate('Summarize the saved budget and milestone status for this hardware project.',
                                            [], request_id='request-general', route_mode='auto',
                                            project_context=CONTEXT, file_excerpts=(), on_progress=progress.append)
        retrieve.assert_not_called()
        self.assertEqual(stages, ['plan', 'answer'])
        self.assertEqual([event['stage'] for event in progress],
                         ['classifying', 'classified', 'project_context', 'answering'])
        self.assertEqual(result['route'], 'general')

    def test_forced_technical_mode_retrieves_despite_general_sounding_question(self):
        stages = []

        def complete(messages, *, request_id, stage, schema_name, schema, timeout):
            stages.append(stage)
            data = {'route': 'technical', 'queries': ['wireless privacy and safety tradeoffs']} if stage == 'plan' else answer_data()
            return {'data': data, 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}

        with patch.object(orchestrator.muse, 'complete', side_effect=complete), \
                patch.object(orchestrator.retrieval, 'retrieve', return_value=EVIDENCE) as retrieve:
            result = orchestrator._generate('What did I decide?', [], request_id='request-technical',
                                            route_mode='technical', project_context=CONTEXT)
        self.assertEqual(stages, ['plan', 'answer'])
        self.assertEqual(retrieve.call_args.args[0], ['wireless privacy and safety tradeoffs'])
        self.assertEqual(result['route'], 'technical')

    def test_forced_technical_mode_rejects_general_planner_result_without_answering(self):
        stages = []

        def complete(messages, *, request_id, stage, schema_name, schema, timeout):
            stages.append(stage)
            return {'data': {'route': 'general', 'queries': []},
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}

        with patch.object(orchestrator.muse, 'complete', side_effect=complete), \
                patch.object(orchestrator.retrieval, 'retrieve') as retrieve:
            with self.assertRaisesRegex(ValueError, 'forced technical'):
                orchestrator._generate('What did I decide?', [], request_id='request-technical',
                                       route_mode='technical', project_context=None)
        self.assertEqual(stages, ['plan'])
        retrieve.assert_not_called()

    def test_rejects_success_if_answer_finishes_after_deadline(self):
        def complete(messages, *, request_id, stage, schema_name, schema, timeout):
            data = {'route': 'general', 'queries': []} if stage == 'plan' else answer_data()
            return {'data': data, 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}

        ticks = iter((0.0, 0.0, 0.0, orchestrator.DEADLINE_SECONDS + 1.0))
        with patch.object(orchestrator.time, 'monotonic', side_effect=lambda: next(ticks)), \
                patch.object(orchestrator.muse, 'complete', side_effect=complete):
            with self.assertRaises(orchestrator.DeadlineExceeded):
                orchestrator._generate('Question?', [], request_id='request-late-answer', route_mode='auto',
                                       project_context=None)

    def test_skips_answer_stage_when_retrieval_exhausts_deadline(self):
        stages = []

        def complete(messages, *, request_id, stage, schema_name, schema, timeout):
            stages.append(stage)
            data = {'route': 'technical', 'queries': ['slow query']} if stage == 'plan' else answer_data()
            return {'data': data, 'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}

        def slow_retrieve(queries, *, deadline):
            time.sleep(0.3)
            return EVIDENCE

        with patch.object(orchestrator, 'DEADLINE_SECONDS', 10.2), \
                patch.object(orchestrator.muse, 'complete', side_effect=complete), \
                patch.object(orchestrator.retrieval, 'retrieve', side_effect=slow_retrieve):
            with self.assertRaises(orchestrator.DeadlineExceeded):
                orchestrator._generate('Question?', [], request_id='request-slow', route_mode='auto',
                                       project_context=None)
        self.assertEqual(stages, ['plan'])


if __name__ == '__main__':
    unittest.main()
