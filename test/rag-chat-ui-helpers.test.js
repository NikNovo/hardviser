import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProjectContext } from '../src/rag-chat-context.js';
import { RagChatStreamError, consumeRagStream } from '../src/rag-chat-stream.js';
import { classifyFileExtension, MAX_UPLOAD_FILE_BYTES, SUPPORTED_FILE_EXTENSIONS } from '../src/rag-chat-helpers.js';

function streamFromChunks(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
        },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
}

function ndjsonBody(events, bytewise = false) {
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const chunks = bytewise
    ? Array.from(bytes, byte => Uint8Array.of(byte))
    : [bytes];
  return streamFromChunks(chunks);
}
function failingStream(error) {
  return {
    getReader() {
      return {
        async read() { throw error; },
        async cancel() {},
        releaseLock() {},
      };
    },
  };
}

function validTechnicalEvents(overrides = {}) {
  const result = {
    request_id: 'e0000000-0000-4000-8000-000000000001',
    message_id: 'e0000000-0000-4000-8000-000000000002',
    route: 'technical',
    answer: 'Use the bench test [e1].',
    recommendations: ['Measure the current [e1].'],
    unknowns: ['The load rating [e2] is not known.'],
    follow_up_questions: {
      general: ['What assumptions should I check? [e2]'],
      technical: ['How should I measure the load? [e1]'],
    },
    model: 'muse-spark-1.3',
    usage: { prompt_tokens: 12, completion_tokens: 4 },
  };
  return [
    { type: 'progress', stage: 'accepted' },
    { type: 'progress', stage: 'classifying' },
    { type: 'progress', stage: 'classified', route: 'technical' },
    { type: 'progress', stage: 'project_context', available: true },
    { type: 'progress', stage: 'reading_files', count: 2 },
    { type: 'progress', stage: 'searching', queries: ['café 🛰 [e1]'] },
    { type: 'progress', stage: 'answering' },
    { type: 'result', data: { ...result, ...overrides } },
  ];
}

