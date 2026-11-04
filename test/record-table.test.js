import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterTableRecords, isUnspecified } from '../src/record-table.js';

test('zero is a specified value while empty values are unspecified', () => {
  assert.equal(isUnspecified(0), false);
  assert.equal(isUnspecified('0'), false);
  assert.equal(isUnspecified(''), true);
  assert.equal(isUnspecified(null), true);
  assert.equal(isUnspecified(undefined), true);
});

test('table filtering searches nested fields case-insensitively and applies status', () => {
  const records = [
    { id: 'a', type: 'bom', title: 'Controller', status: 'Draft', fields: { partNumber: 'ABC-1', quantity: 1, unitCost: 5 } },
    { id: 'b', type: 'bom', title: 'Connector', status: 'Current', fields: { partNumber: 'abc-2', quantity: 1, unitCost: 0 } },
    { id: 'c', type: 'bom', title: 'Sensor', status: 'Current', fields: { partNumber: 'XYZ-3', quantity: 2, unitCost: 2 } },
  ];

  assert.deepEqual(
    filterTableRecords('bom', records, { query: 'ABC', status: 'Current' }).map(record => record.id),
    ['b'],
  );
});
