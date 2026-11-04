import { isAccountIdentity, isLoginResult } from './account-identity.js';

const SESSION_STORAGE_KEY = 'hardissoft.ragchat.session';
const APP_ENDPOINT = '/api/app';
const ADMIN_ENDPOINT = '/api/admin';
const ASK_ENDPOINT = '/api/rag-chat';
export class RagChatApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'RagChatApiError';
    this.code = code;
    this.status = status;
  }
}

export function getRagChatToken() {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export function setRagChatToken(token) {
  try {
    if (token) globalThis.sessionStorage?.setItem(SESSION_STORAGE_KEY, token);
    else globalThis.sessionStorage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    if (token) throw new RagChatApiError('session_storage', 'This browser could not store the sign-in session. Allow session storage and try again.');
  }
}

function apiError(payload, status) {
  const code = typeof payload?.code === 'string' ? payload.code : 'request_failed';
  const message = typeof payload?.error === 'string' && payload.error.trim()
    ? payload.error.trim()
    : `The chat service could not complete this request (HTTP ${status}).`;
  return new RagChatApiError(code, message, status);
}
function clearRagChatTokenIfMatches(token) {
  if (token && getRagChatToken() === token) setRagChatToken('');
}

async function responseData(response, clearOnUnauthorized = true, requestToken = '') {
  const payload = await response.json().catch(() => null);
  if (clearOnUnauthorized && response.status === 401) clearRagChatTokenIfMatches(requestToken);
  if (!response.ok) throw apiError(payload, response.status);
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
    throw new RagChatApiError('invalid_response', 'The chat service returned an invalid response.', response.status);
  }
  return payload.data;
}

function requireAccountIdentity(data, message) {
  if (!isAccountIdentity(data)) {
    throw new RagChatApiError('invalid_response', message);
  }
  return data;
}
function isBillingTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function requireBillingSnapshot(data) {
  const valid = data !== null && typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).length === 4
    && Object.hasOwn(data, 'environment') && Object.hasOwn(data, 'plan')
    && Object.hasOwn(data, 'expires_at') && Object.hasOwn(data, 'verified_at')
    && data.environment === 'sandbox'
    && ['free', 'pro', 'ultra_pro', 'max'].includes(data.plan)
    && (data.expires_at === null || isBillingTimestamp(data.expires_at))
    && (data.verified_at === null || isBillingTimestamp(data.verified_at))
    && ((data.plan === 'free' && data.expires_at === null)
      || (data.plan !== 'free' && data.expires_at !== null));
  if (!valid) {
    throw new RagChatApiError('invalid_response', 'The billing service returned an invalid response.');
  }
  return data;
}


async function appRequest(op, args = {}, options = {}) {
  const authenticated = options.authenticated !== false;
  const token = Object.hasOwn(options, 'tokenOverride') ? options.tokenOverride : getRagChatToken();
  const requestToken = authenticated ? token : '';
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(options.admin === true ? ADMIN_ENDPOINT : APP_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...args, op }),
    cache: 'no-store',
    signal: options.signal,
  });

  return responseData(response, options.clearOnUnauthorized !== false, requestToken);
}



export async function requestEmailLogin(email, turnstileToken, returnTo, signal) {
  const data = await appRequest('auth.email.request', {
    email,
    turnstile_token: turnstileToken,
    return_to: returnTo,
  }, { authenticated: false, clearOnUnauthorized: false, signal });
  if (!data || data.ok !== true) {
    throw new RagChatApiError('invalid_response', 'The chat service returned an invalid email sign-in response.');
  }
  return data;
}

export async function prepareEmailLogin(token, signal) {
  const data = await appRequest('auth.email.prepare', { token }, {
    authenticated: false,
    clearOnUnauthorized: false,
    signal,
  });
  if (!data || typeof data.email !== 'string' || typeof data.return_to !== 'string' || !Object.hasOwn(data, 'expires_at')) {
    throw new RagChatApiError('invalid_response', 'The chat service returned an invalid email link response.');
  }
  return data;
}

export async function consumeEmailLogin(token, signal) {
  const data = await appRequest('auth.email.consume', { token }, {
    authenticated: false,
    clearOnUnauthorized: false,
    signal,
  });
  if (!isLoginResult(data)) {
    throw new RagChatApiError('invalid_response', 'The chat service returned an invalid sign-in response.');
  }
  return data;
}

