import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/rag-chat.js';

const BRIDGE_URL = 'https://severus.test';
const BRIDGE_KEY = 'a'.repeat(64);
const TOKEN = 'secret-session-token-do-not-log';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHAT_ID = '123e4567-e89b-42d3-a456-426614174001';
const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174002';
const TRUSTED_IP = '8.8.8.8';
const envNames = ['SEVERUS_RAG_BRIDGE_URL', 'SEVERUS_RAG_BRIDGE_HMAC_KEY', 'RAG_CHAT_ENABLED'];

function eventFrames({ readingFiles = 2, messageId = MESSAGE_ID, requestId = REQUEST_ID } = {}) {
  const events = [
    { type: 'progress', stage: 'accepted' },
    { type: 'progress', stage: 'classifying' },
    { type: 'progress', stage: 'classified', route: 'technical' },
    { type: 'progress', stage: 'project_context', available: true },
  ];
  if (readingFiles !== null) events.push({ type: 'progress', stage: 'reading_files', count: readingFiles });
  events.push(
    { type: 'progress', stage: 'searching', queries: ['battery thermal test'] },
    { type: 'progress', stage: 'answering' },
    { type: 'result', data: {
      request_id: requestId,
      message_id: messageId,
      route: 'technical',
      answer: 'Run a controlled bench test.',
      recommendations: ['Measure the current.'],
      unknowns: [],
      follow_up_questions: { general: [], technical: [] },
      model: 'muse-spark-1.3',
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    } },
  );
  return events.map(value => JSON.stringify(value)).join('\n') + '\n';
}

