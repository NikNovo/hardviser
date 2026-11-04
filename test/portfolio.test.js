// Pure model/migration tests for src/portfolio.js. No React, no DOM, no
// localStorage/IndexedDB: every function under test is a plain data
// transform. Run with `node --test test/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blankPortfolio, blankWorkspace, blankProfile,
  isWorkspace, isProfile, isPortfolio, isFileOwnershipValid,
  parsePortfolio, migrateLegacyWorkspace, recoverPortfolioChats,
  createProjectPure, linkServerProjectPure, switchProjectPure, updateProfilePure, applyProjectPatch,
  saveRecordPure, removeRecordPure,
  importLegacyAsNewProject, importPortfolioRestore, remapLibraryFileIds,
  projectSummaries,
} from '../src/portfolio.js';

// ---------------------------------------------------------------------------
// Fresh state
// ---------------------------------------------------------------------------

test('parsePortfolio(undefined) is a genuinely empty, zero-project portfolio', () => {
  const portfolio = parsePortfolio(undefined);
  assert.equal(portfolio.version, 3);
  assert.deepEqual(portfolio.projects, {});
  assert.deepEqual(portfolio.order, []);
  assert.equal(portfolio.activeProjectId, null);
  assert.deepEqual(portfolio.profile, blankProfile());
});

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

function legacyV1Fixture() {
  return {
    version: 1,
    project: { name: 'Old Project', description: '', audience: '', model: '', markets: '', stage: 'Идея', team: '', budget: '', currency: 'USD', constraints: '', productType: 'Механическое изделие', riskFlags: ['Батареи'], goal: '', notes: '' },
    onboarded: true,
    onboardingStep: 7,
    answers: { 'Q-DEM-1': { value: '2', reason: '', evidence: 'rec-1' } },
    records: [
      { id: 'rec-1', type: 'decision', title: 'Pick enclosure material', notes: '', fields: {}, sources: [{ id: 'src-1', type: 'url', url: 'https://example.com', label: 'ref' }], status: 'New', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' },
      { id: 'rec-2', type: 'library', title: 'Datasheet', notes: '', fields: { fileId: 'file-abc', fileName: 'ds.pdf', fileSize: 100, fileMime: 'application/pdf' }, sources: [], status: 'New' },
    ],
    chat: {
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createdAt: '2024-01-01T00:00:00.000Z', status: 'delivered' },
        { id: 'm2', role: 'user', content: 'in flight', createdAt: '2024-01-02T00:00:00.000Z', status: 'pending' },
      ],
      draft: 'unsent draft',
      includeProject: true,
      selectedRecords: ['rec-1'],
    },
  };
}

test('migrating a legacy v1 workspace preserves records, sources, files, answers and chat', () => {
  const portfolio = migrateLegacyWorkspace(legacyV1Fixture());
  assert.equal(portfolio.order.length, 1);
  const id = portfolio.order[0];
  assert.equal(portfolio.activeProjectId, id);
  const ws = portfolio.projects[id].workspace;

  // English enum migration applied (v1 -> v2 value maps).
  assert.equal(ws.project.stage, 'Idea');
  assert.equal(ws.project.productType, 'Mechanical product');
  assert.deepEqual(ws.project.riskFlags, ['Batteries']);
  assert.equal(ws.project.name, 'Old Project');

  // Records, sources and original file id are untouched by migration.
  assert.equal(ws.records.length, 2);
  assert.equal(ws.records[0].sources[0].url, 'https://example.com');
  assert.equal(ws.records[1].fields.fileId, 'file-abc');

  // Readiness answers preserved.
  assert.equal(ws.answers['Q-DEM-1'].value, '2');
  assert.equal(ws.answers['Q-DEM-1'].evidence, 'rec-1');

  // Chat preserved, but the pending message becomes an interrupted error and
  // the draft/selection survive.
  assert.equal(ws.chat.draft, 'unsent draft');
  assert.deepEqual(ws.chat.selectedRecords, ['rec-1']);
  assert.equal(ws.chat.messages[0].status, 'delivered');
  assert.equal(ws.chat.messages[1].status, 'error');
  assert.match(ws.chat.messages[1].error, /interrupted/);
});

