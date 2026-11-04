import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import handler from '../api/revenuecat-webhook.js';

const BRIDGE_URL = 'https://severus.test';
const BRIDGE_KEY = 'b'.repeat(64);
const WEBHOOK_AUTHORIZATION = 'Bearer rc-webhook-auth';
const WEBHOOK_SECRET = 'sandbox-webhook-secret';
const APP_ID = 'app96e448cc36';
const EVENT = {
  id: 'evt-probe-1', type: 'TEST', event_timestamp_ms: 1793793600000,
  app_id: APP_ID, environment: 'SANDBOX',
};
const BODY = Buffer.from(JSON.stringify({ api_version: '1.0', event: EVENT }));

function makeSignature(rawBody, timestamp = String(Math.floor(Date.now() / 1000))) {
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}


async function run({ rawBody = BODY, authorization = WEBHOOK_AUTHORIZATION,
  signature = makeSignature(rawBody), fetchImpl = async () => new Response(
    JSON.stringify({ data: { accepted: true } }), { status: 200 }), }) {
  const previous = new Map([
    ['SEVERUS_RAG_BRIDGE_URL', process.env.SEVERUS_RAG_BRIDGE_URL],
    ['SEVERUS_RAG_BRIDGE_HMAC_KEY', process.env.SEVERUS_RAG_BRIDGE_HMAC_KEY],
    ['REVENUECAT_ENVIRONMENT', process.env.REVENUECAT_ENVIRONMENT],
    ['REVENUECAT_APP_ID', process.env.REVENUECAT_APP_ID],
    ['REVENUECAT_WEBHOOK_AUTHORIZATION', process.env.REVENUECAT_WEBHOOK_AUTHORIZATION],
    ['REVENUECAT_WEBHOOK_SIGNING_SECRET', process.env.REVENUECAT_WEBHOOK_SIGNING_SECRET],
  ]);
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    SEVERUS_RAG_BRIDGE_URL: BRIDGE_URL,
    SEVERUS_RAG_BRIDGE_HMAC_KEY: BRIDGE_KEY,
    REVENUECAT_ENVIRONMENT: 'sandbox',
    REVENUECAT_APP_ID: APP_ID,
    REVENUECAT_WEBHOOK_AUTHORIZATION: WEBHOOK_AUTHORIZATION,
    REVENUECAT_WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
  });
  globalThis.fetch = fetchImpl;
  const request = new Request('https://hardviser.test/api/revenuecat-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(rawBody.byteLength),
      authorization,
      'x-revenuecat-webhook-signature': signature,
    },
    body: rawBody,
  });
  try {
    const response = await handler.fetch(request);
    return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('forged webhook signature and incorrect raw-body signature are rejected before bridge access', async () => {
  let calls = 0;
  const forged = await run({
    signature: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge call'); },
  });
  assert.equal(forged.status, 401);

  const spacedBody = Buffer.from(JSON.stringify({ api_version: '1.0', event: EVENT }, null, 2));
  const reserializedSignature = makeSignature(BODY);
  const normalized = await run({
    rawBody: spacedBody,
    signature: reserializedSignature,
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge call'); },
  });
  assert.equal(normalized.status, 401);
  assert.equal(calls, 0);
});

test('valid webhook signature covers exact raw bytes and bridges only to the dedicated backend path', async () => {
  const rawBody = Buffer.from(` {"api_version":"1.0", "event":${JSON.stringify(EVENT)} }\n`);
  let forwarded;
  const result = await run({
    rawBody,
    signature: makeSignature(rawBody),
    fetchImpl: async (url, options) => {
      forwarded = { url, body: JSON.parse(Buffer.from(options.body).toString('utf8')) };
      return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
    },
  });
  assert.equal(result.status, 200);
  assert.equal(forwarded.url, `${BRIDGE_URL}/v1/public-rag/chat/revenuecat-webhook`);
  assert.deepEqual(forwarded.body.payload, { api_version: '1.0', event: { ...EVENT } });
});

test('webhook rejects stale signatures and wrong configured authorization', async () => {
  let calls = 0;
  const oldTimestamp = String(Math.floor(Date.now() / 1000) - 301);
  const stale = await run({
    signature: makeSignature(BODY, oldTimestamp),
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge call'); },
  });
  assert.equal(stale.status, 401);

  const unauthorized = await run({
    authorization: 'Bearer not-the-configured-value',
    fetchImpl: async () => { calls += 1; throw new Error('unexpected bridge call'); },
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls, 0);
});
