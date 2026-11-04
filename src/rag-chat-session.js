import {
  RagChatApiError,
  attachFile as apiAttachFile,
  createChat as apiCreateChat,
  createProject as apiCreateProject,
  createTodo as apiCreateTodo,
  deleteChat as apiDeleteChat,
  deleteFile as apiDeleteFile,
  deleteTodo as apiDeleteTodo,
  consumeEmailLogin,
  getRagChatMe,
  getRagChatToken,
  listChats,
  listFiles,
  listMessages,
  listProjects,
  listTodos as apiListTodos,
  logoutRagChat,
  openAskStream,
  reportRagChatClientError,
  requestAdminOperation,
  saveProjectBrief as apiSaveProjectBrief,
  setRagChatToken,
  startFileUpload,
  updateAccountProfile,
  updateChat as apiUpdateChat,
  updateProject as apiUpdateProject,
  updateTodo as apiUpdateTodo,
  uploadFileChunk,
} from './rag-chat-api.js';
import { identityPatch, isAccountIdentity, isLoginResult } from './account-identity.js';
import { consumeRagStream, RagChatStreamError } from './rag-chat-stream.js';
import {
  findPendingAnswer,
  MAX_PENDING_ANSWER_AGE_MS,
  MAX_UPLOAD_FILE_BYTES,
  splitUploadChunks,
} from './rag-chat-helpers.js';

const ASK_TIMEOUT_MS = 65_000;
const PENDING_POLL_MS = 3_000;
const MAX_MENTIONS = 10;
const MAX_PINNED_FILES = 20;
const CLIENT_ERROR_CODES = new Set(['network_error', 'stream_interrupted', 'invalid_stream', 'timeout']);
const CLIENT_ERROR_STAGES = new Set([
  'sending', 'accepted', 'classifying', 'classified', 'project_context', 'reading_files', 'searching', 'answering',
]);

const PROJECT_SELECTION_KEY = 'hardissoft.ragchat.project';
const CHAT_SELECTION_KEY = 'hardissoft.ragchat.chat';