test('parsePortfolio dispatches a raw v1/v2 payload through legacy migration', () => {
  const portfolio = parsePortfolio(legacyV1Fixture());
  assert.equal(portfolio.order.length, 1);
  assert.equal(isPortfolio(portfolio), true);
});

test('parsePortfolio throws on an unrecognized payload shape', () => {
  assert.throws(() => parsePortfolio({ nonsense: true }));
});

test('isWorkspace accepts a valid v2 payload and rejects malformed records/chat', () => {
  const valid = { version: 2, project: { name: 'Ok' }, answers: {}, records: [] };
  assert.equal(isWorkspace(valid), true);

  const badRecordType = { ...valid, records: [{ id: 'r1', type: 'not-a-kind', title: 't' }] };
  assert.equal(isWorkspace(badRecordType), false);

  const duplicateRecordIds = { ...valid, records: [{ id: 'r1', type: 'decision', title: 'a' }, { id: 'r1', type: 'decision', title: 'b' }] };
  assert.equal(isWorkspace(duplicateRecordIds), false);

  const badChat = { ...valid, chat: { draft: '', includeProject: true, selectedRecords: [], messages: [{ id: 'm1', role: 'narrator', content: 'x' }] } };
  assert.equal(isWorkspace(badChat), false);

  assert.equal(isWorkspace({ version: 3, project: { name: 'x' }, answers: {}, records: [] }), false, 'version 3 is a portfolio, not a single workspace');
});

test('isWorkspace resolves readiness evidence to a non-empty record id', () => {
  const record = { id: 'rec-1', type: 'decision', title: 'Decision' };
  const valid = { version: 2, project: { name: 'Ok' }, answers: { q1: { value: '1', evidence: 'rec-1' } }, records: [record] };

  assert.equal(isWorkspace(valid), true);
  assert.equal(isWorkspace({ ...valid, records: [{ ...record, id: '   ' }] }), false);
  assert.equal(isWorkspace({ ...valid, answers: { q1: { value: '1', evidence: 'missing' } } }), false);
  assert.equal(isWorkspace({ ...valid, answers: { q1: { value: '1', evidence: '' } } }), true, 'the empty string means no linked evidence');
});

test('isWorkspace rejects dangling and duplicate chat record selections', () => {
  const workspace = {
    ...blankWorkspace(),
    records: [{ id: 'rec-1', type: 'decision', title: 'Decision' }],
    chat: { ...blankChat(), selectedRecords: ['rec-1'] },
  };
  assert.equal(isWorkspace(workspace), true);
  assert.equal(isWorkspace({ ...workspace, chat: { ...workspace.chat, selectedRecords: ['missing'] } }), false);
  assert.equal(isWorkspace({ ...workspace, chat: { ...workspace.chat, selectedRecords: ['rec-1', 'rec-1'] } }), false);
});

test('legacy migration backfills absent chat while imports reject dangling record references', () => {
  const legacyWithoutChat = legacyV1Fixture();
  delete legacyWithoutChat.chat;
  assert.equal(isWorkspace(legacyWithoutChat), true, 'legacy v1/v2 workspaces may omit chat');
  const migrated = migrateLegacyWorkspace(legacyWithoutChat);
  const migratedWorkspace = migrated.projects[migrated.activeProjectId].workspace;
  assert.deepEqual(migratedWorkspace.chat.selectedRecords, []);
  assert.deepEqual(migratedWorkspace.chat.messages, []);

  const badEvidence = legacyV1Fixture();
  badEvidence.answers['Q-DEM-1'].evidence = 'missing';
  assert.throws(() => importLegacyAsNewProject(blankPortfolio(), badEvidence));

  const { portfolio, id } = createProjectPure(blankPortfolio(), 'Current project');
  const entry = portfolio.projects[id];
  const badChatPortfolio = {
    ...portfolio,
    projects: {
      ...portfolio.projects,
      [id]: { ...entry, workspace: { ...entry.workspace, chat: { ...entry.workspace.chat, selectedRecords: ['missing'] } } },
    },
  };
  assert.equal(isPortfolio(badChatPortfolio), false);
  assert.throws(() => importPortfolioRestore(badChatPortfolio));
});