export function logoutRagChat() {
  const token = getRagChatToken();
  setRagChatToken('');
  if (!token) return Promise.resolve();
  return appRequest('logout', {}, { tokenOverride: token, clearOnUnauthorized: false }).then(() => undefined);
}

export async function getRagChatMe(signal) {
  const data = await appRequest('me', {}, { signal });
  return requireAccountIdentity(data, 'The chat service returned an invalid account identity.');
}

export async function updateAccountProfile(displayName, signal) {
  const normalizedName = typeof displayName === 'string' ? displayName.trim() || null : displayName;
  const data = await appRequest('account.profile.update', { display_name: normalizedName }, { signal });
  return requireAccountIdentity(data, 'The chat service returned an invalid account identity.');
}
export async function getBillingStatus(signal) {
  return requireBillingSnapshot(await appRequest('billing.status', {}, { signal }));
}

export async function syncBilling(signal) {
  return requireBillingSnapshot(await appRequest('billing.sync', {}, { signal }));
}


export function requestAdminOperation(op, args = {}, signal) {
  return appRequest(op, args, { admin: true, signal });
}

export function listProjects() {
  return appRequest('projects.list');
}

export function createProject(name, briefText = '') {
  return appRequest('projects.create', { name, brief_text: briefText });
}

export function updateProject(projectId, changes) {
  return appRequest('projects.update', { project_id: projectId, ...changes });
}

export function deleteProject(projectId) {
  return appRequest('projects.delete', { project_id: projectId });
}

export function listChats(projectId) {
  return appRequest('chats.list', { project_id: projectId });
}

export function createChat(projectId, title = 'New chat') {
  return appRequest('chats.create', { project_id: projectId, title });
}

export function updateChat(chatId, changes) {
  return appRequest('chats.update', { chat_id: chatId, ...changes });
}

export function deleteChat(chatId) {
  return appRequest('chats.delete', { chat_id: chatId });
}

export function listMessages(chatId) {
  return appRequest('messages.list', { chat_id: chatId });
}

export function listTodos(projectId) {
  return appRequest('todos.list', { project_id: projectId });
}

export function createTodo(projectId, text, sourceMessageId) {
  return appRequest('todos.create', {
    project_id: projectId,
    text,
    source_message_id: sourceMessageId,
  });
}

export function updateTodo(todoId, changes) {
  return appRequest('todos.update', { todo_id: todoId, ...changes });
}

export function deleteTodo(todoId) {
  return appRequest('todos.delete', { todo_id: todoId });
}

export function saveProjectBrief(projectId, field, text, expectedText, sourceMessageId) {
  return appRequest('projects.brief.save', {
    project_id: projectId,
    field,
    text,
    expected_text: expectedText,
    source_message_id: sourceMessageId,
  });
}

export function browseFiles() {
  return appRequest('files.browse');
}

export function attachFile(projectId, fileId) {
  return appRequest('files.attach', { project_id: projectId, file_id: fileId });
}

export function listFiles(projectId) {
  return appRequest('files.list', { project_id: projectId });
}

export function deleteFile(fileId) {
  return appRequest('files.delete', { file_id: fileId });
}

export function startFileUpload(projectId, name, mime, sizeBytes, sha256) {
  return appRequest('files.upload.start', {
    project_id: projectId,
    name,
    mime,
    size_bytes: sizeBytes,
    sha256,
  });
}

function bytesToBase64(bytes) {
  let binary = '';
  const stride = 32 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.byteLength)));
  }
  return globalThis.btoa(binary);
}
export function uploadFileChunk(uploadId, index, bytes) {
  return appRequest('files.upload.chunk', {
    upload_id: uploadId,
    index,
    data_b64: bytesToBase64(bytes),
  });
}

export function finishFileUpload(uploadId) {
  return appRequest('files.upload.finish', { upload_id: uploadId });
}


export async function openAskStream(requestId, chatId, question, mentions, routeMode, signal) {
  const token = getRagChatToken();
  const response = await fetch(ASK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ request_id: requestId, chat_id: chatId, question, mentions, route_mode: routeMode }),
    cache: 'no-store',
    signal,
  });
  if (response.status === 401) clearRagChatTokenIfMatches(token);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw apiError(payload, response.status);
  }
  return response;
}

export function reportRagChatClientError(requestId, code, stage) {
  const token = getRagChatToken();
  if (!token) return;
  void fetch(ASK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ event: 'client_error', request_id: requestId, code, stage }),
    cache: 'no-store',
  }).catch(() => {});
}
