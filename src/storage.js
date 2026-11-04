import { parsePortfolio } from './portfolio.js';

const PREVIOUS_WORKSPACE_KEY = 'hardissoft.workspace.v1';
function requireAccount(accountId) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('A verified account is required for local storage.');
  return accountId;
}
export function loadAccountWorkspace(accountId) {
  const raw = localStorage.getItem(`hardissoft.workspace.account.v1:${requireAccount(accountId)}`);
  return parsePortfolio(raw === null ? undefined : JSON.parse(raw));
}
export function saveAccountWorkspace(accountId, value) {
  localStorage.setItem(`hardissoft.workspace.account.v1:${requireAccount(accountId)}`, JSON.stringify(value));
}
// Recovery only: never adopt unowned browser data into a signed-in account.
export function previousWorkspaceJson() {
  return localStorage.getItem(PREVIOUS_WORKSPACE_KEY);
}
export function previousWorkspaceFiles() {
  const raw = previousWorkspaceJson();
  if (raw === null) return [];
  const portfolio = parsePortfolio(JSON.parse(raw));
  return Object.values(portfolio.projects).flatMap(entry => entry.workspace.records
    .filter(record => record.type === 'library' && record.fields?.fileId)
    .map(record => ({ fileId: record.fields.fileId, fileName: record.fields.fileName || record.title || 'file' })));
}

const DB_NAME = 'hardissoft-files-v1';
let dbPromise;
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = undefined; reject(req.error); };
  });
  return dbPromise;
}
export async function saveFileBlob(accountId, id, file) {
  const key = [requireAccount(accountId), id];
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(file, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The file could not be saved'));
  });
}
function readFileBlob(key) {
  return database().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('files').objectStore('files').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
export function getFileBlob(accountId, id) {
  return readFileBlob([requireAccount(accountId), id]);
}
export function getPreviousFileBlob(id) {
  if (typeof id !== 'string' || !id) throw new Error('A previous attachment identifier is required.');
  return readFileBlob(id);
}
export async function deleteFileBlob(accountId, id) {
  const key = [requireAccount(accountId), id];
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('The file could not be deleted'));
  });
}
export function downloadBlob(blob, filename = 'hardissoft-export') {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[\\/:*?"<>|]/g, '-');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export function downloadText(text, filename = 'hardissoft-export.md', mime = 'text/markdown;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