// Persisted library records store fields.fileId/fileName/fileSize/fileMime
// directly (records-schema.js buildRecord); fileMeta is only a transient
// form-layer wrapper around that, never the persisted shape itself.
test('remapLibraryFileIds only replaces fields.fileId on library records that have one', () => {
  const workspace = { ...blankWorkspace(), records: [
    { id: 'r1', type: 'library', title: 'has file', fields: { fileId: 'file-1', fileName: 'a.pdf', fileSize: 10, fileMime: 'application/pdf' } },
    { id: 'r2', type: 'library', title: 'no file yet', fields: {} },
    { id: 'r3', type: 'decision', title: 'not a library record', fields: { fileId: 'should-not-touch' } },
  ] };
  const remapped = remapLibraryFileIds(workspace);
  assert.notEqual(remapped.records[0].fields.fileId, 'file-1');
  assert.equal(remapped.records[0].fields.fileName, 'a.pdf', 'other file metadata is untouched');
  assert.equal(remapped.records[1].fields.fileId, undefined);
  assert.equal(remapped.records[2].fields.fileId, 'should-not-touch');
});

// ---------------------------------------------------------------------------
// Isolation between projects
// ---------------------------------------------------------------------------

test('two projects never share records, answers or chat', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  const alphaId = p1.activeProjectId;
  const { portfolio: p2 } = createProjectPure(p1, 'Beta');
  const betaId = p2.activeProjectId;
  assert.notEqual(alphaId, betaId);

  const afterSave = applyProjectPatch(p2, alphaId, ws => saveRecordPure(ws, { type: 'decision', title: 'Alpha-only record' }).workspace);
  assert.equal(afterSave.projects[alphaId].workspace.records.length, 1);
  assert.equal(afterSave.projects[betaId].workspace.records.length, 0);

  const afterChat = applyProjectPatch(afterSave, betaId, ws => ({ ...ws, chat: { ...ws.chat, draft: 'beta draft' } }));
  assert.equal(afterChat.projects[betaId].workspace.chat.draft, 'beta draft');
  assert.equal(afterChat.projects[alphaId].workspace.chat.draft, '');
});

test('a mutation bound to an old active project cannot reach the newly active project', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Old');
  const oldId = p1.activeProjectId;
  const { portfolio: p2 } = createProjectPure(p1, 'New');
  const newId = p2.activeProjectId;
  assert.equal(p2.activeProjectId, newId);

  // Simulates a render-time-bound async handler that resolves with the
  // originally-captured oldId, after the user has already switched to newId.
  const stale = applyProjectPatch(p2, oldId, ws => ({ ...ws, chat: { ...ws.chat, draft: 'late arrival' } }));

  assert.equal(stale.projects[oldId].workspace.chat.draft, 'late arrival');
  assert.equal(stale.projects[newId].workspace.chat.draft, '');
  assert.equal(stale.activeProjectId, newId, 'switching selection is not reverted by a stale write');
});

test('applyProjectPatch never creates a project and rejects unknown/null ids', () => {
  const p0 = blankPortfolio();
  assert.equal(applyProjectPatch(p0, null, ws => ws), null);
  assert.equal(applyProjectPatch(p0, 'does-not-exist', ws => ws), null);
  assert.deepEqual(Object.keys(p0.projects), []);
});

// ---------------------------------------------------------------------------
// Create / switch failure semantics
// ---------------------------------------------------------------------------

test('createProjectPure rejects empty/whitespace names without creating anything', () => {
  const p0 = blankPortfolio();
  assert.equal(createProjectPure(p0, ''), null);
  assert.equal(createProjectPure(p0, '   '), null);
  assert.equal(createProjectPure(p0, undefined), null);
});