function readSelection(key) {
  try {
    return globalThis.sessionStorage?.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeSelection(key, value) {
  try {
    if (value) globalThis.sessionStorage?.setItem(key, value);
    else globalThis.sessionStorage?.removeItem(key);
  } catch {}
}

let activeRequest = null;
let loginRequest = null;
let initialization = null;
let authEpoch = 0;
let projectSelection = 0;
let chatSelection = 0;
const pendingPolls = new Map();
const activeUploads = new Set();
const todoRevisions = new Map();
const listeners = new Set();

let state = {
  initialized: false,
  authChecking: false,
  authenticated: false,
  userId: null,
  roles: [],
  displayName: null,
  loginName: '',
  error: '',
  projects: [],
  selectedProjectId: readSelection(PROJECT_SELECTION_KEY),
  chats: [],
  selectedChatId: readSelection(CHAT_SELECTION_KEY),
  files: [],
  messagesByChat: {},
  progressByChat: {},
  pendingChats: {},
  requestErrors: {},
  requestErrorIds: {},
  uploads: [],
  draft: '',
  technicalQuestion: false,
  mentions: [],
  activeAskChatId: null,
  todosByProject: {},
  todoLoadingByProject: {},
  todoErrorsByProject: {},
};

function updateSession(patchOrFn) {
  const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try { listener(state); } catch {}
  }
}

export function getRagChatSession() {
  return state;
}

export function subscribeRagChatSession(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clearServerSessionData() {
  return {
    projects: [],
    chats: [],
    files: [],
    todosByProject: {},
    todoLoadingByProject: {},
    todoErrorsByProject: {},
    messagesByChat: {},
    progressByChat: {},
    pendingChats: {},
    requestErrors: {},
    requestErrorIds: {},
    uploads: [],
    draft: '',
    technicalQuestion: false,
    mentions: [],
    activeAskChatId: null,
  };
}

function setError(error) {
  if (error instanceof RagChatApiError && error.status === 401) {
    invalidateBackgroundWork();
    writeSelection(PROJECT_SELECTION_KEY, null);
    writeSelection(CHAT_SELECTION_KEY, null);
    updateSession({
      ...clearServerSessionData(),
      initialized: true,
      authChecking: false,
      authenticated: false,
      userId: null,
      loginName: '',
      roles: [],
      displayName: null,
      error: '',
      selectedProjectId: null,
      selectedChatId: null,
    });
    return;
  }
  updateSession({ error: error instanceof Error ? error.message : 'The chat service could not complete this request.' });
}

function checkedIdentityPatch(user) {
  if (!isAccountIdentity(user) && !isLoginResult(user)) {
    throw new RagChatApiError('invalid_response', 'The chat service returned an invalid account identity.');
  }
  return identityPatch(user);
}

function accountChangedError() {
  const error = new Error('The signed-in account changed during this request.');
  error.name = 'AbortError';
  return error;
}

function isStaleAccountRequest(epoch, token) {
  return epoch !== authEpoch || token !== getRagChatToken();
}

function handleAccountRequestError(error, epoch, token) {
  if (epoch !== authEpoch) throw accountChangedError();
  const currentToken = getRagChatToken();
  const currentUnauthorized = error instanceof RagChatApiError
    && error.status === 401
    && !currentToken;
  if (currentToken !== token && !currentUnauthorized) throw accountChangedError();
  if (error instanceof RagChatApiError && error.status === 401) setError(error);
  throw error;
}

function invalidateBackgroundWork() {
  authEpoch += 1;
  projectSelection += 1;
  chatSelection += 1;
  if (activeRequest) {
    activeRequest.controller.abort();
    activeRequest = null;
  }
  if (loginRequest) {
    loginRequest.abort();
    loginRequest = null;
  }
  for (const controller of activeUploads) controller.abort();
  activeUploads.clear();
  for (const timer of pendingPolls.values()) clearTimeout(timer);
  pendingPolls.clear();
  todoRevisions.clear();
  initialization = null;
  updateSession(session => ({
    activeAskChatId: null,
    todoLoadingByProject: Object.fromEntries(
      Object.keys(session.todoLoadingByProject).map(projectId => [projectId, false]),
    ),
    uploads: session.uploads.map(upload => (
      upload.status === 'complete' || upload.status === 'error'
        ? upload
        : { ...upload, status: 'error', error: 'Upload cancelled because the session changed.' }
    )),
  }));
}

function setPendingChat(chatId, pending) {
  updateSession(session => {
    const pendingChats = { ...session.pendingChats };
    if (pending) pendingChats[chatId] = true;
    else delete pendingChats[chatId];
    return { pendingChats };
  });
}

function mergeMessages(chatId, serverMessages) {
  updateSession(session => {
    const previous = session.messagesByChat[chatId] || [];
    const serverRequests = new Set(serverMessages.map(message => message.request_id).filter(Boolean));
    const localPending = previous.filter(message => message.localPending && !serverRequests.has(message.request_id));
    const merged = [...serverMessages, ...localPending].sort((left, right) => {
      const a = Date.parse(left.created_at) || 0;
      const b = Date.parse(right.created_at) || 0;
      return a - b;
    });
    const errorRequestId = session.requestErrorIds[chatId];
    const hasMatchingReply = errorRequestId && serverMessages.some(message =>
      message.role === 'assistant' && message.request_id === errorRequestId);
    const requestErrors = hasMatchingReply
      ? { ...session.requestErrors, [chatId]: '' }
      : session.requestErrors;
    return {
      messagesByChat: { ...session.messagesByChat, [chatId]: merged },
      requestErrors,
      requestErrorIds: hasMatchingReply
        ? { ...session.requestErrorIds, [chatId]: null }
        : session.requestErrorIds,
    };
  });
  schedulePendingPoll(chatId);
}


function schedulePendingPoll(chatId) {
  const epoch = authEpoch;
  const pendingMessage = findPendingAnswer(state.messagesByChat[chatId]);
  if (!pendingMessage) {
    const timer = pendingPolls.get(chatId);
    clearTimeout(timer);
    pendingPolls.delete(chatId);
    setPendingChat(chatId, false);
    return;
  }
  setPendingChat(chatId, true);
  if (pendingPolls.has(chatId)) return;
  const age = Date.now() - Date.parse(pendingMessage.created_at);
  const remaining = MAX_PENDING_ANSWER_AGE_MS - age;
  if (remaining <= 0) {
    if (pendingMessage.localPending) {
      updateSession(session => ({
        messagesByChat: {
          ...session.messagesByChat,
          [chatId]: (session.messagesByChat[chatId] || []).filter(message => message !== pendingMessage),
        },
      }));
    }
    updateSession(session => ({
      requestErrors: {
        ...session.requestErrors,
        [chatId]: session.requestErrors[chatId] || 'No answer arrived within 90 seconds. You can send another question.',
      },
      requestErrorIds: {
        ...session.requestErrorIds,
        [chatId]: session.requestErrorIds[chatId] || pendingMessage.request_id,
      },
    }));
    setPendingChat(chatId, false);
    return;
  }

  const timer = setTimeout(async () => {
    pendingPolls.delete(chatId);
    if (epoch !== authEpoch) return;
    if (!getRagChatToken()) {
      setPendingChat(chatId, false);
      return;
    }
    try {
      const messages = await listMessages(chatId);
      if (epoch !== authEpoch) return;
      if (Array.isArray(messages)) mergeMessages(chatId, messages);
      else schedulePendingPoll(chatId);
    } catch (error) {
      if (epoch !== authEpoch) return;
      if (error.status === 401) {
        setError(error);
        setPendingChat(chatId, false);
      } else {
        schedulePendingPoll(chatId);
      }
    }
  }, Math.min(PENDING_POLL_MS, remaining));
  pendingPolls.set(chatId, timer);
}

function resumePendingPolls() {
  for (const chatId of Object.keys(state.pendingChats)) {
    if (findPendingAnswer(state.messagesByChat[chatId])) schedulePendingPoll(chatId);
    else setPendingChat(chatId, false);
  }
  for (const chatId of Object.keys(state.messagesByChat)) {
    if (!state.pendingChats[chatId] && findPendingAnswer(state.messagesByChat[chatId])) {
      schedulePendingPoll(chatId);
    }
  }
}


export function clearSessionError() {
  updateSession({ error: '' });
}

export function setSessionDraft(draft) {
  updateSession({ draft });
}

export function setSessionTechnicalQuestion(technicalQuestion) {
  updateSession({ technicalQuestion });
}

export function addSessionMention(file) {
  if (!file || file.status !== 'ready') return false;
  if (state.mentions.some(mention => mention.id === file.id)) return true;
  if (state.mentions.length >= MAX_MENTIONS) {
    updateSession({ error: `You can mention up to ${MAX_MENTIONS} files in one question.` });
    return false;
  }
  updateSession(session => ({ mentions: [...session.mentions, { id: file.id, name: file.name }] }));
  return true;
}

export function removeSessionMention(fileId) {
  updateSession(session => ({ mentions: session.mentions.filter(mention => mention.id !== fileId) }));
}

export async function initializeRagChatSession() {
  if (initialization) return initialization;
  if (state.initialized) return;
  const token = getRagChatToken();
  if (!token) {
    writeSelection(PROJECT_SELECTION_KEY, null);
    writeSelection(CHAT_SELECTION_KEY, null);
    updateSession({
      initialized: true,
      authChecking: false,
      authenticated: false,
      userId: null,
      loginName: '',
      roles: [],
      displayName: null,
      error: '',
      selectedProjectId: null,
      selectedChatId: null,
    });
    return;
  }
  const epoch = ++authEpoch;
  updateSession({ authChecking: true, error: '' });
  const pending = (async () => {
    try {
      const user = await getRagChatMe();
      if (isStaleAccountRequest(epoch, token)) return;
      updateSession({ ...checkedIdentityPatch(user), authenticated: true, error: '' });
      try {
        await loadProjectsAndSelect(epoch);
      } catch (error) {
        if (epoch === authEpoch) setError(error);
      }
    } catch (error) {
      const currentUnauthorized = error instanceof RagChatApiError
        && error.status === 401
        && !getRagChatToken();
      if (epoch === authEpoch && (token === getRagChatToken() || currentUnauthorized)) setError(error);
    } finally {
      if (epoch === authEpoch && token === getRagChatToken()) {
        updateSession({ authChecking: false, initialized: true });
      }
      if (initialization === pending) initialization = null;
    }
  })();
  initialization = pending;
  return pending;
}
async function loadProjectsAndSelect(epoch) {
  const projects = await listProjects();
  if (epoch !== authEpoch) return;
  const projectList = Array.isArray(projects) ? projects : [];
  updateSession({ projects: projectList });
  const projectId = state.selectedProjectId && projectList.some(project => project.id === state.selectedProjectId)
    ? state.selectedProjectId
    : projectList[0]?.id || null;
  if (projectId) await selectSessionProject(projectId);
  else {
    writeSelection(PROJECT_SELECTION_KEY, null);
    writeSelection(CHAT_SELECTION_KEY, null);
    updateSession({ selectedProjectId: null, selectedChatId: null, chats: [], files: [] });
  }
}



export async function refreshSessionAccount(signal) {
  const epoch = authEpoch;
  const token = getRagChatToken();
  try {
    const user = await getRagChatMe(signal);
    if (isStaleAccountRequest(epoch, token)) throw accountChangedError();
    const accountIdentity = checkedIdentityPatch(user);
    updateSession({
      ...accountIdentity,
      initialized: true,
      authChecking: false,
      authenticated: true,
      error: '',
    });
    return user;
  } catch (error) {
    return handleAccountRequestError(error, epoch, token);
  }
}

export async function saveSessionDisplayName(displayName, signal) {
  const epoch = authEpoch;
  const token = getRagChatToken();
  try {
    const user = await updateAccountProfile(displayName, signal);
    if (isStaleAccountRequest(epoch, token)) throw accountChangedError();
    const accountIdentity = checkedIdentityPatch(user);
    updateSession({
      ...accountIdentity,
      initialized: true,
      authChecking: false,
      authenticated: true,
      error: '',
    });
    return user;
  } catch (error) {
    return handleAccountRequestError(error, epoch, token);
  }
}

export async function runAdminOperation(op, args = {}, signal) {
  const epoch = authEpoch;
  const token = getRagChatToken();
  try {
    const result = await requestAdminOperation(op, args, signal);
    if (isStaleAccountRequest(epoch, token)) throw accountChangedError();
    return result;
  } catch (error) {
    return handleAccountRequestError(error, epoch, token);
  }
}
function isSameSessionAccount(user) {
  if (!state.authenticated) return false;
  if (state.userId != null && user.id != null) return String(state.userId) === String(user.id);
  if (state.userId != null || user.id != null) return false;
  return state.loginName === user.login;
}

export async function consumeSessionEmailLogin(token) {
  if (loginRequest) return false;
  const controller = new AbortController();
  loginRequest = controller;
  const epoch = authEpoch;
  try {
    const user = await consumeEmailLogin(token, controller.signal);
    if (epoch !== authEpoch || controller.signal.aborted) return false;
    const accountIdentity = checkedIdentityPatch(user);
    const sameAccount = isSameSessionAccount(user);
    const retainedMentions = sameAccount ? state.mentions : null;
    setRagChatToken(user.token);
    invalidateBackgroundWork();
    const sessionEpoch = authEpoch;
    if (!sameAccount) {
      writeSelection(PROJECT_SELECTION_KEY, null);
      writeSelection(CHAT_SELECTION_KEY, null);
      updateSession({
        ...clearServerSessionData(),
        ...accountIdentity,
        initialized: true,
        authChecking: false,
        authenticated: true,
        error: '',
        selectedProjectId: null,
        selectedChatId: null,
      });
    } else {
      updateSession({
        ...accountIdentity,
        initialized: true,
        authChecking: false,
        authenticated: true,
        error: '',
      });
    }
    try {
      await loadProjectsAndSelect(sessionEpoch);
    } catch (error) {
      if (sessionEpoch === authEpoch) setError(error);
    }
    if (sameAccount && sessionEpoch === authEpoch
      && getRagChatToken() === user.token && state.authenticated) {
      updateSession({ mentions: retainedMentions });
      resumePendingPolls();
    }
    return true;
  } catch (error) {
    if (epoch !== authEpoch || controller.signal.aborted) return false;
    throw error;
  } finally {
    if (loginRequest === controller) loginRequest = null;
  }
}

export function signOutSession() {
  invalidateBackgroundWork();
  writeSelection(PROJECT_SELECTION_KEY, null);
  writeSelection(CHAT_SELECTION_KEY, null);
  void logoutRagChat().catch(() => {});
  updateSession({
    ...clearServerSessionData(),
    initialized: true,
    authChecking: false,
    authenticated: false,
    userId: null,
    loginName: '',
    roles: [],
    displayName: null,
    error: '',
    selectedProjectId: null,
    selectedChatId: null,
  });
}

export async function selectSessionProject(projectId) {
  const preferredChatId = state.selectedProjectId === projectId ? state.selectedChatId : null;
  const preserveCurrentProject = Boolean(projectId) && state.selectedProjectId === projectId;
  const selection = ++projectSelection;
  chatSelection += 1;
  writeSelection(PROJECT_SELECTION_KEY, projectId);
  if (preserveCurrentProject) {
    updateSession({ error: '' });
  } else {
    writeSelection(CHAT_SELECTION_KEY, null);
    updateSession({ selectedProjectId: projectId || null, selectedChatId: null, chats: [], files: [], mentions: [], error: '' });
  }
  if (!projectId) return;
  void refreshSessionTodos(projectId);
  try {
    const [chats, files] = await Promise.all([listChats(projectId), listFiles(projectId)]);
    if (selection !== projectSelection || state.selectedProjectId !== projectId) return;
    const chatList = Array.isArray(chats) ? chats : [];
    updateSession({ chats: chatList, files: Array.isArray(files) ? files : [] });
    const chatId = chatList.find(chat => chat.id === preferredChatId)?.id || chatList[0]?.id || null;
    if (chatId) await selectSessionChat(chatId);
    else {
      writeSelection(CHAT_SELECTION_KEY, null);
      updateSession({ selectedChatId: null, mentions: [], error: '' });
    }
  } catch (error) {
    if (selection === projectSelection) setError(error);
  }
}

export async function selectSessionChat(chatId) {
  const selection = ++chatSelection;
  writeSelection(CHAT_SELECTION_KEY, chatId);
  updateSession({ selectedChatId: chatId || null, mentions: [], error: '' });
  if (!chatId) return;
  try {
    const messages = await listMessages(chatId);
    if (selection !== chatSelection || state.selectedChatId !== chatId) return;
    mergeMessages(chatId, Array.isArray(messages) ? messages : []);
  } catch (error) {
    if (selection === chatSelection) setError(error);
  }
}
export async function refreshSessionProjects() {
  const epoch = authEpoch;
  try {
    const projects = await listProjects();
    if (epoch !== authEpoch) return null;
    updateSession({ projects: Array.isArray(projects) ? projects : [] });
    return projects;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function refreshSessionMessages(chatId = state.selectedChatId) {
  if (!chatId || !getRagChatToken()) return null;
  const epoch = authEpoch;
  try {
    const messages = await listMessages(chatId);
    if (epoch !== authEpoch) return null;
    if (Array.isArray(messages)) mergeMessages(chatId, messages);
    return messages;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function refreshSessionFiles(projectId = state.selectedProjectId) {
  if (!projectId || !getRagChatToken()) return null;
  const epoch = authEpoch;
  try {
    const files = await listFiles(projectId);
    if (epoch !== authEpoch) return null;
    if (projectId === state.selectedProjectId && Array.isArray(files)) updateSession({ files });
    return files;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function createSessionProject(name, briefText = '') {
  const normalizedName = name.trim();
  if (!normalizedName) return null;
  const epoch = authEpoch;
  try {
    const project = await apiCreateProject(normalizedName, briefText);
    if (epoch !== authEpoch) return null;
    await refreshSessionProjects();
    if (epoch !== authEpoch) return null;
    const projectId = project?.id || state.projects.find(item => item.name === normalizedName)?.id;
    if (projectId) {
      await selectSessionProject(projectId);
      if (epoch !== authEpoch) return null;
    }
    return project;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function updateSessionProject(projectId, changes) {
  const epoch = authEpoch;
  try {
    const project = await apiUpdateProject(projectId, changes);
    if (epoch !== authEpoch) return null;
    await refreshSessionProjects();
    if (epoch !== authEpoch) return null;
    return project;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}


export async function createSessionChat() {
  const projectId = state.selectedProjectId;
  if (!projectId) return null;
  const epoch = authEpoch;
  try {
    const existingIds = new Set(state.chats.map(chat => chat.id));
    const chat = await apiCreateChat(projectId);
    if (epoch !== authEpoch) return null;
    if (state.selectedProjectId !== projectId) return chat;
    const chats = await listChats(projectId);
    if (epoch !== authEpoch) return null;
    if (state.selectedProjectId !== projectId) return chat;
    const chatList = Array.isArray(chats) ? chats : [];
    updateSession({ chats: chatList });
    const chatId = chat?.id || chatList.find(item => !existingIds.has(item.id))?.id;
    if (chatId) {
      await selectSessionChat(chatId);
      if (epoch !== authEpoch) return null;
    }
    return chat;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function renameSessionChat(chatId, title) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) return null;
  const epoch = authEpoch;
  try {
    const chat = await apiUpdateChat(chatId, { title: normalizedTitle });
    if (epoch !== authEpoch) return null;
    updateSession(session => ({ chats: session.chats.map(item => item.id === chatId ? { ...item, ...chat, title: normalizedTitle } : item) }));
    return chat;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return null;
  }
}

export async function deleteSessionChat(chatId) {
  const projectId = state.selectedProjectId;
  const epoch = authEpoch;
  try {
    await apiDeleteChat(chatId);
    if (epoch !== authEpoch) return false;
    if (state.selectedProjectId !== projectId) return true;
    const chats = state.chats.filter(chat => chat.id !== chatId);
    if (state.selectedChatId === chatId) {
      writeSelection(CHAT_SELECTION_KEY, null);
      updateSession({ chats, selectedChatId: null });
      if (chats.length) {
        await selectSessionChat(chats[0].id);
        if (epoch !== authEpoch) return false;
      }
    } else {
      updateSession({ chats });
    }
    return true;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return false;
  }
}

export async function toggleSessionFilePin(chatId, fileId) {
  const chat = state.chats.find(item => item.id === chatId);
  if (!chat) return false;
  const epoch = authEpoch;
  const pinned = Array.isArray(chat.pinned) ? chat.pinned : [];
  const next = pinned.includes(fileId) ? pinned.filter(id => id !== fileId) : [...pinned, fileId];
  if (next.length > MAX_PINNED_FILES) {
    updateSession({ error: `Pin up to ${MAX_PINNED_FILES} files to one chat.` });
    return false;
  }
  try {
    const updated = await apiUpdateChat(chatId, { pinned: next });
    if (epoch !== authEpoch) return false;
    updateSession(session => ({ chats: session.chats.map(item => item.id === chatId ? { ...item, ...updated, pinned: next } : item) }));
    return true;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return false;
  }
}

export async function deleteSessionFile(fileId) {
  const projectId = state.selectedProjectId;
  if (!projectId) return false;
  const epoch = authEpoch;
  try {
    await apiDeleteFile(fileId);
    if (epoch !== authEpoch) return false;
    updateSession(session => ({ mentions: session.mentions.filter(mention => mention.id !== fileId) }));
    const [files, chats] = await Promise.all([listFiles(projectId), listChats(projectId)]);
    if (epoch !== authEpoch) return false;
    if (projectId === state.selectedProjectId) {
      updateSession({
        files: Array.isArray(files) ? files : [],
        chats: Array.isArray(chats) ? chats : [],
      });
    }
    return true;
  } catch (error) {
    if (epoch === authEpoch) setError(error);
    return false;
  }
}

function updateUpload(uploadId, changes) {
  updateSession(session => ({
    uploads: session.uploads.map(upload => upload.id === uploadId ? { ...upload, ...changes } : upload),
  }));
}

function awaitUploadStep(start, signal) {
  if (signal.aborted) return Promise.resolve({ cancelled: true });
  return new Promise((resolve, reject) => {
    const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      removeAbortListener();
      resolve({ cancelled: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let operation;
    try {
      operation = start();
    } catch (error) {
      removeAbortListener();
      reject(error);
      return;
    }
    Promise.resolve(operation).then(value => {
      removeAbortListener();
      resolve({ cancelled: false, value });
    }, error => {
      removeAbortListener();
      reject(error);
    });
  });
}

export async function uploadSessionFile(file, mime) {
  const projectId = state.selectedProjectId;
  if (!projectId) return null;
  const epoch = authEpoch;
  if (!Number.isInteger(file?.size) || file.size > MAX_UPLOAD_FILE_BYTES) {
    updateSession({ error: 'Each file must be 10 MiB or smaller.' });
    return null;
  }
  const uploadMime = typeof mime === 'string' && mime.length <= 100 ? mime : '';

  const uploadId = crypto.randomUUID();
  const controller = new AbortController();
  activeUploads.add(controller);
  updateSession(session => ({ uploads: [...session.uploads, { id: uploadId, projectId, name: file.name, loaded: 0, total: file.size, error: '' }] }));
  try {
    const fileRead = await awaitUploadStep(() => file.arrayBuffer(), controller.signal);
    if (epoch !== authEpoch || fileRead.cancelled) return null;
    const bytes = new Uint8Array(fileRead.value);
    const digestResult = await awaitUploadStep(() => crypto.subtle.digest('SHA-256', bytes), controller.signal);
    if (epoch !== authEpoch || digestResult.cancelled) return null;
    const sha256 = Array.from(new Uint8Array(digestResult.value), byte => byte.toString(16).padStart(2, '0')).join('');
    const uploadResult = await awaitUploadStep(
      () => startFileUpload(projectId, file.name, uploadMime, bytes.byteLength, sha256),
      controller.signal,
    );
    if (epoch !== authEpoch || uploadResult.cancelled) return null;
    const upload = uploadResult.value;
    if (!upload || typeof upload.upload_id !== 'string' || !upload.upload_id
      || !Number.isInteger(upload.chunk_bytes) || upload.chunk_bytes <= 0) {
      throw new Error('The service returned an invalid upload session.');
    }
    const chunks = splitUploadChunks(bytes, upload.chunk_bytes);
    updateUpload(uploadId, { status: 'uploading' });
    let loaded = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkResult = await awaitUploadStep(
        () => uploadFileChunk(upload.upload_id, index, chunks[index]),
        controller.signal,
      );
      if (epoch !== authEpoch || chunkResult.cancelled) return null;
      loaded += chunks[index].byteLength;
      updateUpload(uploadId, { loaded });
    }
    updateUpload(uploadId, { status: 'finishing', loaded: bytes.byteLength });
    const finishResult = await awaitUploadStep(() => finishFileUpload(upload.upload_id), controller.signal);
    if (epoch !== authEpoch || finishResult.cancelled) return null;
    const result = finishResult.value;
    const filesResult = await awaitUploadStep(() => listFiles(projectId), controller.signal);
    if (epoch !== authEpoch || filesResult.cancelled) return null;
    const files = filesResult.value;
    if (projectId === state.selectedProjectId && Array.isArray(files)) updateSession({ files });
    updateUpload(uploadId, { status: 'complete', loaded: bytes.byteLength, fileId: result?.id || null });
    setTimeout(() => {
      updateSession(session => ({ uploads: session.uploads.filter(item => item.id !== uploadId) }));
    }, 5_000);
    return result;
  } catch (error) {
    if (epoch !== authEpoch || controller.signal.aborted) return null;
    if (error.status === 401) setError(error);
    updateUpload(uploadId, { status: 'error', error: error.message || 'The file could not be uploaded.' });
    return null;
  } finally {
    activeUploads.delete(controller);
  }
}

function reportClientError(request, code) {
  if (!request.requestId || !CLIENT_ERROR_CODES.has(code) || !CLIENT_ERROR_STAGES.has(request.stage) || request.reportSent) return;
  request.reportSent = true;
  reportRagChatClientError(request.requestId, code, request.stage);
}

function discardLocalPendingQuestion(chatId, requestId) {
  const timer = pendingPolls.get(chatId);
  clearTimeout(timer);
  pendingPolls.delete(chatId);
  updateSession(session => ({
    messagesByChat: {
      ...session.messagesByChat,
      [chatId]: (session.messagesByChat[chatId] || []).filter(message => message.request_id !== requestId || !message.localPending),
    },
  }));
  setPendingChat(chatId, false);
}

async function requestAnswer(question, chatId, mentions, routeMode) {
  if (!state.authenticated || !chatId || activeRequest) return;
  const draftBeforeSend = state.draft;
  const mentionsBeforeSend = state.mentions;
  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const request = { requestId, chatId, controller, stage: 'sending', responseReceived: false, reportSent: false };
  activeRequest = request;
  const localMessage = {
    id: requestId,
    role: 'user',
    content: question,
    mentions: mentions.map(mention => mention.id),
    route: null,
    status: 'pending',
    payload: null,
    request_id: requestId,
    created_at: new Date().toISOString(),
    localPending: true,
  };
  updateSession(session => ({
    activeAskChatId: chatId,
    progressByChat: { ...session.progressByChat, [chatId]: [] },
    requestErrors: { ...session.requestErrors, [chatId]: '' },
    requestErrorIds: { ...session.requestErrorIds, [chatId]: null },
    messagesByChat: {
      ...session.messagesByChat,
      [chatId]: [...(session.messagesByChat[chatId] || []), localMessage],
    },
    draft: '',
    mentions: [],
  }));
  schedulePendingPoll(chatId);

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ASK_TIMEOUT_MS);
  try {
    const response = await openAskStream(requestId, chatId, question, localMessage.mentions, routeMode, controller.signal);
    request.responseReceived = true;
    if (activeRequest !== request) return;
    const contentType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/x-ndjson') {
      throw new RagChatStreamError('invalid_stream', 'The chat service returned an invalid answer stream.');
    }
    const answer = await consumeRagStream(response.body, event => {
      if (activeRequest !== request) return;
      request.stage = event.stage;
      updateSession(session => ({
        progressByChat: { ...session.progressByChat, [chatId]: [...(session.progressByChat[chatId] || []), event] },
      }));
    });
    if (answer.requestId !== requestId) throw new RagChatStreamError('invalid_stream', 'The chat service returned an answer for a different request.');
  } catch (error) {
    if (activeRequest !== request) return;
    let code = null;
    let message;
    if (timedOut) {
      code = 'timeout';
      message = 'The connection timed out. The server may still be preparing your answer; checking for it now.';
    } else if (error instanceof RagChatStreamError) {
      code = error.code;
      message = error.message || 'The answer stream ended unexpectedly; checking for a saved answer.';
    } else if (error instanceof TypeError && !request.responseReceived) {
      code = 'network_error';
      message = 'Could not reach the chat service. Checking for an answer that may already be running.';
    } else if (error instanceof RagChatApiError && error.status === 401) {
      setError(error);
      return;
    } else {
      message = error.message || 'Could not send the question. Checking for a saved answer.';
    }
    if (code) reportClientError(request, code);
    const rejected = error instanceof RagChatApiError && error.status > 0 && request.stage === 'sending';
    updateSession(session => {
      const restoreDraft = rejected && session.selectedChatId === chatId
        && !session.draft && session.mentions.length === 0;
      return {
        requestErrors: { ...session.requestErrors, [chatId]: message },
        requestErrorIds: { ...session.requestErrorIds, [chatId]: requestId },
        draft: restoreDraft ? draftBeforeSend : session.draft,
        mentions: restoreDraft ? mentionsBeforeSend : session.mentions,
      };
    });
    if (rejected) {
      discardLocalPendingQuestion(chatId, requestId);
    } else {
      schedulePendingPoll(chatId);
    }
  } finally {
    clearTimeout(timeout);
    if (activeRequest === request) {
      activeRequest = null;
      updateSession({ activeAskChatId: null });
      await refreshSessionMessages(chatId);
    }
  }
}

export function submitSessionQuestion(question, routeMode = state.technicalQuestion ? 'technical' : 'auto') {
  const content = question.trim();
  const chatId = state.selectedChatId;
  if (!state.authenticated || !chatId || !content || activeRequest || state.pendingChats[chatId]) return;
  if (state.mentions.length > MAX_MENTIONS) return;
  void requestAnswer(content, chatId, state.mentions, routeMode);
}

export function askMessageAsTechnical(question) {
  if (typeof question === 'string' && question.trim()) submitSessionQuestion(question, 'technical');
}
function reportTodoError(projectId, error) {
  const message = error instanceof Error ? error.message : 'The task could not be saved.';
  updateSession(session => ({
    todoErrorsByProject: { ...session.todoErrorsByProject, [projectId]: message },
  }));
  if (error instanceof RagChatApiError && error.status === 401) setError(error);
}
function nextTodoRevision(projectId) {
  const revision = (todoRevisions.get(projectId) || 0) + 1;
  todoRevisions.set(projectId, revision);
  return revision;
}


export async function refreshSessionTodos(projectId = state.selectedProjectId) {
  if (!projectId || !getRagChatToken()) return null;
  const epoch = authEpoch;
  const revision = nextTodoRevision(projectId);
  updateSession(session => ({
    todoLoadingByProject: { ...session.todoLoadingByProject, [projectId]: true },
    todoErrorsByProject: { ...session.todoErrorsByProject, [projectId]: '' },
  }));
  try {
    const todos = await apiListTodos(projectId);
    if (epoch !== authEpoch || revision !== todoRevisions.get(projectId)) return null;
    if (!Array.isArray(todos)) throw new Error('The server returned an invalid task list.');
    updateSession(session => ({
      todosByProject: { ...session.todosByProject, [projectId]: todos },
    }));
    return todos;
  } catch (error) {
    if (epoch === authEpoch && revision === todoRevisions.get(projectId)) {
      reportTodoError(projectId, error);
    }
    return null;
  } finally {
    if (epoch === authEpoch && revision === todoRevisions.get(projectId)) {
      updateSession(session => ({
        todoLoadingByProject: { ...session.todoLoadingByProject, [projectId]: false },
      }));
    }
  }
}

export async function createSessionTodo(projectId, text, sourceMessageId = null) {
  if (!projectId) return null;
  const epoch = authEpoch;
  updateSession(session => ({
    todoErrorsByProject: { ...session.todoErrorsByProject, [projectId]: '' },
  }));
  try {
    const todo = await apiCreateTodo(projectId, text, sourceMessageId);
    if (epoch !== authEpoch || !todo) return null;
    nextTodoRevision(projectId);
    updateSession(session => ({
      todoLoadingByProject: { ...session.todoLoadingByProject, [projectId]: false },
      todosByProject: {
        ...session.todosByProject,
        [projectId]: [...(session.todosByProject[projectId] || []).filter(item => item.id !== todo.id), todo],
      },
    }));
    return todo;
  } catch (error) {
    if (epoch !== authEpoch) return null;
    reportTodoError(projectId, error);
    throw error;
  }
}

export async function updateSessionTodo(projectId, todoId, changes) {
  if (!projectId || !todoId) return null;
  const epoch = authEpoch;
  updateSession(session => ({
    todoErrorsByProject: { ...session.todoErrorsByProject, [projectId]: '' },
  }));
  try {
    const todo = await apiUpdateTodo(todoId, changes);
    if (epoch !== authEpoch || !todo) return null;
    nextTodoRevision(projectId);
    updateSession(session => ({
      todoLoadingByProject: { ...session.todoLoadingByProject, [projectId]: false },
      todosByProject: {
        ...session.todosByProject,
        [projectId]: (session.todosByProject[projectId] || []).map(item => item.id === todoId ? { ...item, ...todo } : item),
      },
    }));
    return todo;
  } catch (error) {
    if (epoch !== authEpoch) return null;
    reportTodoError(projectId, error);
    throw error;
  }
}

export async function deleteSessionTodo(projectId, todoId) {
  if (!projectId || !todoId) return false;
  const epoch = authEpoch;
  updateSession(session => ({
    todoErrorsByProject: { ...session.todoErrorsByProject, [projectId]: '' },
  }));
  try {
    await apiDeleteTodo(todoId);
    if (epoch !== authEpoch) return false;
    nextTodoRevision(projectId);
    updateSession(session => ({
      todoLoadingByProject: { ...session.todoLoadingByProject, [projectId]: false },
      todosByProject: {
        ...session.todosByProject,
        [projectId]: (session.todosByProject[projectId] || []).filter(item => item.id !== todoId),
      },
    }));
    return true;
  } catch (error) {
    if (epoch !== authEpoch) return false;
    reportTodoError(projectId, error);
    throw error;
  }
}

export async function saveSessionProjectBrief(projectId, field, text, expectedText, sourceMessageId = null) {
  if (!projectId) return null;
  const epoch = authEpoch;
  try {
    const project = await apiSaveProjectBrief(projectId, field, text, expectedText, sourceMessageId);
    if (epoch !== authEpoch || !project) return null;
    updateSession(session => ({
      projects: session.projects.map(item => item.id === projectId ? { ...item, ...project } : item),
    }));
    return project;
  } catch (error) {
    if (epoch !== authEpoch) return null;
    if (error instanceof RagChatApiError && error.status === 401) setError(error);
    throw error;
  }
}

export async function attachSessionFile(projectId, fileId) {
  if (!projectId || !fileId) return null;
  const epoch = authEpoch;
  try {
    const attached = await apiAttachFile(projectId, fileId);
    if (epoch !== authEpoch) return null;
    const files = await listFiles(projectId);
    if (epoch !== authEpoch) return null;
    const targetFile = Array.isArray(files)
      ? files.find(file => file.id === attached?.id) || attached
      : attached;
    if (state.selectedProjectId === projectId && Array.isArray(files)) updateSession({ files });
    if (state.selectedProjectId === projectId && targetFile?.status === 'ready') addSessionMention(targetFile);
    return targetFile;
  } catch (error) {
    if (epoch !== authEpoch) return null;
    if (error instanceof RagChatApiError && error.status === 401) setError(error);
    throw error;
  }
}
