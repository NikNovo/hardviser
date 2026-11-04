import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/app.js';

const BRIDGE_URL = 'https://severus.test';
const BRIDGE_KEY = 'b'.repeat(64);
const TOKEN = 'app-session-token-never-log-this';
const PROJECT_ID = '123e4567-e89b-42d3-a456-426614174000';
const CHAT_ID = '123e4567-e89b-42d3-a456-426614174001';
const FILE_ID = '123e4567-e89b-42d3-a456-426614174002';
const UPLOAD_ID = '123e4567-e89b-42d3-a456-426614174003';
const TODO_ID = '123e4567-e89b-42d3-a456-426614174004';
const MESSAGE_ID = '123e4567-e89b-42d3-a456-426614174005';
const USER_ID = '123e4567-e89b-42d3-a456-426614174006';
const IDENTITY = { id: USER_ID, login: 'owner@example.com', display_name: 'Owner', roles: [] };
const envNames = ['SEVERUS_RAG_BRIDGE_URL', 'SEVERUS_RAG_BRIDGE_HMAC_KEY', 'RAG_CHAT_ENABLED'];

function responseFrom(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function makeResponse() {
  const headers = {};
  let statusCode = 200;
  let body;
  return {
    get statusCode() { return statusCode; },
    get body() { return body; },
    get headers() { return headers; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return this; },
    status(value) { statusCode = value; return this; },
    json(value) { body = value; return this; },
    end() {},
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

async function run({ body, bodyGetter, authorization = `Bearer ${TOKEN}`, fetchImpl = async () => responseFrom(200, { data: { ok: true } }), capture = false, headers = {}, enabled = 'true' }) {
  const oldEnv = new Map(envNames.map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  const logs = capture ? captureLogs() : null;
  Object.assign(process.env, {
    SEVERUS_RAG_BRIDGE_URL: BRIDGE_URL,
    SEVERUS_RAG_BRIDGE_HMAC_KEY: BRIDGE_KEY,
    RAG_CHAT_ENABLED: enabled,
  });
  globalThis.fetch = fetchImpl;
  const req = {
    method: 'POST',
    headers: {
      authorization,
      'content-length': String(Buffer.byteLength(JSON.stringify(body))),
      'x-forwarded-for': '8.8.8.8',
      ...headers,
    },
  };
  if (bodyGetter) {
    Object.defineProperty(req, 'body', {
      configurable: true,
      enumerable: true,
      get: bodyGetter,
    });
  } else {
    req.body = body;
  }
  const res = makeResponse();
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

function appRequest(op, args = {}) { return { op, ...args }; }

const invalidRequests = [
  ['login', appRequest('login', { login: '', password: 'pass' })],
  ['logout', appRequest('logout', { unexpected: true })],
  ['account.profile.update missing display_name', appRequest('account.profile.update')],
  ['account.profile.update actor spoof', appRequest('account.profile.update', { display_name: 'Owner', actor_id: USER_ID })],
  ['account.profile.update user spoof', appRequest('account.profile.update', { display_name: 'Owner', user_id: USER_ID })],
  ['account.profile.update token spoof', appRequest('account.profile.update', { display_name: 'Owner', session_token: TOKEN })],
  ['account.profile.update untrimmed name', appRequest('account.profile.update', { display_name: ' Owner ' })],
  ['account.profile.update empty name', appRequest('account.profile.update', { display_name: '' })],
  ['account.profile.update oversized name', appRequest('account.profile.update', { display_name: 'x'.repeat(81) })],
  ['account.profile.update control character', appRequest('account.profile.update', { display_name: 'Owner\u0000' })],
  ['admin operation on app endpoint', appRequest('admin.users.list')],
  ['projects.list', appRequest('projects.list', { project_id: PROJECT_ID })],
  ['projects.create', appRequest('projects.create', { brief_text: 'brief without a name' })],
  ['projects.update', appRequest('projects.update', { project_id: PROJECT_ID, unexpected: true })],
  ['projects.delete', appRequest('projects.delete', { project_id: 'not-a-uuid' })],
  ['chats.list', appRequest('chats.list')],
  ['chats.create', appRequest('chats.create', { project_id: PROJECT_ID, title: '' })],
  ['chats.update', appRequest('chats.update', { chat_id: CHAT_ID })],
  ['chats.delete', appRequest('chats.delete', { chat_id: 'not-a-uuid' })],
  ['messages.list', appRequest('messages.list', { chat_id: CHAT_ID, limit: 1 })],
  ['files.list', appRequest('files.list')],
  ['files.delete', appRequest('files.delete', { file_id: 'not-a-uuid' })],
  ['todos.list', appRequest('todos.list')],
  ['todos.create oversized UTF-8 text', appRequest('todos.create', { project_id: PROJECT_ID, text: 'é'.repeat(4001) })],
  ['todos.create invalid source message', appRequest('todos.create', { project_id: PROJECT_ID, text: 'Task', source_message_id: 'not-a-uuid' })],
  ['todos.update', appRequest('todos.update', { todo_id: FILE_ID })],
  ['todos.update completed', appRequest('todos.update', { todo_id: FILE_ID, completed: 'true' })],
  ['todos.delete', appRequest('todos.delete', { todo_id: 'not-a-uuid' })],
  ['projects.brief.save', appRequest('projects.brief.save', { project_id: PROJECT_ID, field: 'other', text: '', expected_text: '' })],
  ['projects.brief.save missing expected', appRequest('projects.brief.save', { project_id: PROJECT_ID, field: 'notes', text: '' })],
  ['projects.brief.save oversized text', appRequest('projects.brief.save', { project_id: PROJECT_ID, field: 'notes', text: 'é'.repeat(4097), expected_text: '' })],
  ['files.browse', appRequest('files.browse', { project_id: PROJECT_ID })],
  ['files.attach', appRequest('files.attach', { project_id: PROJECT_ID })],
  ['files.attach invalid file', appRequest('files.attach', { project_id: PROJECT_ID, file_id: 'not-a-uuid' })],
  ['files.upload.start', appRequest('files.upload.start', { project_id: PROJECT_ID, name: 'notes.exe', mime: 'application/octet-stream', size_bytes: 1, sha256: '0'.repeat(64) })],
  ['files.upload.chunk', appRequest('files.upload.chunk', { upload_id: UPLOAD_ID, index: -1, data_b64: 'YQ==' })],
  ['files.upload.finish', appRequest('files.upload.finish')],
];


test('accepts every supported upload extension case-insensitively without restricting MIME type', async t => {
  const extensions = [
    'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log',
    'docx', 'pptx', 'xlsx', 'odt', 'ods',
    'kicad_sch', 'sch', 'kicad_pcb', 'brd',
    'gbr', 'ger', 'gtl', 'gbl', 'gto', 'gbo', 'gts', 'gbs', 'gko', 'gm1', 'drl', 'xln',
    'step', 'stp', 'iges', 'igs', 'stl', 'obj', '3mf', 'fcstd',
    'dxf', 'svg',
    'png', 'jpg', 'jpeg', 'webp', 'gif',
    'dwg', 'sldprt', 'sldasm', 'slddrw', 'f3d', 'ipt', 'iam', 'schdoc', 'pcbdoc', 'prjpcb', 'catpart', 'x_t', 'x_b',
  ];
  const mimes = ['', 'application/octet-stream', 'm'.repeat(100)];

  for (const [index, extension] of extensions.entries()) {
    await t.test(extension, async () => {
      const mime = mimes[index % mimes.length];
      let forwarded;
      const result = await run({
        body: appRequest('files.upload.start', {
          project_id: PROJECT_ID,
          name: `design.${extension.toUpperCase()}`,
          mime,
          size_bytes: 1,
          sha256: '0'.repeat(64),
        }),
        capture: true,
        fetchImpl: async (_url, options) => {
          forwarded = JSON.parse(Buffer.from(options.body).toString('utf8'));
          return responseFrom(200, { data: {} });
        },
      });
      assert.equal(result.status, 200);
      assert.equal(forwarded.name, `design.${extension.toUpperCase()}`);
      assert.equal(forwarded.mime, mime);
    });
  }
});

test('accepts the 200-character filename and inclusive 10 MiB new-upload limit', async () => {
  const name = `${'a'.repeat(196)}.txt`;
  let forwarded;
  const result = await run({
    body: appRequest('files.upload.start', {
      project_id: PROJECT_ID,
      name,
      mime: '',
      size_bytes: 10485760,
      sha256: '0'.repeat(64),
    }),
    capture: true,
    fetchImpl: async (_url, options) => {
      forwarded = JSON.parse(Buffer.from(options.body).toString('utf8'));
      return responseFrom(200, { data: {} });
    },
  });
  assert.equal(result.status, 200);
  assert.equal(forwarded.name, name);
  assert.equal(forwarded.size_bytes, 10485760);
  assert.equal(forwarded.mime, '');
});

test('rejects unsupported upload extensions with the supported-formats message before bridge access', async () => {
  let calls = 0;
  const result = await run({
    body: appRequest('files.upload.start', {
      project_id: PROJECT_ID,
      name: 'design.exe',
      mime: 'application/octet-stream',
      size_bytes: 1,
      sha256: '0'.repeat(64),
    }),
    capture: true,
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'unsupported_type');
  assert.equal(result.body.error, 'Unsupported file type. See the list of supported formats.');
  assert.equal(calls, 0);
});

test('rejects upload metadata outside filename, MIME and new-file size bounds before bridge access', async t => {
  const cases = [
    ['201-character filename', { name: `${'a'.repeat(197)}.txt` }],
    ['101-character MIME', { mime: 'm'.repeat(101) }],
    ['over 10 MiB', { size_bytes: 10485761 }],
  ];
  for (const [label, overrides] of cases) {
    await t.test(label, async () => {
      let calls = 0;
      const result = await run({
        body: appRequest('files.upload.start', {
          project_id: PROJECT_ID,
          name: 'design.txt',
          mime: '',
          size_bytes: 1,
          sha256: '0'.repeat(64),
          ...overrides,
        }),
        capture: true,
        fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'invalid_request');
      assert.equal(calls, 0);
    });
  }
});

test('uses the supported-formats message when the bridge rejects uploaded content type', async () => {
  const result = await run({
    body: appRequest('files.upload.start', {
      project_id: PROJECT_ID,
      name: 'design.txt',
      mime: '',
      size_bytes: 1,
      sha256: '0'.repeat(64),
    }),
    capture: true,
    fetchImpl: async () => responseFrom(400, { code: 'unsupported_type', error: 'private backend detail' }),
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'unsupported_type');
  assert.equal(result.body.error, 'Unsupported file type. See the list of supported formats.');
});

test('rejects invalid input for every operation before contacting the bridge', async t => {
  for (const [op, body] of invalidRequests) {
    await t.test(op, async () => {
      let calls = 0;
      const result = await run({ body, fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); } });
      assert.equal(result.status, 400);
      assert.equal(calls, 0);
      if (op === 'files.upload.start') assert.equal(result.body.code, 'unsupported_type');
      else assert.equal(result.body.code, 'invalid_request');
    });
  }
});

test('maps Vercel lazy JSON parser errors to the invalid-request envelope', async () => {
  const parserError = Object.assign(new Error('Invalid JSON'), { statusCode: 400 });
  let calls = 0;
  const result = await run({
    body: 'not-json',
    bodyGetter: () => {
      throw parserError;
    },
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength('not-json')),
    },
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid_request');
  assert.equal(calls, 0);
});

test('rethrows unexpected lazy request-body errors', async () => {
  const parserError = Object.assign(new Error('Body parser failed internally'), { statusCode: 400 });
  await assert.rejects(
    run({
      body: 'not-json',
      bodyGetter: () => { throw parserError; },
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength('not-json')),
      },
    }),
    error => error === parserError,
  );
});


test('enforces the 10 MiB new-upload limit before bridge access', async () => {
  let calls = 0;
  const result = await run({
    body: appRequest('files.upload.start', {
      project_id: PROJECT_ID,
      name: 'large.txt',
      mime: 'text/plain',
      size_bytes: 10485761,
      sha256: '0'.repeat(64),
    }),
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid_request');
  assert.equal(calls, 0);
});

test('forwards only the profile display name and returns a validated Identity', async () => {
  let upstream;
  const result = await run({
    body: appRequest('account.profile.update', { display_name: 'Owner' }),
    fetchImpl: async (url, options) => {
      upstream = { url, options };
      return responseFrom(200, { data: IDENTITY });
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: IDENTITY });
  assert.equal(upstream.url, `${BRIDGE_URL}/v1/public-rag/chat/account/profile/update`);
  const body = JSON.parse(Buffer.from(upstream.options.body).toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['display_name', 'request_id', 'session_token']);
  assert.equal(body.display_name, 'Owner');
  assert.equal(body.session_token, TOKEN);
});

test('forwards authenticated billing requests without a client user ID and validates sandbox snapshots', async () => {
  const snapshot = {
    environment: 'sandbox', plan: 'free', expires_at: null,
    verified_at: '2026-11-04T12:00:00+00:00',
  };
  let upstream;
  const result = await run({
    body: appRequest('billing.status'),
    fetchImpl: async (url, options) => {
      upstream = { url, options };
      return responseFrom(200, { data: snapshot });
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: snapshot });
  assert.equal(upstream.url, `${BRIDGE_URL}/v1/public-rag/chat/billing/status`);
  const body = JSON.parse(Buffer.from(upstream.options.body).toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['request_id', 'session_token']);
  assert.equal(body.session_token, TOKEN);
});

test('rejects billing responses that are not valid sandbox snapshots', async () => {
  const result = await run({
    body: appRequest('billing.sync'),
    fetchImpl: async () => responseFrom(200, {
      data: {
        environment: 'production', plan: 'max',
        expires_at: '2026-12-04T12:00:00Z', verified_at: '2026-11-04T12:00:00Z',
      },
    }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'invalid_response');
});
test('accepts null as the explicit empty profile display name', async () => {
  const result = await run({
    body: appRequest('account.profile.update', { display_name: null }),
    fetchImpl: async () => responseFrom(200, { data: { ...IDENTITY, display_name: null } }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.display_name, null);
});

test('rejects Identity responses containing fields outside the account contract', async () => {
  const result = await run({
    body: appRequest('me'),
    fetchImpl: async () => responseFrom(200, { data: { ...IDENTITY, password_hash: 'private-hash' } }),
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'invalid_response');
  assert.equal(JSON.stringify(result.body).includes('private-hash'), false);
});

test('forwards the bearer token inside the HMAC-signed body and never as a bridge header', async () => {
  let upstream;
  const result = await run({
    body: appRequest('projects.list'),
    fetchImpl: async (url, options) => { upstream = { url, options }; return responseFrom(200, { data: [] }); },
  });
  assert.equal(result.status, 200);
  assert.equal(upstream.url, `${BRIDGE_URL}/v1/public-rag/chat/projects/list`);
  const body = JSON.parse(Buffer.from(upstream.options.body).toString('utf8'));
  assert.deepEqual(Object.keys(body).sort(), ['request_id', 'session_token']);
  assert.equal(body.session_token, TOKEN);
  assert.equal(body.request_id, result.headers['x-rag-request-id']);
  assert.equal(Object.keys(upstream.options.headers).some(key => key.toLowerCase() === 'authorization'), false);
  const headers = upstream.options.headers;
  const canonical = `${headers['X-RAG-Timestamp']}\n${headers['X-RAG-Nonce']}\nPOST\n/v1/public-rag/chat/projects/list\n`;
  const signature = createHmac('sha256', Buffer.from(BRIDGE_KEY, 'hex')).update(canonical).update(upstream.options.body).digest('hex');
  assert.equal(headers['X-RAG-Signature'], signature);
});

test('includes a keyed client bucket in login without a bearer token', async () => {
  let upstream;
  const result = await run({
    body: appRequest('login', { login: 'founder', password: 'private-password' }),
    authorization: '',
    fetchImpl: async (url, options) => { upstream = options; return responseFrom(200, { data: { ...IDENTITY, token: 'new-session-token', expires_at: '2030-01-01T00:00:00Z' } }); },
  });
  assert.deepEqual(result.body, { data: { ...IDENTITY, token: 'new-session-token', expires_at: '2030-01-01T00:00:00Z' } });
  const body = JSON.parse(Buffer.from(upstream.body).toString('utf8'));
  const expected = createHmac('sha256', Buffer.from(BRIDGE_KEY, 'hex')).update('client-bucket\n8.8.8.8').digest('hex');
  assert.equal(body.client_bucket, expected);
  assert.equal(Object.hasOwn(body, 'session_token'), false);
  assert.equal(Object.keys(upstream.headers).some(key => key.toLowerCase() === 'authorization'), false);
});

test('enforces the raw upload chunk limit of 2 MiB before bridge access', async () => {
  const tooLargeChunk = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  let calls = 0;
  const result = await run({
    body: appRequest('files.upload.chunk', { upload_id: UPLOAD_ID, index: 0, data_b64: tooLargeChunk }),
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid_request');
  assert.equal(calls, 0);
});

test('accepts upload chunks at the inclusive 2 MiB raw limit', async () => {
  const chunk = Buffer.alloc(2 * 1024 * 1024).toString('base64');
  let forwarded = false;
  const result = await run({
    body: appRequest('files.upload.chunk', { upload_id: UPLOAD_ID, index: 0, data_b64: chunk }),
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(Buffer.from(options.body).toString('utf8'));
      assert.equal(body.data_b64, chunk);
      forwarded = true;
      return responseFrom(200, { data: {} });
    },
  });
  assert.equal(result.status, 200);
  assert.equal(forwarded, true);
});

test('maps bridge failures using fixed messages and does not expose upstream text', async t => {
  for (const [status, code, expectedCode] of [
    [401, 'unauthorized', 'unauthorized'],
    [403, 'forbidden', 'forbidden'],
    [404, 'not_found', 'not_found'],
    [409, 'duplicate_request', 'conflict'],
    [413, 'request_too_large', 'request_too_large'],
    [429, 'quota_exceeded', 'quota_exceeded'],
    [503, 'service_unavailable', 'service_unavailable'],
  ]) {
    await t.test(String(status), async () => {
      const result = await run({ body: appRequest('me'), fetchImpl: async () => responseFrom(status, { code, error: TOKEN }) });
      assert.equal(result.status, status);
      assert.equal(result.body.code, expectedCode);
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
    });
  }
});

test('does not include the session token in application logs', async () => {
  const result = await run({ body: appRequest('me'), capture: true, fetchImpl: async () => responseFrom(200, { data: IDENTITY }) });
  assert.equal(result.status, 200);
  assert.equal(result.logs.join('\n').includes(TOKEN), false);
});
test('maps forbidden without logging upstream payload fields', async () => {
  const secretEmail = 'private@example.com';
  const result = await run({
    body: appRequest('me'),
    capture: true,
    fetchImpl: async () => responseFrom(403, { code: 'forbidden', error: TOKEN, email: secretEmail }),
  });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'forbidden');
  const logs = result.logs.join('\n');
  assert.equal(logs.includes(TOKEN), false);
  assert.equal(logs.includes(secretEmail), false);
});

test('rejects Basic auth and never serves requests with the feature flag disabled', async () => {
  let calls = 0;
  const basic = await run({
    body: appRequest('me'),
    authorization: `Basic ${Buffer.from('admin:password').toString('base64')}`,
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(basic.status, 401);
  assert.equal(calls, 0);

  const disabled = await run({
    body: appRequest('login', { login: 'founder', password: 'password' }),
    enabled: 'false',
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); },
  });
  assert.equal(disabled.status, 404);
  assert.equal(calls, 0);
});
