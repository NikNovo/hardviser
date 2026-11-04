import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDetailsFromServerProject, unlinkedServerProjects } from '../src/onboarding.js';

test('continuing an AI project copies its structured brief into matching local brief fields', () => {
  assert.deepEqual(projectDetailsFromServerProject({
    name: 'Field sensor',
    brief_text: 'Rendered brief',
    brief_fields: { description: 'Outdoor monitor', goal: 'Seal test', notes: '  ', unknown: 'ignored', team: 7 },
  }), { description: 'Outdoor monitor', goal: 'Seal test' });
});

test('an AI project with only a legacy text brief keeps that text as notes', () => {
  assert.deepEqual(projectDetailsFromServerProject({ name: 'Legacy', brief_text: 'Old brief', brief_fields: {} }), { notes: 'Old brief' });
  assert.deepEqual(projectDetailsFromServerProject({ name: 'Empty', brief_text: '' }), {});
});

test('only AI projects without a local project link are offered to continue', () => {
  const local = [{ id: 'l1', serverProjectId: 's1' }, { id: 'l2', serverProjectId: null }];
  const server = [{ id: 's1', name: 'Linked' }, { id: 's2', name: 'Free' }];
  assert.deepEqual(unlinkedServerProjects(local, server).map(project => project.id), ['s2']);
});
