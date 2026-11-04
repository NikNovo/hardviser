import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findPendingAnswer,
  formatFileSize,
  getMentionQuery,
  MAX_TODO_BYTES,
  MAX_TODO_CHARACTERS,
  replaceMentionQuery,
  splitUploadChunks,
  truncateTodoText,
  unicodeCharacterCount,
  unicodePrefix,
} from '../src/rag-chat-helpers.js';

test('mention query parsing finds the file token at the caret', () => {
  assert.deepEqual(getMentionQuery('Review @plan', 12), { start: 7, end: 12, query: 'plan' });
  assert.deepEqual(getMentionQuery('@', 1), { start: 0, end: 1, query: '' });
  assert.equal(getMentionQuery('email@domain.test', 17), null);
  assert.equal(getMentionQuery('Review @plan tomorrow', 17), null);
});

test('mention selection removes only the active token and avoids duplicate spacing', () => {
  const text = 'Review @plan tomorrow';
  const range = getMentionQuery(text, 11);
  assert.equal(replaceMentionQuery(text, range), 'Review tomorrow');
});

test('task text prefixes count Unicode code points and stay within both server limits', () => {
  const source = '🧪'.repeat(MAX_TODO_CHARACTERS + 1);
  const clipped = truncateTodoText(source);
  assert.equal(clipped.truncated, true);
  assert.equal(unicodeCharacterCount(clipped.text), MAX_TODO_CHARACTERS);
  assert.equal(new TextEncoder().encode(clipped.text).byteLength, MAX_TODO_BYTES);
  assert.equal(unicodePrefix('A🧪BC', 2), 'A🧪');
  assert.equal(unicodeCharacterCount('A🧪BC'), 4);
  assert.equal(truncateTodoText('x'.repeat(MAX_TODO_CHARACTERS)).truncated, false);
});

test('file sizes use binary units', () => {
  assert.equal(formatFileSize(10 * 1024 * 1024), '10.0 MiB');
  assert.equal(formatFileSize(Number.NaN), 'Size unknown');
});

test('upload chunks are sequential views no larger than the requested size', () => {
  const source = Uint8Array.of(0, 1, 2, 3, 4);
  const chunks = splitUploadChunks(source, 2);
  assert.deepEqual(chunks.map(chunk => [...chunk]), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(splitUploadChunks(new Uint8Array(), 2), []);
  assert.throws(() => splitUploadChunks(source, 0), RangeError);
});

test('pending-answer detection requires a recent final user message with no assistant reply', () => {
  const userMessage = { id: 'user-1', role: 'user', created_at: '2026-10-31T11:59:30.000Z' };
  assert.equal(findPendingAnswer([userMessage], Date.parse('2026-10-31T12:00:00.000Z')), userMessage);
  assert.equal(findPendingAnswer([userMessage], Date.parse('2026-10-31T12:01:00.000Z')), null);
  assert.equal(findPendingAnswer([
    userMessage,
    { id: 'assistant-1', role: 'assistant', created_at: '2026-10-31T11:59:45.000Z' },
  ], Date.parse('2026-10-31T12:00:00.000Z')), null);
  assert.equal(findPendingAnswer([{ role: 'user', created_at: 'not a date' }], Date.parse('2026-10-31T12:00:00.000Z')), null);
});
