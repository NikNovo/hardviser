import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../api/app.js';

const LINK_TOKEN = 'a'.repeat(43);
const EMAIL = 'owner@example.com';
const variables = {
  RAG_CHAT_ENABLED: 'true',
  SEVERUS_RAG_BRIDGE_URL: 'https://severus.test',
  SEVERUS_RAG_BRIDGE_HMAC_KEY: 'b'.repeat(64),
  TURNSTILE_SECRET_KEY: 'private-turnstile-server-secret',
  RESEND_API_KEY: 're_' + 'x'.repeat(33),
  RESEND_FROM: 'Hardviser <login@hub.hardviser.com>',
  RESEND_REPLY_TO: 'hello@hardviser.com',
  AUTH_ORIGIN: 'https://hardviser.com',
};

async function requestLink(verified) {
  const previous = new Map(Object.keys(variables).map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const logs = [];
  const consoleMethods = ['debug', 'error', 'info', 'log', 'warn'];
  const oldConsole = new Map(consoleMethods.map(name => [name, console[name]]));
  Object.assign(process.env, variables);
  for (const name of consoleMethods) console[name] = (...args) => logs.push(args.map(String).join(' '));
  globalThis.fetch = async url => {
    const address = String(url);
    if (address.startsWith('https://challenges.cloudflare.com/')) {
      return new Response(JSON.stringify({ success: verified, hostname: 'hardviser.com', action: 'email_login' }));
    }
    if (!verified) throw new Error('An unverified client must not reach the token issuer or mail provider');
    if (address.startsWith('https://severus.test/')) {
      return new Response(JSON.stringify({ data: { email: EMAIL, token: LINK_TOKEN, expires_at: '2030-01-01T00:15:00Z', return_to: '/overview' } }));
    }
    if (address === 'https://api.resend.com/emails') return new Response(JSON.stringify({ id: 'mail-receipt' }));
    throw new Error('Unexpected external service');
  };
  const res = {
    statusCode: 200,
    body: null,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await handler({ method: 'POST', headers: { host: 'hardviser.com', origin: 'https://hardviser.com', 'x-forwarded-for': '8.8.8.8' }, body: { op: 'auth.email.request', email: EMAIL, turnstile_token: 'challenge-token', return_to: '/overview' } }, res);
    return { status: res.statusCode, body: res.body, logs: logs.join('\n') };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, fn] of oldConsole) console[name] = fn;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const LOGIN_RESULT = {
  id: '123e4567-e89b-42d3-a456-426614174006',
  login: EMAIL,
  display_name: null,
  roles: ['expert'],
  token: 's'.repeat(43),
  expires_at: '2030-01-01T00:15:00Z',
};

async function consumeEmailSession(data) {
  const names = ['RAG_CHAT_ENABLED', 'SEVERUS_RAG_BRIDGE_URL', 'SEVERUS_RAG_BRIDGE_HMAC_KEY'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, {
    RAG_CHAT_ENABLED: variables.RAG_CHAT_ENABLED,
    SEVERUS_RAG_BRIDGE_URL: variables.SEVERUS_RAG_BRIDGE_URL,
    SEVERUS_RAG_BRIDGE_HMAC_KEY: variables.SEVERUS_RAG_BRIDGE_HMAC_KEY,
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ data }));
  const res = {
    statusCode: 200,
    body: null,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await handler({
      method: 'POST',
      headers: { host: 'hardviser.com', origin: 'https://hardviser.com', 'x-forwarded-for': '8.8.8.8' },
      body: { op: 'auth.email.consume', token: LINK_TOKEN },
    }, res);
    return { status: res.statusCode, body: res.body };
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('email consume accepts the strict LoginResult identity contract', async () => {
  const result = await consumeEmailSession(LOGIN_RESULT);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: LOGIN_RESULT });
});

test('email consume rejects the legacy session shape and extra identity secrets', async t => {
  for (const [name, data] of [
    ['legacy session', { id: LOGIN_RESULT.id, login: EMAIL, token: LOGIN_RESULT.token, expires_at: LOGIN_RESULT.expires_at }],
    ['session token equals link token', { ...LOGIN_RESULT, token: LINK_TOKEN }],
    ['unexpected secret field', { ...LOGIN_RESULT, token_hash: 'private-hash' }],
    ['invalid roles', { ...LOGIN_RESULT, roles: ['admin', 'admin'] }],
  ]) {
    await t.test(name, async () => {
      const result = await consumeEmailSession(data);
      assert.equal(result.status, 502);
      assert.equal(result.body.code, 'invalid_response');
      assert.equal(JSON.stringify(result.body).includes('private-hash'), false);
    });
  }
});

test('an unverified challenge cannot issue a sign-in link', async () => {
  const result = await requestLink(false);
  assert.equal(result.status, 403);
});

test('the sign-in token and provider key never appear in the public response or logs', async () => {
  const result = await requestLink(true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: { ok: true } });
  for (const secret of [LINK_TOKEN, variables.RESEND_API_KEY, variables.TURNSTILE_SECRET_KEY]) {
    assert.equal(JSON.stringify(result.body).includes(secret), false);
    assert.equal(result.logs.includes(secret), false);
  }
});
