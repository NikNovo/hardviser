import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBillingSnapshot } from '../src/billing-snapshot.js';

const FREE_SNAPSHOT = {
  environment: 'sandbox',
  plan: 'free',
  expires_at: null,
  verified_at: '2026-11-04T12:00:00.000Z',
};

const MAX_SNAPSHOT = {
  environment: 'sandbox',
  plan: 'max',
  expires_at: '2026-12-04T12:00:00.000Z',
  verified_at: '2026-11-04T12:01:00.000Z',
};

test('a successful lower-plan server snapshot updates access while verification stays pending', () => {
  const result = applyBillingSnapshot(FREE_SNAPSHOT, 'max');

  assert.deepEqual(result.status, FREE_SNAPSHOT);
  assert.equal(result.pendingPlan, 'max');
  assert.equal(result.verified, false);
});

test('a server snapshot at or above the requested plan clears pending verification', () => {
  const result = applyBillingSnapshot(MAX_SNAPSHOT, 'pro');

  assert.deepEqual(result.status, MAX_SNAPSHOT);
  assert.equal(result.pendingPlan, null);
  assert.equal(result.verified, true);
});
