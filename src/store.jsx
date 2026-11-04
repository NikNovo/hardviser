import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { downloadBlob, downloadText, getPreviousFileBlob, loadAccountWorkspace, previousWorkspaceFiles, previousWorkspaceJson, saveAccountWorkspace } from './storage.js';
import { getRagChatSession } from './rag-chat-session.js';
import {
  blankWorkspace, isPortfolio, isWorkspace, parsePortfolio,
  createProjectPure, linkServerProjectPure, switchProjectPure, updateProfilePure, applyProjectPatch,
  saveRecordPure, removeRecordPure,
  importLegacyAsNewProject, importPortfolioRestore,
  projectSummaries,
} from './portfolio.js';

const Context = createContext(null);
const NO_PROJECT_MESSAGE = 'Select or create a project to continue.';

function initial(accountId) {
  let hasPreviousWorkspace = false;
  try {
    hasPreviousWorkspace = previousWorkspaceJson() !== null;
    return { value: loadAccountWorkspace(accountId), issue: '', hasPreviousWorkspace };
  } catch {
    return { value: parsePortfolio(undefined), hasPreviousWorkspace, issue: 'The saved workspace could not be read. Existing data has not been overwritten. Check browser permissions or import a backup.' };
  }
}

export function WorkspaceProvider({ accountId, children }) {
  const boot = useRef(null);
  if (!boot.current) boot.current = initial(accountId);
  const [portfolio, setPortfolio] = useState(boot.current.value);
  const current = useRef(portfolio);
  const [toast, setToast] = useState('');
  const [storageError, setStorageError] = useState(boot.current.issue);
  const [chatRecoveries, setChatRecoveries] = useState({});
  const timer = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  function isCurrentAccount() {
    const session = getRagChatSession();
    return mounted.current && session.authenticated && session.userId === accountId;
  }
  function notify(message) {
    if (!isCurrentAccount()) return;
    clearTimeout(timer.current); setToast(message); timer.current = setTimeout(() => setToast(''), 5500);
  }
  function commit(next, allowRecovery = false) {
    if (!next || !isCurrentAccount()) return false;
    if (boot.current.issue && !allowRecovery) { notify('Saving is paused to protect unreadable data. Restore the workspace from a backup.'); return false; }
    try {
      saveAccountWorkspace(accountId, next);
      current.current = next; setPortfolio(next); setStorageError(''); boot.current.issue = ''; return true;
    } catch {
      setStorageError('Your browser could not save the change. Free up space or allow local storage.');
      notify('Not saved: local storage is unavailable or full.'); return false;
    }
  }

  // Async callbacks retain their originating project, even after selection changes.
  const projectId = portfolio.activeProjectId;
  const activeEntry = projectId ? portfolio.projects[projectId] : null;
  const activeWorkspace = activeEntry ? activeEntry.workspace : blankWorkspace();
  function setChatRecovery(result) {
    if (!projectId || !isCurrentAccount()) return;
    setChatRecoveries(previous => {
      if (result && current.current.projects[projectId]) return { ...previous, [projectId]: result };
      if (!Object.hasOwn(previous, projectId)) return previous;
      const next = { ...previous };
      delete next[projectId];
      return next;
    });
  }

  function mutate(updater) {
    if (!projectId) { notify(NO_PROJECT_MESSAGE); return false; }
    const next = applyProjectPatch(current.current, projectId, updater);
    if (!next) { notify(NO_PROJECT_MESSAGE); return false; }
    return commit(next);
  }
  const updateProject = patch => mutate(ws => ({ ...ws, project: { ...ws.project, ...patch } }));
  const updateAnswers = patch => mutate(ws => ({ ...ws, answers: { ...ws.answers, ...patch } }));
  const updateChat = patchOrFn => mutate(ws => ({ ...ws, chat: { ...ws.chat, ...(typeof patchOrFn === 'function' ? patchOrFn(ws.chat) : patchOrFn) } }));
  function saveRecord(record) {
    if (!projectId) { notify(NO_PROJECT_MESSAGE); return null; }
    const entry = current.current.projects[projectId];
    if (!entry) { notify(NO_PROJECT_MESSAGE); return null; }
    const { workspace, record: saved } = saveRecordPure(entry.workspace, record);
    if (!workspace) { notify('Enter a record title.'); return null; }
    return commit(applyProjectPatch(current.current, projectId, () => workspace)) ? saved : null;
  }
  function removeRecord(id) { return mutate(ws => removeRecordPure(ws, id)); }
  const go = path => { window.location.hash = path; };
  function exportProject() {
    if (!isCurrentAccount()) return;
    if (!activeEntry) { notify('Select a project to export.'); return; }
    downloadText(JSON.stringify(activeEntry.workspace, null, 2), 'hardviser-project-backup.json', 'application/json');
    notify('Backup downloaded. Download original files separately from the library.');
  }
  function exportWorkspace() {
    if (!isCurrentAccount()) return;
    downloadText(JSON.stringify(current.current, null, 2), 'hardviser-workspace-backup.json', 'application/json');
    notify('Full workspace backup downloaded (profile and every project). Files are not included; download originals from each project\u2019s library.');
  }
  function exportPreviousWorkspace() {
    if (!isCurrentAccount()) return;
    try {
      const raw = previousWorkspaceJson();
      if (raw === null) { notify('No previous browser workspace was found.'); return; }
      downloadText(raw, 'hardviser-previous-browser-workspace.json', 'application/json');
    } catch { notify('The previous browser workspace could not be read. No data was changed.'); }
  }
  function listPreviousFiles() {
    if (!isCurrentAccount()) return [];
    try { return previousWorkspaceFiles(); }
    catch { notify('Previous file references could not be read. Export the original JSON for recovery.'); return []; }
  }
  async function exportPreviousFile(file) {
    if (!isCurrentAccount()) return;
    try {
      const blob = await getPreviousFileBlob(file.fileId);
      if (!isCurrentAccount()) return;
      if (!blob) { notify('The previous attachment is no longer in this browser.'); return; }
      downloadBlob(blob, file.fileName);
    } catch { notify('The previous attachment could not be read. No data was changed.'); }
  }
  async function importProject(file) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('The backup exceeds 10 MB.');
      if (!isCurrentAccount()) return false;
      const text = await file.text();
      if (!isCurrentAccount()) return false;
      const value = JSON.parse(text);
      if (isPortfolio(value)) {
        if (!window.confirm('Replace the local profile and every project for the current account in this browser? Other accounts are not changed. Export what you need first. Continue?')) return false;
        if (!commit(importPortfolioRestore(value), true)) return false;
        setChatRecoveries({});
        notify('Workspace restored from backup. Files are not included in JSON backups; check each project\u2019s library.');
        return true;
      }
      if (isWorkspace(value)) {
        if (!window.confirm('Import will add this backup as a new project. Existing projects are not changed. Continue?')) return false;
        const { portfolio: next } = importLegacyAsNewProject(current.current, value);
        if (!commit(next)) return false;
        notify('Project imported as a new project. Files are not included in JSON backups; check the library.');
        return true;
      }
      throw new Error('This is not a valid hardviser.com backup.');
    } catch (e) { notify(e instanceof SyntaxError ? 'The backup contains invalid JSON.' : e.message || 'The file could not be read.'); return false; }
  }
  function updateProfile(patch) {
    const next = updateProfilePure(current.current, patch);
    if (!next) { notify('Could not save profile.'); return false; }
    return commit(next);
  }
  function createProject(name, details = {}, serverProjectId = null) {
    const result = createProjectPure(current.current, name, details, serverProjectId);
    if (!result) { notify('Enter a project name.'); return null; }
    return commit(result.portfolio) ? result.id : null;
  }
  function linkServerProject(id, serverProjectId) {
    return commit(linkServerProjectPure(current.current, id, serverProjectId));
  }
  function switchProject(id) {
    const next = switchProjectPure(current.current, id);
    if (!next) { notify('That project could not be found.'); return false; }
    return commit(next);
  }
  const value = {
    accountId, isCurrentAccount,
    hasPreviousWorkspace: Boolean(boot.current.hasPreviousWorkspace), exportPreviousWorkspace, listPreviousFiles, exportPreviousFile,
    state: activeWorkspace, project: activeWorkspace.project, records: activeWorkspace.records, chat: activeWorkspace.chat,
    updateProject, updateAnswers, updateChat, saveRecord, removeRecord, notify, go, exportProject, importProject,
    profile: portfolio.profile, projects: projectSummaries(portfolio), activeProjectId: portfolio.activeProjectId,
    linkedServerProjectId: activeEntry?.serverProjectId ?? null,
    updateProfile, createProject, linkServerProject, switchProject, exportWorkspace,
    chatRecovery: chatRecoveries[projectId] || null, setChatRecovery, storageError,
  };
  return <Context.Provider value={value}>{children}{toast && <div className="toast" role="status">{toast}</div>}</Context.Provider>;
}
export function useWorkspace() { return useContext(Context); }
