import assert from 'node:assert/strict';
import test from 'node:test';
import { blankPortfolio, createProjectPure } from '../src/portfolio.js';
import { loadAccountWorkspace, previousWorkspaceJson, saveAccountWorkspace } from '../src/storage.js';

const A = '20000000-0000-4000-8000-000000000001';
const B = '20000000-0000-4000-8000-000000000002';

function installStorage(t) {
  const values = new Map();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });
  return { values, storage };
}

function workspace(name, projectName) {
  const result = createProjectPure(blankPortfolio(), projectName).portfolio;
  result.profile = { name, role: 'Founder', organization: name + ' organization' };
  return result;
}

// Reverting to a browser-wide key would expose and overwrite the other owner.
test('account switches retain independent profiles and projects', t => {
  installStorage(t);
  saveAccountWorkspace(A, workspace('Alice', 'Alpha device'));
  assert.equal(loadAccountWorkspace(B).profile.name, '');
  assert.deepEqual(loadAccountWorkspace(B).projects, {});
  saveAccountWorkspace(B, workspace('Bob', 'Beta device'));
  const first = loadAccountWorkspace(A);
  const second = loadAccountWorkspace(B);
  assert.equal(first.profile.name, 'Alice');
  assert.equal(first.projects[first.activeProjectId].workspace.project.name, 'Alpha device');
  assert.equal(second.profile.name, 'Bob');
  assert.equal(second.projects[second.activeProjectId].workspace.project.name, 'Beta device');
  second.profile.name = 'Bob updated';
  saveAccountWorkspace(B, second);
  assert.equal(loadAccountWorkspace(A).profile.name, 'Alice');
  assert.equal(loadAccountWorkspace(B).profile.name, 'Bob updated');
});

// An automatic fallback/claim would give unowned legacy data to an arbitrary email.
test('unassigned browser data stays recoverable but never becomes an account workspace', t => {
  const { storage } = installStorage(t);
  const original = JSON.stringify(workspace('Unassigned owner', 'Older prototype'));
  storage.setItem('hardissoft.workspace.v1', original);
  assert.equal(loadAccountWorkspace(A).profile.name, '');
  assert.equal(loadAccountWorkspace(B).activeProjectId, null);
  saveAccountWorkspace(A, workspace('Alice', 'New prototype'));
  assert.equal(previousWorkspaceJson(), original);
  assert.equal(loadAccountWorkspace(B).profile.name, '');
});

// Swallowing a parse error would make a corrupted account look like a new empty one.
test('unreadable data fails closed without damaging another account or the recovery copy', t => {
  const { storage } = installStorage(t);
  const corrupt = '{broken account data';
  storage.setItem(`hardissoft.workspace.account.v1:${A}`, corrupt);
  storage.setItem('hardissoft.workspace.v1', 'preserve these original bytes');
  saveAccountWorkspace(B, workspace('Bob', 'Beta device'));
  assert.throws(() => loadAccountWorkspace(A), SyntaxError);
  assert.equal(storage.getItem(`hardissoft.workspace.account.v1:${A}`), corrupt);
  assert.equal(previousWorkspaceJson(), 'preserve these original bytes');
  assert.equal(loadAccountWorkspace(B).profile.name, 'Bob');
});

test('missing account identity cannot read or write a shared fallback namespace', t => {
  const { values } = installStorage(t);
  for (const account of [null, undefined, '']) {
    assert.throws(() => loadAccountWorkspace(account), /account/i);
    assert.throws(() => saveAccountWorkspace(account, workspace('Anonymous', 'Device')), /account/i);
  }
  assert.equal(values.size, 0);
});
