import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/admin.js';

const BRIDGE_URL = 'https://severus.test';
const BRIDGE_KEY = 'b'.repeat(64);
const TOKEN = 'admin-session-token-never-log-this';
const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const AUDIT_ID = '123e4567-e89b-42d3-a456-426614174001';
const CREATED_AT = '2026-11-02T12:00:00Z';
const CURSOR = { at: CREATED_AT, id: USER_ID };
const USER = {
  id: USER_ID,
  login: 'owner@example.com',
  display_name: 'Owner',
  roles: ['admin'],
  email: 'owner@example.com',
  created_at: CREATED_AT,
  disabled_at: null,
  revision: 2,
};
const USER_PAGE = { items: [USER], next_cursor: null };
const AUDIT_PAGE = {
  items: [{
    id: AUDIT_ID,
    created_at: CREATED_AT,
    actor_kind: 'user',
    actor_id: USER_ID,
    actor_label: 'owner@example.com',
    operation: 'admin.users.roles.set',
    target_user_id: USER_ID,
    before: { roles: [], disabled_at: null, revision: 1 },
    after: { roles: ['admin'], disabled_at: null, revision: 2 },
    reason: 'Approved support request',
  }],
  next_cursor: null,
};
const ENV = ['SEVERUS_RAG_BRIDGE_URL', 'SEVERUS_RAG_BRIDGE_HMAC_KEY', 'RAG_CHAT_ENABLED'];

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

async function run({
  body,
  method = 'POST',
  authorization = `Bearer ${TOKEN}`,
  fetchImpl = async () => responseFrom(200, { data: USER_PAGE }),
  capture = false,
  headers = {},
  enabled = 'true',
}) {
  const oldEnv = new Map(ENV.map(name => [name, process.env[name]]));
  const oldFetch = globalThis.fetch;
  const originals = new Map();
  const logs = [];
  if (capture) {
    for (const name of ['debug', 'error', 'info', 'log', 'warn']) {
      originals.set(name, console[name]);
      console[name] = (...args) => logs.push(args.map(String).join(' '));
    }
  }
  Object.assign(process.env, {
    SEVERUS_RAG_BRIDGE_URL: BRIDGE_URL,
    SEVERUS_RAG_BRIDGE_HMAC_KEY: BRIDGE_KEY,
    RAG_CHAT_ENABLED: enabled,
  });
  globalThis.fetch = fetchImpl;
  const serialized = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    method,
    headers: {
      host: 'hardviser.com',
      origin: 'https://hardviser.com',
      authorization,
      'content-length': String(Buffer.byteLength(serialized)),
      'x-forwarded-for': '8.8.8.8',
      ...headers,
    },
    body,
  };
  const res = makeResponse();
  try {
    await handler(req, res);
    return { status: res.statusCode, body: res.body, headers: res.headers, logs };
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of oldEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const [name, fn] of originals) console[name] = fn;
  }
}

function adminRequest(op, fields = {}) { return { op, ...fields }; }

test('admin operations dispatch only fixed bridge paths with the session from bearer auth', async t => {
  const cases = [
    ['admin.users.list', { query: 'owner', role: 'admin', status: 'active', limit: 10, cursor: CURSOR }, '/admin/users/list', USER_PAGE],
    ['admin.users.get', { user_id: USER_ID }, '/admin/users/get', USER],
    ['admin.users.roles.set', { user_id: USER_ID, roles: ['admin'], expected_revision: 1, reason: 'Approved request' }, '/admin/users/roles/set', USER],
    ['admin.users.status.set', { user_id: USER_ID, disabled: false, expected_revision: 1, reason: 'Security review' }, '/admin/users/status/set', USER],
    ['admin.audit.list', { target_user_id: USER_ID, actor_id: USER_ID, operation: 'admin.users.roles.set', since: CREATED_AT, until: CREATED_AT, limit: 20, cursor: CURSOR }, '/admin/audit/list', AUDIT_PAGE],
  ];

  for (const [op, fields, suffix, data] of cases) {
    await t.test(op, async () => {
      let upstream;
      const result = await run({
        body: adminRequest(op, fields),
        fetchImpl: async (url, options) => {
          upstream = { url, options };
          return responseFrom(200, { data });
        },
      });
      assert.equal(result.status, 200);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.equal(upstream.url, `${BRIDGE_URL}/v1/public-rag/chat${suffix}`);
      assert.equal(upstream.options.method, 'POST');
      assert.deepEqual(result.body, { data });
      const forwarded = JSON.parse(Buffer.from(upstream.options.body).toString('utf8'));
      assert.deepEqual(Object.keys(forwarded).sort(), ['request_id', 'session_token', ...Object.keys(fields)].sort());
      assert.equal(forwarded.session_token, TOKEN);
      assert.equal(forwarded.request_id, result.headers['x-rag-request-id']);
      assert.equal(Object.keys(upstream.options.headers).some(key => key.toLowerCase() === 'authorization'), false);
    });
  }
});