function makeResponse() {
  const headers = {};
  let body = '';
  let statusCode = 200;
  let ended = false;
  const listeners = new Map();
  return {
    get statusCode() { return statusCode; },
    get body() { return body; },
    get headers() { return headers; },
    get writableEnded() { return ended; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
    status(value) { statusCode = value; return this; },
    json(value) { body = value; ended = true; return this; },
    write(value) { body += value; return true; },
    end(value = '') { body += value; ended = true; return this; },
    flushHeaders() {},
    emit(name) { listeners.get(name)?.(); },
    on(name, fn) { listeners.set(name, fn); return this; },
    off(name) { listeners.delete(name); return this; },
    removeListener(name) { listeners.delete(name); return this; },
  };
}

function captureLogs() {
  const originals = new Map();
  const output = [];
  for (const method of ['debug', 'error', 'info', 'log', 'warn']) {
    originals.set(method, console[method]);
    console[method] = (...args) => output.push(args.map(String).join(' '));
  }
  return { output, restore() { for (const [method, fn] of originals) console[method] = fn; } };
}

const CLIENT_REQUEST_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
async function run({ body = { request_id: CLIENT_REQUEST_ID, chat_id: CHAT_ID, question: 'How should I test it?', mentions: [], route_mode: 'technical' }, authorization = `Bearer ${TOKEN}`, fetchImpl = async (_url, options) => {
  const signedRequest = JSON.parse(Buffer.from(options.body).toString('utf8'));
  return new Response(eventFrames({ requestId: signedRequest.request_id }), { headers: { 'content-type': 'application/x-ndjson' } });
}, capture = false, headers = {}, disconnectOnFetch = false } = {}) {
  const oldEnv = new Map(envNames.map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  const logs = capture ? captureLogs() : null;
  Object.assign(process.env, {
    SEVERUS_RAG_BRIDGE_URL: BRIDGE_URL,
    SEVERUS_RAG_BRIDGE_HMAC_KEY: BRIDGE_KEY,
    RAG_CHAT_ENABLED: 'true',
  });
  let res;
  globalThis.fetch = async (...args) => {
    if (disconnectOnFetch) res.emit('close');
    return fetchImpl(...args);
  };
  const requestHeaders = {
    authorization,
    'content-length': String(Buffer.byteLength(JSON.stringify(body))),
    'x-forwarded-for': TRUSTED_IP,
    ...headers,
  };
  const req = { method: 'POST', headers: requestHeaders, body, on() {}, off() {}, aborted: false };
  res = makeResponse();
  try {
    await handler(req, res);
    return { status: res.statusCode, body: res.body, headers: res.headers, logs: logs?.output ?? [] };
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    logs?.restore();
  }
}

function responseEvents(result) {
  assert.equal(typeof result.body, 'string');
  return result.body.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('forwards the bearer token only inside the signed bridge body', async () => {
  let upstream;
  const result = await run({ fetchImpl: async (url, options) => {
    upstream = { url, options };
    const request = JSON.parse(Buffer.from(options.body).toString('utf8'));
    return new Response(eventFrames({ requestId: request.request_id }), { headers: { 'content-type': 'application/x-ndjson' } });
  } });

  assert.equal(result.status, 200);
  assert.equal(upstream.url, `${BRIDGE_URL}/v1/public-rag/chat/ask`);
  const signedBody = JSON.parse(Buffer.from(upstream.options.body).toString('utf8'));
  assert.deepEqual(Object.keys(signedBody).sort(), ['chat_id', 'mentions', 'question', 'request_id', 'route_mode', 'session_token']);
  assert.equal(signedBody.session_token, TOKEN);
  assert.equal(signedBody.chat_id, CHAT_ID);
  assert.equal(signedBody.question, 'How should I test it?');
  assert.equal(signedBody.route_mode, 'technical');
  assert.equal(signedBody.request_id, CLIENT_REQUEST_ID);
  assert.equal(result.headers['x-rag-request-id'], CLIENT_REQUEST_ID);
  assert.equal(Object.keys(upstream.options.headers).some(key => key.toLowerCase() === 'authorization'), false);
  const { headers, body } = upstream.options;
  const canonical = `${headers['X-RAG-Timestamp']}\n${headers['X-RAG-Nonce']}\nPOST\n/v1/public-rag/chat/ask\n`;
  const expected = createHmac('sha256', Buffer.from(BRIDGE_KEY, 'hex')).update(canonical).update(body).digest('hex');
  assert.equal(headers['X-RAG-Signature'], expected);
});

test('validates and forwards the reading_files stage and message_id result field', async () => {
  const result = await run();
  assert.equal(result.status, 200);
  const events = responseEvents(result);
  assert.deepEqual(events.find(event => event.stage === 'reading_files'), { type: 'progress', stage: 'reading_files', count: 2 });
  assert.equal(events.at(-1).data.message_id, MESSAGE_ID);
});

test('rejects malformed reading_files counts and message IDs from the bridge', async t => {
  for (const [label, frameOptions] of [
    ['zero files', { readingFiles: 0 }],
    ['over the project file cap', { readingFiles: 201 }],
    ['non-integer file count', { readingFiles: 1.5 }],
    ['invalid message id', { messageId: 'not-a-uuid' }],
  ]) {
    await t.test(label, async () => {
      const result = await run({ fetchImpl: async (_url, fetchOptions) => {
        const request = JSON.parse(Buffer.from(fetchOptions.body).toString('utf8'));
        return new Response(eventFrames({ ...frameOptions, requestId: request.request_id }), { headers: { 'content-type': 'application/x-ndjson' } });
      } });
      const events = responseEvents(result);
      if (label !== 'invalid message id') assert.equal(events.some(event => event.stage === 'reading_files'), false);
      assert.notEqual(events.at(-1).type, 'result');
      if (label === 'invalid message id') assert.equal(events.at(-1).type, 'error');
    });
  }
});

test('requires a bearer session and rejects legacy or unknown ask fields before bridge access', async t => {
  for (const [label, options, expectedStatus] of [
    ['missing bearer', { authorization: '' }, 401],
    ['Basic auth', { authorization: `Basic ${Buffer.from('admin:old-password').toString('base64')}` }, 401],
    ['legacy project_context', { body: { chat_id: CHAT_ID, question: 'Question?', mentions: [], project_context: 'legacy' } }, 400],
    ['legacy history', { body: { chat_id: CHAT_ID, question: 'Question?', mentions: [], history: [] } }, 400],
    ['unknown field', { body: { chat_id: CHAT_ID, question: 'Question?', mentions: [], admin: true } }, 400],
    ['missing request_id', { body: { chat_id: CHAT_ID, question: 'Question?', mentions: [], route_mode: 'auto' } }, 400],
    ['malformed request_id', { body: { request_id: 'not-a-uuid', chat_id: CHAT_ID, question: 'Question?', mentions: [], route_mode: 'auto' } }, 400],
  ]) {
    await t.test(label, async () => {
      let calls = 0;
      const result = await run({ ...options, fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); } });
      assert.equal(result.status, expectedStatus);
      assert.equal(calls, 0);
    });
  }
});

test('client error reports require bearer auth, are never forwarded, and do not log the token', async () => {
  let calls = 0;
  const result = await run({
    body: { event: 'client_error', request_id: REQUEST_ID, code: 'stream_interrupted', stage: 'reading_files' },
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
    capture: true,
  });
  assert.equal(result.status, 204);
  assert.equal(calls, 0);
  assert.equal(result.logs.join('\n').includes(TOKEN), false);
});

test('does not expose the bearer token in request or client-error logs', async () => {
  const result = await run({ capture: true });
  assert.equal(result.logs.join('\n').includes(TOKEN), false);
  assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
});
test('keeps the signed bridge request running and logs disconnects when the client closes', async () => {
  let cancelled = false;
  const result = await run({
    capture: true,
    disconnectOnFetch: true,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, false);
      const request = JSON.parse(Buffer.from(options.body).toString('utf8'));
      const bytes = Buffer.from(eventFrames({ requestId: request.request_id }));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 40));
          controller.enqueue(bytes.subarray(40));
          controller.close();
        },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
    },
  });
  assert.equal(result.body, '');
  assert.equal(cancelled, false);
  assert.match(result.logs.join('\n'), /"client_disconnected":true/);
  assert.equal(result.logs.join('\n').includes(TOKEN), false);
});
