import assert from 'node:assert/strict';
import test from 'node:test';
import { getBillingStatus, syncBilling } from '../src/rag-chat-api.js';

const SNAPSHOT = {
  environment: 'sandbox', plan: 'ultra_pro',
  expires_at: '2026-12-04T12:00:00+00:00',
  verified_at: '2026-11-04T12:00:00+00:00',
};

async function withFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}


test('billing API client rejects a non-sandbox or malformed provider snapshot', async () => {
  await withFetch(async () => new Response(JSON.stringify({
    data: { ...SNAPSHOT, environment: 'production' },
  }), { status: 200 }), async () => {
    await assert.rejects(getBillingStatus(), error => error.code === 'invalid_response');
  });

  await withFetch(async () => new Response(JSON.stringify({
    data: { ...SNAPSHOT, plan: 'enterprise' },
  }), { status: 200 }), async () => {
    await assert.rejects(syncBilling(), error => error.code === 'invalid_response');
  });
});