test('rejects invalid or cross-endpoint input before bridge access', async t => {
  const invalid = [
    ['unknown op', adminRequest('admin.users.delete')],
    ['ordinary app op', adminRequest('projects.list')],
    ['client actor id', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: [], expected_revision: 0, reason: 'Review', actor_id: USER_ID })],
    ['client request id', adminRequest('admin.users.get', { user_id: USER_ID, request_id: AUDIT_ID })],
    ['client session token', adminRequest('admin.users.get', { user_id: USER_ID, session_token: TOKEN })],
    ['arbitrary path', adminRequest('admin.users.get', { user_id: USER_ID, path: '/users/list' })],
    ['invalid user id', adminRequest('admin.users.get', { user_id: 'not-a-uuid' })],
    ['duplicate role', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['admin', 'admin'], expected_revision: 0, reason: 'Review' })],
    ['unsorted roles', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['expert', 'admin'], expected_revision: 0, reason: 'Review' })],
    ['unknown role', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['owner'], expected_revision: 0, reason: 'Review' })],
    ['non-integer revision', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['admin'], expected_revision: 1.5, reason: 'Review' })],
    ['unsafe revision', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['admin'], expected_revision: Number.MAX_SAFE_INTEGER + 1, reason: 'Review' })],
    ['negative revision', adminRequest('admin.users.status.set', { user_id: USER_ID, disabled: true, expected_revision: -1, reason: 'Review' })],
    ['non-boolean status', adminRequest('admin.users.status.set', { user_id: USER_ID, disabled: 'true', expected_revision: 0, reason: 'Review' })],
    ['invalid limit', adminRequest('admin.users.list', { limit: 101 })],
    ['oversized query', adminRequest('admin.users.list', { query: 'x'.repeat(255) })],
    ['invalid status filter', adminRequest('admin.users.list', { status: 'pending' })],
    ['invalid role filter', adminRequest('admin.users.list', { role: 'operator' })],
    ['malformed cursor', adminRequest('admin.users.list', { cursor: { at: CREATED_AT, id: USER_ID, secret: 'x' } })],
    ['timestamp without timezone', adminRequest('admin.audit.list', { since: '2026-11-02T12:00:00' })],
    ['unknown audit operation', adminRequest('admin.audit.list', { operation: 'admin.users.get' })],
    ['reversed audit interval', adminRequest('admin.audit.list', { since: '2026-11-03T00:00:00Z', until: '2026-11-02T00:00:00Z' })],
    ['blank reason', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: [], expected_revision: 0, reason: '   ' })],
    ['oversized reason', adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: [], expected_revision: 0, reason: 'x'.repeat(501) })],
  ];
  for (const [name, body] of invalid) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await run({ body, fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); } });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'invalid_request');
      assert.equal(calls, 0);
    });
  }
});

test('requires POST, same origin and bearer session before bridge access', async t => {
  for (const [name, options, status, code] of [
    ['method', { method: 'GET' }, 405, 'method_not_allowed'],
    ['origin', { headers: { origin: 'https://attacker.test' } }, 403, 'origin_rejected'],
    ['bearer', { authorization: '' }, 401, 'unauthorized'],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await run({ ...options, body: adminRequest('admin.users.list'), fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); } });
      assert.equal(result.status, status);
      assert.equal(result.body.code, code);
      assert.equal(calls, 0);
    });
  }
});

test('enforces the 48 KiB admin request-body limit', async () => {
  const body = adminRequest('admin.users.list', { query: 'x'.repeat(49 * 1024) });
  let calls = 0;
  const result = await run({ body, fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge request'); } });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'request_too_large');
  assert.equal(calls, 0);
});

test('rejects unexpected or secret fields in every admin response before publication', async t => {
  const invalid = [
    ['unexpected user field', { data: { ...USER, password_hash: 'never-publish-this' } }],
    ['malformed user page', { data: { items: [USER], next_cursor: { at: CREATED_AT, id: USER_ID, token_hash: 'never-publish-this' } } }],
    ['user page exceeds requested limit', { data: { items: [USER, USER], next_cursor: null } }],
    ['unexpected audit field', { data: { items: [{ ...AUDIT_PAGE.items[0], session_token: TOKEN }], next_cursor: null } }],
  ];
  const requests = [
    adminRequest('admin.users.get', { user_id: USER_ID }),
    adminRequest('admin.users.list'),
    adminRequest('admin.users.list', { limit: 1 }),
    adminRequest('admin.audit.list'),
  ];
  for (const [index, [name, response]] of invalid.entries()) {
    await t.test(name, async () => {
      const result = await run({ body: requests[index], fetchImpl: async () => responseFrom(200, response) });
      assert.equal(result.status, 502);
      assert.equal(result.body.code, 'invalid_response');
      assert.equal(JSON.stringify(result.body).includes('never-publish-this'), false);
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
    });
  }
});

test('maps forbidden and only known admin conflict codes to safe public errors', async t => {
  for (const [status, upstreamCode, expectedStatus, expectedCode] of [
    [403, 'forbidden', 403, 'forbidden'],
    [409, 'stale_user', 409, 'stale_user'],
    [409, 'self_protection', 409, 'self_protection'],
    [409, 'last_admin', 409, 'last_admin'],
    [409, 'internal-secret', 409, 'conflict'],
    [409, 'conflict', 409, 'conflict'],
  ]) {
    await t.test(`${status}/${upstreamCode}`, async () => {
      const result = await run({ body: adminRequest('admin.users.get', { user_id: USER_ID }), fetchImpl: async () => responseFrom(status, { code: upstreamCode, error: TOKEN }) });
      assert.equal(result.status, expectedStatus);
      assert.equal(result.body.code, expectedCode);
      assert.equal(JSON.stringify(result.body).includes(TOKEN), false);
    });
  }
});

test('admin logs include operation metadata but never payload, email or session values', async () => {
  const reason = 'Confidential security investigation';
  const result = await run({
    body: adminRequest('admin.users.roles.set', { user_id: USER_ID, roles: ['admin'], expected_revision: 1, reason }),
    capture: true,
    fetchImpl: async () => responseFrom(200, { data: USER }),
  });
  const text = result.logs.join('\n');
  assert.match(text, /admin\.users\.roles\.set/);
  assert.match(text, /request_id/);
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(reason), false);
  assert.equal(text.includes(USER.email), false);
});