test('createProjectPure creates a genuinely empty project and selects it', () => {
  const p0 = blankPortfolio();
  const { portfolio, id } = createProjectPure(p0, '  New Hardware Co  ');
  const ws = portfolio.projects[id].workspace;
  assert.equal(ws.project.name, 'New Hardware Co');
  assert.deepEqual(ws.records, []);
  assert.deepEqual(ws.answers, {});
  assert.deepEqual(ws.chat.messages, []);
  assert.equal(portfolio.activeProjectId, id);
});

test('createProjectPure stores onboarding details and the AI link through a save/load round trip', () => {
  const { portfolio, id } = createProjectPure(blankPortfolio(), 'Field sensor', {
    description: 'Outdoor monitor',
    stage: 'Prototype',
    goal: 'Seal test',
    model: 'B2B',
    budget: 5000,
    riskFlags: ['Batteries'],
  }, 'server-1');
  const loaded = parsePortfolio(JSON.parse(JSON.stringify(portfolio)));
  const project = loaded.projects[id].workspace.project;
  assert.equal(project.description, 'Outdoor monitor');
  assert.equal(project.stage, 'Prototype');
  assert.equal(project.goal, 'Seal test');
  assert.equal(project.model, '', 'only onboarding brief keys are copied');
  assert.equal(project.budget, '');
  assert.deepEqual(project.riskFlags, []);
  assert.equal(loaded.projects[id].serverProjectId, 'server-1');
  assert.equal(projectSummaries(loaded)[0].serverProjectId, 'server-1');
});

test('linkServerProjectPure links only the named project and rejects unknown ids or empty links', () => {
  const { portfolio: p1, id: alpha } = createProjectPure(blankPortfolio(), 'Alpha');
  const { portfolio: p2, id: beta } = createProjectPure(p1, 'Beta');
  const linked = linkServerProjectPure(p2, alpha, 'server-alpha');
  assert.equal(linked.projects[alpha].serverProjectId, 'server-alpha');
  assert.equal(linked.projects[beta].serverProjectId, undefined);
  assert.equal(linked.activeProjectId, beta, 'linking does not change the active project');
  assert.equal(linkServerProjectPure(p2, 'missing', 'server-x'), null);
  assert.equal(linkServerProjectPure(p2, alpha, ''), null);
  assert.equal(projectSummaries(p2).find(project => project.id === alpha).serverProjectId, null);
});

test('isPortfolio rejects a malformed AI project link', () => {
  const { portfolio, id } = createProjectPure(blankPortfolio(), 'Alpha');
  assert.equal(isPortfolio({ ...portfolio, projects: { [id]: { ...portfolio.projects[id], serverProjectId: 42 } } }), false);
  assert.equal(isPortfolio({ ...portfolio, projects: { [id]: { ...portfolio.projects[id], serverProjectId: ' ' } } }), false);
});

test('switchProjectPure rejects an unknown id and leaves selection unchanged', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  assert.equal(switchProjectPure(p1, 'missing'), null);
});

// ---------------------------------------------------------------------------
// Portfolio-shape validation
// ---------------------------------------------------------------------------

test('isPortfolio rejects a duplicate id in order, mismatched keys, and an invalid activeProjectId', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  const id = p1.activeProjectId;

  assert.equal(isPortfolio({ ...p1, order: [id, id] }), false);
  assert.equal(isPortfolio({ ...p1, order: [id, 'ghost'] }), false);
  assert.equal(isPortfolio({ ...p1, activeProjectId: 'missing-id' }), false);
  assert.equal(isPortfolio(p1), true);
});

test('portfolio restore rejects a missing selection field instead of silently deselecting projects', () => {
  const { portfolio } = createProjectPure(blankPortfolio(), 'Selected project');
  delete portfolio.activeProjectId;
  assert.equal(isPortfolio(portfolio), false);
  assert.throws(() => importPortfolioRestore(portfolio));
});

