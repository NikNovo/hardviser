import assert from 'node:assert/strict';
import test from 'node:test';
import { isAmbiguousError } from '../src/admin/admin-helpers.js';

test('service unavailability requires mutation outcome reconciliation', () => {
  assert.equal(isAmbiguousError({ status: 503 }), true);
  assert.equal(isAmbiguousError({ code: 'service_unavailable' }), true);
});

test('definite request and authorization failures are not uncertain outcomes', () => {
  for (const status of [400, 401, 403, 409]) {
    assert.equal(isAmbiguousError({ status }), false);
  }
});
