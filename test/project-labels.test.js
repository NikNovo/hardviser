import test from 'node:test';
import assert from 'node:assert/strict';
import * as portfolio from '../src/portfolio.js';

test('projectDisplayLabels labels duplicate names by portfolio order', () => {
  const projects = [
    { id: 'p1', name: 'Alpha Lab' },
    { id: 'p2', name: 'Beta' },
    { id: 'p3', name: 'Alpha Lab' },
  ];
  const labels = portfolio.projectDisplayLabels?.(projects) ?? new Map();
  assert.deepEqual([...labels.values()], [
    'Alpha Lab · Project 1',
    'Beta',
    'Alpha Lab · Project 3',
  ]);
});

test('projectDisplayLabels avoids collisions with user-chosen ordinal labels', () => {
  const projects = [
    { id: 'p1', name: 'Alpha Lab' },
    { id: 'p2', name: 'Other' },
    { id: 'p3', name: 'Alpha Lab' },
    { id: 'p4', name: 'Alpha Lab · Project 3' },
  ];
  const labels = portfolio.projectDisplayLabels?.(projects) ?? new Map();
  assert.equal(labels.size, projects.length);
  assert.equal(new Set(labels.values()).size, projects.length);
  assert.notEqual(labels.get('p3'), labels.get('p4'));
});