test('RAG stream accepts fragmented UTF-8, reports server progress, and strips evidence markers', async () => {
  const progress = [];
  const result = await consumeRagStream(ndjsonBody(validTechnicalEvents(), true), event => progress.push(event));

  assert.deepEqual(progress.map(event => event.stage), ['accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'searching', 'answering']);
  assert.equal(progress[4].count, 2);
  assert.deepEqual(progress[5].queries, ['café 🛰 ']);
  assert.equal(result.answer, 'Use the bench test .');
  assert.deepEqual(result.recommendations, ['Measure the current .']);
  assert.deepEqual(result.unknowns, ['The load rating  is not known.']);
  assert.deepEqual(result.followUpQuestions.general, ['What assumptions should I check? ']);
  assert.deepEqual(result.followUpQuestions.technical, ['How should I measure the load? ']);
  assert.deepEqual(Object.keys(result), ['requestId', 'messageId', 'route', 'answer', 'recommendations', 'unknowns', 'followUpQuestions', 'model', 'usage']);
});

test('general route can read project files without a knowledge-base search event', async () => {
  const events = validTechnicalEvents();
  events.splice(5, 1);
  events[2].route = 'general';
  events.at(-1).data.route = 'general';
  const progress = [];
  const result = await consumeRagStream(ndjsonBody(events), event => progress.push(event));

  assert.deepEqual(progress.map(event => event.stage), ['accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'answering']);
  assert.equal(result.route, 'general');
});

test('technical route rejects an answer sequence without a search event', async () => {
  const events = validTechnicalEvents();
  events.splice(5, 1);

  await assert.rejects(
    consumeRagStream(ndjsonBody(events)),
    /invalid response stream/i,
  );
});

test('RAG stream rejects premature EOF and result citation fields', async t => {
  await t.test('missing terminal event is a typed interruption', async () => {
    await assert.rejects(
      consumeRagStream(ndjsonBody(validTechnicalEvents().slice(0, -1))),
      error => error instanceof RagChatStreamError && error.code === 'stream_interrupted'
        && /ended before a complete answer/i.test(error.message),
    );
  });
  await t.test('removed citations are not accepted in the result contract', async () => {
    await assert.rejects(
      consumeRagStream(ndjsonBody(validTechnicalEvents({ citations: [] }))),
      error => error instanceof RagChatStreamError && error.code === 'invalid_stream',
    );
  });
});

test('RAG stream distinguishes malformed data from interrupted delivery', async t => {
  await t.test('malformed events are typed invalid streams', async () => {
    await assert.rejects(
      consumeRagStream(ndjsonBody([{ nope: true }])),
      error => error instanceof RagChatStreamError && error.code === 'invalid_stream',
    );
  });
  await t.test('reader TypeErrors are typed interruptions', async () => {
    await assert.rejects(
      consumeRagStream(failingStream(new TypeError('connection lost'))),
      error => error instanceof RagChatStreamError && error.code === 'stream_interrupted',
    );
  });
});

test('RAG stream requires route-consistent, ordered progress before a result', async () => {
  const events = validTechnicalEvents();
  events[2] = { type: 'progress', stage: 'classified', route: 'general' };
  await assert.rejects(consumeRagStream(ndjsonBody(events)), /invalid response stream/i);
});

test('project context includes only active-project metadata and saved record/task text', () => {
  const workspace = {
    profile: { name: 'PROFILE_SENTINEL', providerKey: 'PROVIDER_KEY_SENTINEL' },
    projects: {
      active: {
        workspace: {
          project: {
            name: 'Current project',
            description: 'CURRENT_PROJECT_SENTINEL',
            model: 'B2B',
            providerKey: 'PROJECT_PROVIDER_SENTINEL',
            profile: { name: 'EMBEDDED_PROFILE_SENTINEL' },
          },
          records: [
            {
              id: 'record-id', type: 'document', title: 'Design note', notes: 'CURRENT_RECORD_SENTINEL', status: 'Draft',
              fields: { summary: 'CURRENT_FIELD_SENTINEL', fileId: 'BLOB_ID_SENTINEL', fileName: 'FILE_BYTES_SENTINEL' },
              sources: [{ id: 'source-id', url: 'SOURCE_REFERENCE_SENTINEL' }],
            },
            {
              id: 'task-id', type: 'work', title: 'Test plan', notes: 'Saved task note', status: 'draft',
              fields: {
                recipeId: 'prototype-plan',
                inputs: { goal: 'TASK_INPUT_SENTINEL' },
                attachments: ['ATTACHMENT_SENTINEL'],
                briefText: 'SAVED_BRIEF_SENTINEL',
                documentId: 'DOCUMENT_ID_SENTINEL',
              },
            },
          ],
        },
      },
      other: { workspace: { project: { name: 'OTHER_PROJECT_SENTINEL' }, records: [] } },
    },
  };
  const active = workspace.projects.active.workspace;
  const result = buildProjectContext('active', active.project, active.records);

  assert.deepEqual(Object.keys(result.context), ['name', 'text']);
  assert.equal(result.context.name, 'Current project');
  for (const included of ['CURRENT_PROJECT_SENTINEL', 'Business model: B2B', 'CURRENT_RECORD_SENTINEL', 'CURRENT_FIELD_SENTINEL', 'TASK_INPUT_SENTINEL']) {
    assert.ok(result.context.text.includes(included), `${included} should be included`);
  }
  for (const excluded of [
    'PROFILE_SENTINEL', 'PROVIDER_KEY_SENTINEL', 'PROJECT_PROVIDER_SENTINEL', 'EMBEDDED_PROFILE_SENTINEL',
    'OTHER_PROJECT_SENTINEL', 'BLOB_ID_SENTINEL', 'FILE_BYTES_SENTINEL', 'SOURCE_REFERENCE_SENTINEL',
    'ATTACHMENT_SENTINEL', 'SAVED_BRIEF_SENTINEL', 'DOCUMENT_ID_SENTINEL', 'record-id', 'task-id',
  ]) {
    assert.equal(result.context.text.includes(excluded), false, `${excluded} must not be included`);
  }
  assert.equal(result.truncated, false);
});

test('no active project yields no context', () => {
  assert.deepEqual(buildProjectContext(null, { name: 'Ignored' }, [{ title: 'Ignored' }]), { context: null, truncated: false });
});

test('project context respects UTF-8 byte and character limits without splitting a code point', () => {
  const longName = '🛰'.repeat(201);
  const result = buildProjectContext('active', { name: longName, description: '🛰'.repeat(3000) }, []);

  assert.equal(Array.from(result.context.name).length, 200);
  assert.equal(new TextEncoder().encode(result.context.name).byteLength, 800);
  assert.ok(Array.from(result.context.text).length <= 8192);
  assert.ok(new TextEncoder().encode(result.context.text).byteLength <= 8192);
  assert.equal(result.truncated, true);
  assert.equal(result.context.text.includes('\u0000'), false);
});

const EXPECTED_FILE_EXTENSIONS_BY_KIND = {
  document: ['pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log'],
  office: ['docx', 'pptx', 'xlsx', 'odt', 'ods'],
  schematic: ['kicad_sch', 'sch'],
  pcb: ['kicad_pcb', 'brd', 'gbr', 'ger', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gko', 'gm1', 'drl', 'xln'],
  cad3d: ['step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf', 'fcstd'],
  drawing: ['dxf', 'svg'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  stored: ['dwg', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'ipt', 'iam', 'schdoc', 'pcbdoc', 'prjpcb', 'catpart', 'x_t', 'x_b'],
};

test('classifies every supported file extension by kind', () => {
  const expectedExtensions = Object.values(EXPECTED_FILE_EXTENSIONS_BY_KIND).flat();
  assert.deepEqual(SUPPORTED_FILE_EXTENSIONS, expectedExtensions);

  for (const [kind, extensions] of Object.entries(EXPECTED_FILE_EXTENSIONS_BY_KIND)) {
    for (const extension of extensions) {
      assert.equal(classifyFileExtension(`project.${extension}`), kind, `${extension} should be ${kind}`);
    }
  }
});

test('file extension classification is case-insensitive and rejects unsupported names', () => {
  assert.equal(classifyFileExtension('BOARD.KICAD_PCB'), 'pcb');
  assert.equal(classifyFileExtension('MODEL.STP'), 'cad3d');
  assert.equal(classifyFileExtension('notes.pdf.exe'), null);
  assert.equal(classifyFileExtension('notes.constructor'), null);
  assert.equal(classifyFileExtension('notes.__proto__'), null);
  assert.equal(classifyFileExtension('no-extension'), null);
  assert.equal(classifyFileExtension('trailing.'), null);
  assert.equal(classifyFileExtension(null), null);
});

test('RAG file uploads allow files up to 10 MiB', () => {
  assert.equal(MAX_UPLOAD_FILE_BYTES, 10 * 1024 * 1024);
});
