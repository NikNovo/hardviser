import assert from 'node:assert/strict';
import test from 'node:test';
import { UTILITY_PAGES } from '../src/nav.js';

test('RAG chat is absent from default utility navigation', () => {
  assert.equal(UTILITY_PAGES.some(page => page.path === '/rag-chat'), false);
});