test('portfolio restore rejects unmigrated version-one child workspaces', () => {
  const { portfolio, id } = createProjectPure(blankPortfolio(), 'Current project');
  portfolio.projects[id].workspace = legacyV1Fixture();
  assert.equal(isPortfolio(portfolio), false);
  assert.throws(() => importPortfolioRestore(portfolio));
  assert.equal(parsePortfolio(legacyV1Fixture()).version, 3, 'standalone legacy import still migrates');
});

test('portfolio restore rejects missing conversation state rather than crashing during recovery', () => {
  const { portfolio, id } = createProjectPure(blankPortfolio(), 'Current project');
  delete portfolio.projects[id].workspace.chat;
  assert.equal(isPortfolio(portfolio), false);
  assert.throws(() => importPortfolioRestore(portfolio));
});

test('isFileOwnershipValid rejects a fileId shared by two different projects', () => {
  const makeEntry = (id, fileId) => ({
    id, createdAt: '', updatedAt: '',
    workspace: { ...blankWorkspace(), records: [{ id: 'r1', type: 'library', title: 'f', fields: { fileId } }] },
  });
  const sharedOk = { a: makeEntry('a', 'file-1') };
  assert.equal(isFileOwnershipValid(sharedOk), true);

  const shared = { a: makeEntry('a', 'file-1'), b: makeEntry('b', 'file-1') };
  assert.equal(isFileOwnershipValid(shared), false);

  const portfolioWithSharedFile = { version: 3, profile: blankProfile(), projects: shared, order: ['a', 'b'], activeProjectId: 'a' };
  assert.equal(isPortfolio(portfolioWithSharedFile), false);
});

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

test('importing a legacy backup mints a fresh project id and fresh library fileIds, never aliasing another project\'s blob', () => {
  const p0 = blankPortfolio();
  const { portfolio: withExisting } = createProjectPure(p0, 'Existing');
  const existingId = withExisting.activeProjectId;
  const withFile = applyProjectPatch(withExisting, existingId, ws => saveRecordPure(ws, { type: 'library', title: 'Existing file', fields: { fileId: 'file-abc' } }).workspace);

  const backup = legacyV1Fixture();
  backup.answers['Q-DEM-1'].evidence = 'rec-9';
  backup.chat.selectedRecords = ['rec-9'];
  backup.records = [{ id: 'rec-9', type: 'library', title: 'Imported file', notes: '', fields: { fileId: 'file-abc' }, sources: [], status: 'New' }];
  const { portfolio: afterImport, id: importedId } = importLegacyAsNewProject(withFile, backup);

  assert.notEqual(importedId, existingId);
  assert.equal(Object.keys(afterImport.projects).length, 2, 'existing project is preserved');
  assert.equal(afterImport.activeProjectId, importedId);

  const importedFileId = afterImport.projects[importedId].workspace.records[0].fields.fileId;
  assert.notEqual(importedFileId, 'file-abc', 'the imported record never aliases the existing project\'s blob id');
  assert.equal(isFileOwnershipValid(afterImport.projects), true);
  assert.equal(isPortfolio(afterImport), true);

  // Record id within the imported project is preserved.
  assert.equal(afterImport.projects[importedId].workspace.records[0].id, 'rec-9');
});

test('importLegacyAsNewProject throws on an invalid payload', () => {
  assert.throws(() => importLegacyAsNewProject(blankPortfolio(), { not: 'a workspace' }));
});

test('importPortfolioRestore performs a full-portfolio replacement after validation and recovers pending chat per project', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  const alphaId = p1.activeProjectId;
  const { portfolio: p2 } = createProjectPure(p1, 'Beta');
  const betaId = p2.activeProjectId;

  const withPending = {
    ...p2,
    projects: {
      ...p2.projects,
      [alphaId]: { ...p2.projects[alphaId], workspace: { ...p2.projects[alphaId].workspace, chat: { ...p2.projects[alphaId].workspace.chat, messages: [{ id: 'm1', role: 'user', content: 'a', status: 'pending' }] } } },
      [betaId]: { ...p2.projects[betaId], workspace: { ...p2.projects[betaId].workspace, chat: { ...p2.projects[betaId].workspace.chat, messages: [{ id: 'm2', role: 'user', content: 'b', status: 'pending' }] } } },
    },
  };

  const restored = importPortfolioRestore(withPending);
  assert.equal(restored.projects[alphaId].workspace.chat.messages[0].status, 'error');
  assert.equal(restored.projects[betaId].workspace.chat.messages[0].status, 'error');
  assert.equal(restored.activeProjectId, p2.activeProjectId);
});

