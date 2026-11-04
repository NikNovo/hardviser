// Pure, framework-free model, validation and migration for the HardIsSoft
// multi-project portfolio (localStorage payload version 3). No localStorage,
// IndexedDB or DOM access here: storage.js owns I/O and store.jsx owns React state.
// Every function here is a plain data transform so it can be unit tested with
// node:test without a browser or React runtime.

import { RECORD_ROUTES } from './nav.js';
import { migrateWorkspace } from './migrations.js';

export const PORTFOLIO_VERSION = 3;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalString = value => value === undefined || typeof value === 'string';
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const nowISO = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Per-project workspace (unchanged v1/v2 shape: project brief, answers,
// records, chat). One portfolio project entry wraps exactly one of these.
// ---------------------------------------------------------------------------

export const blankChat = () => ({ messages: [], draft: '', includeProject: true, selectedRecords: [] });
export const blankProject = () => ({ name: '', description: '', audience: '', model: '', markets: '', stage: 'Idea', team: '', budget: '', currency: 'USD', constraints: '', productType: '', riskFlags: [], goal: '', notes: '' });
export const blankWorkspace = () => ({ version: 2, project: blankProject(), answers: {}, records: [], chat: blankChat() });

export function isRecord(record) {
  if (!isObject(record) || !isNonEmptyString(record.id) || !Object.hasOwn(RECORD_ROUTES, record.type) || typeof record.title !== 'string') return false;
  if (!['notes', 'status', 'createdAt', 'updatedAt'].every(key => optionalString(record[key]))) return false;
  if (record.fields !== undefined && !isObject(record.fields)) return false;
  if (record.sources !== undefined && (!Array.isArray(record.sources) || !record.sources.every(source =>
    isObject(source) && typeof source.id === 'string' && optionalString(source.label) &&
    (source.type === 'url' ? typeof source.url === 'string' && /^https?:\/\//i.test(source.url) : source.type === 'library' && typeof source.recordId === 'string')
  ))) return false;
  const fields = record.fields || {};
  if (record.type === 'work') {
    if (fields.inputs !== undefined && (!isObject(fields.inputs) || !Object.values(fields.inputs).every(value => ['string', 'boolean'].includes(typeof value)))) return false;
    if (fields.attachments !== undefined && (!Array.isArray(fields.attachments) || !fields.attachments.every(id => typeof id === 'string'))) return false;
    if (fields.progressLog !== undefined && (!Array.isArray(fields.progressLog) || !fields.progressLog.every(entry => isObject(entry) && typeof entry.date === 'string' && typeof entry.text === 'string'))) return false;
  }
  return Object.entries(fields).every(([key, value]) =>
    (record.type === 'work' && ['inputs', 'attachments', 'progressLog'].includes(key)) ||
    value === null || ['string', 'number', 'boolean'].includes(typeof value)
  );
}

// Accepts legacy single-project payloads (version 1 or 2): the shape stored
// directly under the old localStorage key, and the shape produced by the old
// (and current) exportProject().
export function isWorkspace(value) {
  if (!isObject(value) || ![1, 2].includes(value.version) || !isObject(value.project) || typeof value.project.name !== 'string') return false;
  if (!Object.keys(blankProject()).every(key => key === 'riskFlags'
    ? value.project[key] === undefined || (Array.isArray(value.project[key]) && value.project[key].every(flag => typeof flag === 'string'))
    : optionalString(value.project[key]))) return false;
  if (value.onboarded !== undefined && typeof value.onboarded !== 'boolean') return false;
  if (value.onboardingStep !== undefined && (!Number.isInteger(value.onboardingStep) || value.onboardingStep < 0 || value.onboardingStep > 7)) return false;
  if (!Array.isArray(value.records) || !value.records.every(isRecord) || new Set(value.records.map(record => record.id)).size !== value.records.length) return false;
  const recordIds = new Set(value.records.map(record => record.id));
  if (value.chat !== undefined) {
    const chat = value.chat;
    if (!isObject(chat) || typeof chat.draft !== 'string' || typeof chat.includeProject !== 'boolean' ||
      !Array.isArray(chat.selectedRecords) || !chat.selectedRecords.every(id => isNonEmptyString(id) && recordIds.has(id)) ||
      new Set(chat.selectedRecords).size !== chat.selectedRecords.length || !Array.isArray(chat.messages)) return false;
    if (!chat.messages.every(message => isObject(message) && typeof message.id === 'string' && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && ['createdAt', 'context', 'error', 'model'].every(key => optionalString(message[key])) && [undefined, 'pending', 'delivered', 'error'].includes(message.status))) return false;
    if (new Set(chat.messages.map(message => message.id)).size !== chat.messages.length) return false;
  }
  if (!isObject(value.answers)) return false;
  return Object.values(value.answers).every(answer =>
    isObject(answer) && ['unknown', 'na', '0', '1', '2', '3', undefined].includes(answer.value) &&
    optionalString(answer.reason) && optionalString(answer.evidence) &&
    (answer.evidence === undefined || answer.evidence === '' || recordIds.has(answer.evidence))
  );
}

// Marks any message left "pending" (an in-flight AI request) as interrupted.
// Pure: takes/returns a messages array, used on every load for every project.
export function recoverPendingMessages(messages) {
  return messages.map(message => message.status === 'pending'
    ? { ...message, status: 'error', error: 'The previous request was interrupted. Your message is saved; no answer was confirmed.' }
    : message);
}

// Applies the existing v1 enum migrations, backfills defaults and recovers
// any pending chat message. Accepts a value already known to pass isWorkspace.
function normalizeWorkspace(value) {
  const migrated = migrateWorkspace(value);
  const chat = { ...blankChat(), ...migrated.chat };
  const normalized = { ...blankWorkspace(), ...migrated, project: { ...blankProject(), ...migrated.project }, chat };
  normalized.chat = { ...normalized.chat, messages: recoverPendingMessages(normalized.chat.messages) };
  return normalized;
}

// Produces a brand-new library fileId for every library record so an
// imported project can never alias another project's IndexedDB blob. Backups
// never include file bytes, so the new id intentionally has no blob yet.
export function remapLibraryFileIds(workspace) {
  const records = workspace.records.map(record => {
    if (record.type !== 'library' || !record.fields || !record.fields.fileId) return record;
    return { ...record, fields: { ...record.fields, fileId: newId() } };
  });
  return { ...workspace, records };
}

// ---------------------------------------------------------------------------
// Profile (local identity, not a login)
// ---------------------------------------------------------------------------

export const blankProfile = () => ({ name: '', role: '', organization: '' });
export function isProfile(value) {
  return isObject(value) && optionalString(value.name) && optionalString(value.role) && optionalString(value.organization);
}
function normalizeProfile(value) {
  const safe = isProfile(value) ? value : {};
  return { ...blankProfile(), ...safe };
}

// ---------------------------------------------------------------------------
// Portfolio (version 3): profile + isolated project entries + selection.
// ---------------------------------------------------------------------------

export function blankPortfolio() {
  return { version: PORTFOLIO_VERSION, profile: blankProfile(), projects: {}, order: [], activeProjectId: null };
}

function isProjectEntry(entry) {
  return isObject(entry) && isNonEmptyString(entry.id) && optionalString(entry.createdAt) && optionalString(entry.updatedAt)
    && (entry.serverProjectId === undefined || isNonEmptyString(entry.serverProjectId))
    && entry.workspace?.version === 2 && isWorkspace(entry.workspace) && entry.workspace.chat !== undefined;
}

// A library record's fields.fileId must belong to exactly one project within
// an account: reusing an id would let deleting a file in one project destroy
// another's. IndexedDB also namespaces blob keys by authenticated account UUID.
export function isFileOwnershipValid(projects) {
  const owner = new Map();
  for (const [projectId, entry] of Object.entries(projects)) {
    for (const record of entry.workspace.records) {
      if (record.type !== 'library' || !record.fields || !record.fields.fileId) continue;
      const fileId = record.fields.fileId;
      if (owner.has(fileId) && owner.get(fileId) !== projectId) return false;
      owner.set(fileId, projectId);
    }
  }
  return true;
}

export function isPortfolio(value) {
  if (!isObject(value) || value.version !== PORTFOLIO_VERSION) return false;
  if (!isProfile(value.profile)) return false;
  if (!isObject(value.projects) || !Array.isArray(value.order)) return false;
  const ids = Object.keys(value.projects);
  if (new Set(value.order).size !== value.order.length) return false;
  if (value.order.length !== ids.length || !value.order.every(id => ids.includes(id))) return false;
  if (!ids.every(id => isProjectEntry(value.projects[id]) && value.projects[id].id === id)) return false;
  if (value.activeProjectId !== null && !ids.includes(value.activeProjectId)) return false;
  if (!isFileOwnershipValid(value.projects)) return false;
  return true;
}

// Normalizes a portfolio already known to pass isPortfolio: fills profile
// defaults and recovers pending chat messages independently in every
// project (a reload must interrupt in-flight requests project by project).
export function recoverPortfolioChats(portfolio) {
  const projects = Object.fromEntries(Object.entries(portfolio.projects).map(([id, entry]) => [id, {
    ...entry,
    workspace: { ...entry.workspace, chat: { ...entry.workspace.chat, messages: recoverPendingMessages(entry.workspace.chat.messages) } },
  }]));
  return { ...portfolio, profile: normalizeProfile(portfolio.profile), activeProjectId: portfolio.activeProjectId ?? null, projects };
}

function wrapWorkspaceAsEntry(workspace) {
  const stamp = nowISO();
  return { id: newId(), createdAt: stamp, updatedAt: stamp, workspace };
}

// Brief fields a new project may start with (onboarding answers or an AI
// project's structured brief). Other project fields keep their defaults.
export const PROJECT_DETAIL_KEYS = ['description', 'audience', 'markets', 'team', 'goal', 'notes', 'stage', 'productType'];

function buildNewProjectEntry(name, details, serverProjectId) {
  const stamp = nowISO();
  const provided = Object.fromEntries(PROJECT_DETAIL_KEYS
    .filter(key => isNonEmptyString(details?.[key]))
    .map(key => [key, details[key]]));
  const entry = { id: newId(), createdAt: stamp, updatedAt: stamp, workspace: { ...blankWorkspace(), project: { ...blankProject(), ...provided, name: name.trim() } } };
  return isNonEmptyString(serverProjectId) ? { ...entry, serverProjectId } : entry;
}

// Wraps a single legacy (v1/v2) workspace as the sole project of a fresh
// portfolio and selects it. Used for first-run migration of the old
// single-project localStorage payload. The project's name (even if blank)
// is preserved exactly as migrated, never renamed.
export function migrateLegacyWorkspace(rawValue) {
  const workspace = normalizeWorkspace(rawValue);
  const entry = wrapWorkspaceAsEntry(workspace);
  return { version: PORTFOLIO_VERSION, profile: blankProfile(), projects: { [entry.id]: entry }, order: [entry.id], activeProjectId: entry.id };
}

// Parses whatever was found under the storage key (already JSON.parsed, or
// undefined when nothing was stored) into a valid, up-to-date portfolio.
// Throws on anything unrecognized; the caller (store.jsx) decides how to
// surface that without overwriting unreadable existing data.
export function parsePortfolio(raw) {
  if (raw === undefined || raw === null) return blankPortfolio();
  if (isPortfolio(raw)) return recoverPortfolioChats(raw);
  if (isWorkspace(raw)) return migrateLegacyWorkspace(raw);
  throw new Error('Unrecognized workspace schema');
}

export function projectSummary(entry) {
  return { id: entry.id, name: entry.workspace.project.name, stage: entry.workspace.project.stage, recordCount: entry.workspace.records.length, updatedAt: entry.updatedAt, serverProjectId: entry.serverProjectId ?? null };
}
export function projectSummaries(portfolio) {
  return portfolio.order.map(id => portfolio.projects[id]).filter(Boolean).map(projectSummary);
}

export function projectDisplayLabels(projects) {
  const names = projects.map(project => project.name.trim() || 'Untitled project');
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  const labels = names.map((name, index) => counts.get(name) > 1 ? `${name} · Project ${index + 1}` : name);
  let collisions;
  // Retry if an accepted project name matches a generated fallback; IDs are unique.
  do {
    const indicesByLabel = new Map();
    labels.forEach((label, index) => {
      const indices = indicesByLabel.get(label) || [];
      indices.push(index);
      indicesByLabel.set(label, indices);
    });
    collisions = [...indicesByLabel.values()].filter(indices => indices.length > 1).flat();
    for (const index of collisions) labels[index] = `${labels[index]} · ${projects[index].id}`;
  } while (collisions.length);
  return new Map(projects.map((project, index) => [project.id, labels[index]]));
}

// Creates a selected project with optional starting brief details and AI
// project link. Returns null on an invalid (empty/whitespace) name so the
// caller never silently creates a project.
export function createProjectPure(portfolio, name, details = {}, serverProjectId = null) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const entry = buildNewProjectEntry(name, details, serverProjectId);
  return {
    portfolio: { ...portfolio, projects: { ...portfolio.projects, [entry.id]: entry }, order: [...portfolio.order, entry.id], activeProjectId: entry.id },
    id: entry.id,
  };
}

// Records which server AI project belongs to `projectId`. Returns null when
// the project does not exist or the link is empty.
export function linkServerProjectPure(portfolio, projectId, serverProjectId) {
  if (!projectId || !Object.hasOwn(portfolio.projects, projectId) || !isNonEmptyString(serverProjectId)) return null;
  return { ...portfolio, projects: { ...portfolio.projects, [projectId]: { ...portfolio.projects[projectId], serverProjectId } } };
}

// Returns null when the id does not exist in this portfolio.
export function switchProjectPure(portfolio, id) {
  if (!Object.hasOwn(portfolio.projects, id)) return null;
  return { ...portfolio, activeProjectId: id };
}

export function updateProfilePure(portfolio, patch) {
  if (!isObject(patch)) return null;
  const merged = { ...portfolio.profile, ...patch };
  if (!isProfile(merged)) return null;
  return { ...portfolio, profile: normalizeProfile(merged) };
}

// Applies `updater` to exactly the project identified by `projectId` (bound
// by the caller at render time), regardless of which project is currently
// active. Returns null if that project no longer exists or `updater`
// rejects the change (e.g. saveRecord with no title) so no project is ever
// created or touched implicitly. This is what keeps a stale async handler
// (captured before switching projects) from ever reaching the now-active
// project: it only ever has the id it closed over.
export function applyProjectPatch(portfolio, projectId, updater) {
  if (!projectId || !Object.hasOwn(portfolio.projects, projectId)) return null;
  const entry = portfolio.projects[projectId];
  const workspace = updater(entry.workspace);
  if (!workspace) return null;
  const nextEntry = { ...entry, workspace, updatedAt: nowISO() };
  return { ...portfolio, projects: { ...portfolio.projects, [projectId]: nextEntry } };
}

export function saveRecordPure(workspace, record) {
  const now = nowISO();
  const old = workspace.records.find(r => r.id === record.id);
  const saved = { notes: '', fields: {}, sources: [], status: 'Draft', ...old, ...record, id: old?.id || record.id || newId(), createdAt: old?.createdAt || now, updatedAt: now };
  if (!saved.type || !saved.title?.trim()) return { workspace: null, record: null };
  const records = old ? workspace.records.map(r => r.id === old.id ? saved : r) : [saved, ...workspace.records];
  return { workspace: { ...workspace, records }, record: saved };
}

export function removeRecordPure(workspace, id) {
  const answers = Object.fromEntries(Object.entries(workspace.answers).map(([key, answer]) =>
    [key, answer.evidence === id ? { ...answer, evidence: '' } : answer]
  ));
  return { ...workspace, answers, records: workspace.records.filter(record => record.id !== id), chat: { ...workspace.chat, selectedRecords: workspace.chat.selectedRecords.filter(recordId => recordId !== id) } };
}

// Imports a legacy (v1/v2) single-project backup as a brand-new project,
// leaving every other project untouched. Mints a fresh project id and fresh
// library fileIds (see remapLibraryFileIds) while preserving record/source
// ids within that new project. Throws if the payload is not a valid
// workspace; the caller is expected to confirm with the user first.
export function importLegacyAsNewProject(portfolio, rawValue) {
  if (!isWorkspace(rawValue)) throw new Error('This is not a valid hardviser.com backup.');
  const workspace = remapLibraryFileIds(normalizeWorkspace(rawValue));
  const entry = wrapWorkspaceAsEntry(workspace);
  return {
    portfolio: { ...portfolio, projects: { ...portfolio.projects, [entry.id]: entry }, order: [...portfolio.order, entry.id], activeProjectId: entry.id },
    id: entry.id,
  };
}

// Whole-workspace restore (v3): replaces the entire portfolio after full
// validation (unique/consistent ids, valid activeProjectId, no project
// sharing a library fileId with another). Throws on anything invalid; the
// caller is expected to confirm this destructive replacement first.
export function importPortfolioRestore(rawValue) {
  if (!isPortfolio(rawValue)) throw new Error('This is not a valid hardviser.com portfolio backup.');
  return recoverPortfolioChats(rawValue);
}