test('importPortfolioRestore throws on invalid duplicate ids or a dangling activeProjectId', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  assert.throws(() => importPortfolioRestore({ ...p1, activeProjectId: 'ghost' }));
});

// ---------------------------------------------------------------------------
// Record / answer / chat mutation helpers
// ---------------------------------------------------------------------------

test('saveRecordPure rejects a record without a title and does not touch the workspace', () => {
  const ws = blankWorkspace();
  const result = saveRecordPure(ws, { type: 'decision', title: '  ' });
  assert.equal(result.workspace, null);
  assert.equal(result.record, null);
});

test('removeRecordPure clears evidence pointers and chat selection referencing the removed record', () => {
  const ws = { ...blankWorkspace(), answers: { q1: { value: '1', evidence: 'rec-1' } }, records: [{ id: 'rec-1', type: 'decision', title: 't' }], chat: { ...blankChat(), selectedRecords: ['rec-1'] } };
  const next = removeRecordPure(ws, 'rec-1');
  assert.equal(next.answers.q1.evidence, '');
  assert.deepEqual(next.records, []);
  assert.deepEqual(next.chat.selectedRecords, []);
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

test('updateProfilePure merges a valid patch and rejects a malformed one', () => {
  const p0 = blankPortfolio();
  const ok = updateProfilePure(p0, { name: 'Ada', role: 'Founder' });
  assert.equal(ok.profile.name, 'Ada');
  assert.equal(ok.profile.organization, '');

  assert.equal(updateProfilePure(p0, { name: 42 }), null);
});

test('isProfile accepts string-only fields and rejects other types', () => {
  assert.equal(isProfile({ name: 'Ada', role: 'Founder', organization: 'Acme' }), true);
  assert.equal(isProfile({}), true, 'all fields are optional');
  assert.equal(isProfile({ name: 42 }), false);
  assert.equal(isProfile(null), false);
});

// ---------------------------------------------------------------------------
// Pending chat recovery across projects on reload
// ---------------------------------------------------------------------------

test('recoverPortfolioChats interrupts pending messages independently per project', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  const alphaId = p1.activeProjectId;
  const { portfolio: p2 } = createProjectPure(p1, 'Beta');
  const betaId = p2.activeProjectId;
  const withPending = applyProjectPatch(p2, alphaId, ws => ({ ...ws, chat: { ...ws.chat, messages: [{ id: 'm1', role: 'user', content: 'a', status: 'pending' }] } }));
  const recovered = recoverPortfolioChats(withPending);
  assert.equal(recovered.projects[alphaId].workspace.chat.messages[0].status, 'error');
  assert.deepEqual(recovered.projects[betaId].workspace.chat.messages, []);
});

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

test('projectSummaries exposes id, name, stage, recordCount and updatedAt in order', () => {
  const p0 = blankPortfolio();
  const { portfolio: p1 } = createProjectPure(p0, 'Alpha');
  const alphaId = p1.activeProjectId;
  const withRecord = applyProjectPatch(p1, alphaId, ws => saveRecordPure(ws, { type: 'decision', title: 'd' }).workspace);
  const summaries = projectSummaries(withRecord);
  assert.equal(summaries.length, 1);
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['id', 'name', 'recordCount', 'serverProjectId', 'stage', 'updatedAt'].sort());
  assert.equal(summaries[0].recordCount, 1);
  assert.equal(summaries[0].name, 'Alpha');
});

function blankChat() {
  return { messages: [], draft: '', includeProject: true, selectedRecords: [] };
}
