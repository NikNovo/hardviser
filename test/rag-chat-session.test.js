import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addSessionMention,
  consumeSessionEmailLogin,
  createSessionTodo,
  deleteSessionTodo,
  getRagChatSession,
  refreshSessionAccount,
  refreshSessionMessages,
  refreshSessionProjects,
  refreshSessionTodos,
  runAdminOperation,
  saveSessionDisplayName,
  setSessionDraft,
  signOutSession,
  submitSessionQuestion,
  subscribeRagChatSession,
  uploadSessionFile,
  updateSessionTodo,
} from '../src/rag-chat-session.js';
import { listProjects, openAskStream } from '../src/rag-chat-api.js';

const TOKEN_KEY = 'hardissoft.ragchat.session';
const CHAT_USER_ID = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_A_ID = '00000000-0000-4000-8000-000000000002';
const ACCOUNT_B_ID = '00000000-0000-4000-8000-000000000003';
const ADMIN_ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';
const PROFILE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000005';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, code) {
  return new Response(JSON.stringify({ code, error: 'The request was rejected.' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function replaceGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
}

function installApiEnvironment(fetchImpl, token = 'account-a') {
  const storage = makeStorage();
  storage.setItem(TOKEN_KEY, token);
  const restoreStorage = replaceGlobal('sessionStorage', storage);
  const restoreFetch = replaceGlobal('fetch', fetchImpl);
  return {
    storage,
    restore() {
      restoreFetch();
      restoreStorage();
    },
  };
}

const previousConversation = [
  { id: 'old-question', role: 'user', content: 'Earlier question', request_id: 'old-request', created_at: '2020-01-01T00:00:00Z' },
  { id: 'old-answer', role: 'assistant', content: 'Earlier answer', request_id: 'old-request', created_at: '2020-01-01T00:00:01Z' },
];
const draftFile = { id: 'draft-file', name: 'enclosure.pdf', status: 'ready' };

function installChatEnvironment(onAsk) {
  let messages = previousConversation;
  const environment = installApiEnvironment(async (url, options) => {
    const request = JSON.parse(options.body);
    if (url === '/api/rag-chat') {
      if (request.event === 'client_error') return jsonResponse(200, { ok: true });
      return onAsk(request);
    }
    switch (request.op) {
      case 'auth.email.consume': return jsonResponse(200, {
        id: CHAT_USER_ID,
        login: 'founder@example.test',
        display_name: null,
        roles: [],
        token: 'chat-account',
        expires_at: '2030-01-01T00:00:00Z',
      });
      case 'projects.list': return jsonResponse(200, [{ id: 'chat-project', name: 'Prototype' }]);
      case 'chats.list': return jsonResponse(200, [{ id: 'active-chat', project_id: 'chat-project' }]);
      case 'files.list': return jsonResponse(200, [draftFile]);
      case 'messages.list': return jsonResponse(200, messages);
      case 'logout': return jsonResponse(200, null);
      default: throw new Error(`Unexpected API operation: ${request.op}`);
    }
  });
  return { ...environment, setMessages(next) { messages = next; } };
}

async function signInToChat() {
  assert.equal(await consumeSessionEmailLogin('test-link'), true);
  assert.equal(getRagChatSession().selectedChatId, 'active-chat');
}

function nextAskCompletion() {
  const finished = deferred();
  const unsubscribe = subscribeRagChatSession(() => {
    if (getRagChatSession().activeAskChatId === null) {
      unsubscribe();
      finished.resolve();
    }
  });
  return finished.promise;
}
const SAME_ACCOUNT_OLD_TOKEN = 'same-account-old';
const SAME_ACCOUNT_NEW_TOKEN = 'same-account-new';
const SAME_ACCOUNT_PROJECT = { id: 'same-account-project', name: 'Assembly workspace' };
const SAME_ACCOUNT_CHAT = { id: 'same-account-chat', project_id: SAME_ACCOUNT_PROJECT.id, title: 'Assembly notes' };

function sameAccountIdentity(token) {
  return {
    id: ACCOUNT_A_ID,
    login: 'admin@example.test',
    display_name: 'Account A',
    roles: ['admin'],
    token,
    expires_at: '2030-01-01T00:00:00Z',
  };
}

function installTimerQueue() {
  const timers = [];
  const restoreSetTimeout = replaceGlobal('setTimeout', (callback, delay, ...args) => {
    const timer = { callback, delay, args, cancelled: false };
    timers.push(timer);
    return timer;
  });
  const restoreClearTimeout = replaceGlobal('clearTimeout', timer => {
    if (timer) timer.cancelled = true;
  });
  return {
    runNext(delay) {
      const timer = timers.find(item => !item.cancelled && item.delay === delay);
      assert.ok(timer, `expected a pending timer after ${delay}ms`);
      timer.cancelled = true;
      return timer.callback(...timer.args);
    },
    restore() {
      restoreClearTimeout();
      restoreSetTimeout();
    },
  };
}

test('same-account replacement fences project 401 and stale project/todo results', async () => {
  const oldProjects401 = deferred();
  const oldProjectSuccess = deferred();
  const oldTodos = deferred();
  let deferOldProject401 = false;
  let deferOldProjectSuccess = false;
  let deferOldTodos = false;
  const environment = installApiEnvironment(async (_url, options) => {
    const request = JSON.parse(options.body);
    const authorization = options.headers.Authorization;
    if (request.op === 'auth.email.consume') {
      const token = request.token === 'replacement-link' ? SAME_ACCOUNT_NEW_TOKEN : SAME_ACCOUNT_OLD_TOKEN;
      return jsonResponse(200, sameAccountIdentity(token));
    }
    if (request.op === 'projects.list'
      && authorization === `Bearer ${SAME_ACCOUNT_OLD_TOKEN}` && deferOldProject401) {
      deferOldProject401 = false;
      return oldProjects401.promise;
    }
    if (request.op === 'projects.list'
      && authorization === `Bearer ${SAME_ACCOUNT_OLD_TOKEN}` && deferOldProjectSuccess) {
      deferOldProjectSuccess = false;
      return oldProjectSuccess.promise;
    }
    if (request.op === 'todos.list'
      && authorization === `Bearer ${SAME_ACCOUNT_OLD_TOKEN}` && deferOldTodos) {
      deferOldTodos = false;
      return oldTodos.promise;
    }
    if (request.op === 'projects.list') return jsonResponse(200, [SAME_ACCOUNT_PROJECT]);
    if (request.op === 'chats.list') return jsonResponse(200, [SAME_ACCOUNT_CHAT]);
    if (request.op === 'files.list') return jsonResponse(200, [draftFile]);
    if (request.op === 'messages.list') return jsonResponse(200, previousConversation);
    if (request.op === 'todos.list') {
      if (request.project_id === 'unselected-project') {
        return jsonResponse(200, [{ id: 'cached-unselected-todo', text: 'Retained task', completed: true }]);
      }
      return jsonResponse(200, [{ id: 'current-todo', text: 'Confirm hinge fit', completed: true }]);
    }
    if (request.op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${request.op}`);
  }, SAME_ACCOUNT_OLD_TOKEN);

  try {
    assert.equal(await consumeSessionEmailLogin('old-link'), true);
    setSessionDraft('unsent hardware note');
    assert.equal(addSessionMention(draftFile), true);
    await refreshSessionTodos('unselected-project');

    deferOldProject401 = true;
    deferOldProjectSuccess = true;
    deferOldTodos = true;
    const oldProject401Refresh = refreshSessionProjects();
    const oldProjectSuccessRefresh = refreshSessionProjects();
    const oldTodoRefresh = refreshSessionTodos('unselected-project');
    assert.equal(getRagChatSession().todoLoadingByProject['unselected-project'], true);
    const pendingUploadBytes = deferred();
    const pendingUpload = uploadSessionFile({
      name: 'pending.pdf',
      size: 4,
      arrayBuffer: () => pendingUploadBytes.promise,
    }, 'application/pdf');

    assert.equal(await consumeSessionEmailLogin('replacement-link'), true);
    assert.equal(environment.storage.getItem(TOKEN_KEY), SAME_ACCOUNT_NEW_TOKEN);
    assert.deepEqual({
      authenticated: getRagChatSession().authenticated,
      userId: getRagChatSession().userId,
      projects: getRagChatSession().projects,
      selectedProjectId: getRagChatSession().selectedProjectId,
      selectedChatId: getRagChatSession().selectedChatId,
      mentions: getRagChatSession().mentions,
      draft: getRagChatSession().draft,
      todoLoading: getRagChatSession().todoLoadingByProject['unselected-project'],
      todos: getRagChatSession().todosByProject['unselected-project'],
      uploadStatus: getRagChatSession().uploads.find(item => item.name === 'pending.pdf')?.status,
      uploadError: getRagChatSession().uploads.find(item => item.name === 'pending.pdf')?.error,
    }, {
      authenticated: true,
      userId: ACCOUNT_A_ID,
      projects: [SAME_ACCOUNT_PROJECT],
      selectedProjectId: SAME_ACCOUNT_PROJECT.id,
      selectedChatId: SAME_ACCOUNT_CHAT.id,
      mentions: [{ id: draftFile.id, name: draftFile.name }],
      draft: 'unsent hardware note',
      todoLoading: false,
      todos: [{ id: 'cached-unselected-todo', text: 'Retained task', completed: true }],
      uploadStatus: 'error',
      uploadError: 'Upload cancelled because the session changed.',
    });
    const cancelledUpload = await pendingUpload;
    pendingUploadBytes.resolve(new ArrayBuffer(4));
    await Promise.resolve();
    assert.equal(cancelledUpload, null);

    oldTodos.resolve(jsonResponse(200, [{ id: 'stale-todo', text: 'Old task', completed: false }]));
    oldProjectSuccess.resolve(jsonResponse(200, [{ id: 'stale-project', name: 'Previous workspace' }]));
    oldProjects401.resolve(errorResponse(401, 'unauthorized'));
    await Promise.all([oldTodoRefresh, oldProjectSuccessRefresh, oldProject401Refresh]);
    assert.equal(environment.storage.getItem(TOKEN_KEY), SAME_ACCOUNT_NEW_TOKEN);
    assert.equal(getRagChatSession().authenticated, true);
    assert.equal(getRagChatSession().error, '');
    assert.deepEqual(getRagChatSession().projects, [SAME_ACCOUNT_PROJECT]);
    assert.deepEqual(getRagChatSession().todosByProject['unselected-project'], [
      { id: 'cached-unselected-todo', text: 'Retained task', completed: true },
    ]);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('same-account replacement fences stale messages and resumes pending answer polling', async () => {
  const oldMessages = deferred();
  const oldAsk = deferred();
  const timers = installTimerQueue();
  let deferOldMessages = false;
  let replacementMessageLists = 0;
  let askCount = 0;
  let askRequestId = null;
  const environment = installApiEnvironment(async (url, options) => {
    const request = JSON.parse(options.body);
    const authorization = options.headers.Authorization;
    if (url === '/api/rag-chat') {
      askCount += 1;
      askRequestId = request.request_id;
      return oldAsk.promise;
    }
    if (request.op === 'auth.email.consume') {
      const token = request.token === 'replacement-link' ? SAME_ACCOUNT_NEW_TOKEN : SAME_ACCOUNT_OLD_TOKEN;
      return jsonResponse(200, sameAccountIdentity(token));
    }
    if (request.op === 'projects.list') return jsonResponse(200, [SAME_ACCOUNT_PROJECT]);
    if (request.op === 'chats.list') return jsonResponse(200, [SAME_ACCOUNT_CHAT]);
    if (request.op === 'files.list') return jsonResponse(200, [draftFile]);
    if (request.op === 'messages.list'
      && authorization === `Bearer ${SAME_ACCOUNT_OLD_TOKEN}` && deferOldMessages) {
      deferOldMessages = false;
      return oldMessages.promise;
    }
    if (request.op === 'messages.list' && authorization === `Bearer ${SAME_ACCOUNT_NEW_TOKEN}`) {
      replacementMessageLists += 1;
      if (replacementMessageLists > 1 && askRequestId) {
        return jsonResponse(200, [
          ...previousConversation,
          {
            id: askRequestId,
            role: 'user',
            content: 'What changed?',
            request_id: askRequestId,
            created_at: new Date().toISOString(),
          },
          {
            id: 'replacement-answer',
            role: 'assistant',
            content: 'The replacement session found the answer.',
            request_id: askRequestId,
            created_at: new Date().toISOString(),
          },
        ]);
      }
      return jsonResponse(200, previousConversation);
    }
    if (request.op === 'todos.list') return jsonResponse(200, []);
    if (request.op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${request.op}`);
  }, SAME_ACCOUNT_OLD_TOKEN);

  try {
    assert.equal(await consumeSessionEmailLogin('old-link'), true);
    deferOldMessages = true;
    const oldMessageRefresh = refreshSessionMessages(SAME_ACCOUNT_CHAT.id);
    submitSessionQuestion('What changed?');
    setSessionDraft('unsent hardware note');
    assert.equal(addSessionMention(draftFile), true);
    assert.equal(getRagChatSession().activeAskChatId, SAME_ACCOUNT_CHAT.id);
    assert.equal(Boolean(getRagChatSession().pendingChats[SAME_ACCOUNT_CHAT.id]), true);

    assert.equal(await consumeSessionEmailLogin('replacement-link'), true);
    assert.equal(getRagChatSession().activeAskChatId, null);
    assert.equal(Boolean(getRagChatSession().pendingChats[SAME_ACCOUNT_CHAT.id]), true);
    assert.equal(getRagChatSession().draft, 'unsent hardware note');
    assert.deepEqual(getRagChatSession().mentions, [{ id: draftFile.id, name: draftFile.name }]);
    assert.equal(getRagChatSession().selectedProjectId, SAME_ACCOUNT_PROJECT.id);
    assert.equal(getRagChatSession().selectedChatId, SAME_ACCOUNT_CHAT.id);

    await timers.runNext(3_000);
    assert.equal(Boolean(getRagChatSession().pendingChats[SAME_ACCOUNT_CHAT.id]), false);
    assert.equal(getRagChatSession().messagesByChat[SAME_ACCOUNT_CHAT.id].at(-1).content,
      'The replacement session found the answer.');
    assert.equal(askCount, 1);

    oldMessages.resolve(jsonResponse(200, [
      { id: 'stale-message', role: 'assistant', content: 'Stale response', request_id: 'stale-request', created_at: '2025-01-01T00:00:00Z' },
    ]));
    oldAsk.resolve(errorResponse(401, 'unauthorized'));
    await oldMessageRefresh;
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(environment.storage.getItem(TOKEN_KEY), SAME_ACCOUNT_NEW_TOKEN);
    assert.equal(getRagChatSession().authenticated, true);
    assert.equal(getRagChatSession().messagesByChat[SAME_ACCOUNT_CHAT.id].at(-1).content,
      'The replacement session found the answer.');
    assert.equal(askCount, 1);
  } finally {
    signOutSession();
    environment.restore();
    timers.restore();
  }
});

test('a current-token admin 401 still clears the authenticated identity after replacement', async () => {
  const environment = installApiEnvironment(async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'auth.email.consume') {
      return jsonResponse(200, sameAccountIdentity(
        request.token === 'replacement-link' ? SAME_ACCOUNT_NEW_TOKEN : SAME_ACCOUNT_OLD_TOKEN,
      ));
    }
    if (request.op === 'projects.list') return jsonResponse(200, [SAME_ACCOUNT_PROJECT]);
    if (request.op === 'chats.list') return jsonResponse(200, [SAME_ACCOUNT_CHAT]);
    if (request.op === 'files.list') return jsonResponse(200, [draftFile]);
    if (request.op === 'messages.list') return jsonResponse(200, previousConversation);
    if (request.op === 'todos.list') return jsonResponse(200, []);
    if (url === '/api/admin') return errorResponse(401, 'unauthorized');
    if (request.op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${request.op}`);
  }, SAME_ACCOUNT_OLD_TOKEN);

  try {
    assert.equal(await consumeSessionEmailLogin('old-link'), true);
    assert.equal(await consumeSessionEmailLogin('replacement-link'), true);
    await assert.rejects(runAdminOperation('admin.users.list'), error => error.status === 401);
    assert.equal(environment.storage.getItem(TOKEN_KEY), null);
    assert.equal(getRagChatSession().authenticated, false);
    assert.equal(getRagChatSession().userId, null);
  } finally {
    signOutSession();
    environment.restore();
  }
});


test('project refresh from an earlier auth session cannot replace the current project list', async () => {
  const oldProjects = deferred();
  const environment = installApiEnvironment(async (_url, options) => {
    const { op } = JSON.parse(options.body);
    if (op === 'projects.list' && options.headers.Authorization === 'Bearer account-a') return oldProjects.promise;
    if (op === 'projects.list') return jsonResponse(200, [{ id: 'current-project' }]);
    if (op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${op}`);
  });

  try {
    const oldRefresh = refreshSessionProjects();
    signOutSession();
    environment.storage.setItem(TOKEN_KEY, 'account-b');

    assert.deepEqual(await refreshSessionProjects(), [{ id: 'current-project' }]);
    oldProjects.resolve(jsonResponse(200, [{ id: 'previous-project' }]));
    await oldRefresh;
    assert.deepEqual(getRagChatSession().projects, [{ id: 'current-project' }]);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('task create, update, and delete invalidate older in-flight task lists', async () => {
  const pendingLists = new Map();
  const initialTodos = {
    'create-project': [{ id: 'create-base', text: 'Existing task', completed: false }],
    'update-project': [{ id: 'update-item', text: 'Original task', completed: false }],
    'delete-project': [{ id: 'delete-item', text: 'Remove this task', completed: false }],
  };
  const environment = installApiEnvironment(async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'todos.list') {
      const pending = pendingLists.get(request.project_id);
      if (pending) {
        pendingLists.delete(request.project_id);
        return pending.promise;
      }
      return jsonResponse(200, initialTodos[request.project_id] || []);
    }
    if (request.op === 'todos.create') {
      return jsonResponse(200, { id: 'created-item', text: request.text, completed: false });
    }
    if (request.op === 'todos.update') {
      return jsonResponse(200, { id: request.todo_id, text: 'Updated task', completed: true });
    }
    if (request.op === 'todos.delete') return jsonResponse(200, null);
    if (request.op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${request.op}`);
  });

  try {
    for (const projectId of Object.keys(initialTodos)) await refreshSessionTodos(projectId);

    const createList = deferred();
    pendingLists.set('create-project', createList);
    const createRefresh = refreshSessionTodos('create-project');
    await createSessionTodo('create-project', 'New task');
    createList.resolve(jsonResponse(200, [
      ...initialTodos['create-project'],
      { id: 'stale-created-item', text: 'Stale list task', completed: false },
    ]));
    await createRefresh;
    assert.deepEqual(getRagChatSession().todosByProject['create-project'], [
      initialTodos['create-project'][0],
      { id: 'created-item', text: 'New task', completed: false },
    ]);

    const updateList = deferred();
    pendingLists.set('update-project', updateList);
    const updateRefresh = refreshSessionTodos('update-project');
    await updateSessionTodo('update-project', 'update-item', { completed: true });
    updateList.resolve(jsonResponse(200, initialTodos['update-project']));
    await updateRefresh;
    assert.deepEqual(getRagChatSession().todosByProject['update-project'], [
      { id: 'update-item', text: 'Updated task', completed: true },
    ]);

    const deleteList = deferred();
    pendingLists.set('delete-project', deleteList);
    const deleteRefresh = refreshSessionTodos('delete-project');
    assert.equal(await deleteSessionTodo('delete-project', 'delete-item'), true);
    deleteList.resolve(jsonResponse(200, initialTodos['delete-project']));
    await deleteRefresh;
    assert.deepEqual(getRagChatSession().todosByProject['delete-project'], []);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('stale unauthorized responses only clear the token used by their request', async () => {
  const appResponse = deferred();
  const askResponse = deferred();
  const environment = installApiEnvironment(async url => (
    url === '/api/app' ? appResponse.promise : askResponse.promise
  ));

  try {
    const oldAppRequest = listProjects();
    environment.storage.setItem(TOKEN_KEY, 'account-b');
    appResponse.resolve(jsonResponse(401, { code: 'unauthorized', error: 'Expired session' }));
    await assert.rejects(oldAppRequest, error => error.status === 401);
    assert.equal(environment.storage.getItem(TOKEN_KEY), 'account-b');

    const oldAskRequest = openAskStream('request-id', 'chat-id', 'Question?', [], 'auto');
    environment.storage.setItem(TOKEN_KEY, 'account-c');
    askResponse.resolve(jsonResponse(401, { code: 'unauthorized', error: 'Expired session' }));
    await assert.rejects(oldAskRequest, error => error.status === 401);
    assert.equal(environment.storage.getItem(TOKEN_KEY), 'account-c');
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('a rejected ask restores its draft and mentions without hiding the error behind an older answer', async () => {
  const rejection = 'Daily question limit reached';
  let asks = 0;
  const environment = installChatEnvironment(() => {
    asks += 1;
    return new Response(JSON.stringify({ code: 'rate_limited', error: rejection }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    await signInToChat();
    const draft = '  Check the enclosure.\nKeep these assembly notes.\n';
    setSessionDraft(draft);
    addSessionMention(draftFile);
    const finished = nextAskCompletion();
    submitSessionQuestion(draft);
    await finished;
    await refreshSessionMessages('active-chat');
    const state = getRagChatSession();
    assert.deepEqual({
      draft: state.draft,
      mentions: state.mentions,
      error: state.requestErrors['active-chat'],
      pending: Boolean(state.pendingChats['active-chat']),
      messages: state.messagesByChat['active-chat'].map(message => message.id),
    }, {
      draft,
      mentions: [{ id: draftFile.id, name: draftFile.name }],
      error: rejection,
      pending: false,
      messages: ['old-question', 'old-answer'],
    });
    assert.equal(asks, 1);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('a late rejection does not overwrite a newer draft or its selected files', async () => {
  const rejected = deferred();
  const environment = installChatEnvironment(() => rejected.promise);
  try {
    await signInToChat();
    setSessionDraft('First question');
    addSessionMention(draftFile);
    const finished = nextAskCompletion();
    submitSessionQuestion('First question');
    setSessionDraft('A different question');
    addSessionMention({ id: 'new-file', name: 'revision-c.pdf', status: 'ready' });
    rejected.resolve(new Response(JSON.stringify({ code: 'rate_limited', error: 'Limit reached' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    }));
    await finished;
    await refreshSessionMessages('active-chat');
    assert.equal(getRagChatSession().draft, 'A different question');
    assert.deepEqual(getRagChatSession().mentions, [{ id: 'new-file', name: 'revision-c.pdf' }]);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('history recovery clears an interrupted ask error only for its matching answer', async () => {
  let submitted;
  const environment = installChatEnvironment(request => {
    submitted = request;
    throw new TypeError('Connection lost');
  });
  try {
    await signInToChat();
    setSessionDraft('Review the seal');
    const finished = nextAskCompletion();
    const failureReady = new Promise(resolve => {
      const unsubscribe = subscribeRagChatSession(() => {
        const error = getRagChatSession().requestErrors['active-chat'];
        if (error) {
          unsubscribe();
          resolve(error);
        }
      });
    });
    submitSessionQuestion('Review the seal');
    await finished;
    const failure = await failureReady;
    await refreshSessionMessages('active-chat');
    assert.equal(getRagChatSession().requestErrors['active-chat'], failure);
    const question = {
      id: 'saved-question', role: 'user', content: submitted.question,
      request_id: submitted.request_id, created_at: new Date().toISOString(),
    };
    environment.setMessages([...previousConversation, question]);
    await refreshSessionMessages('active-chat');
    assert.equal(getRagChatSession().requestErrors['active-chat'], failure);
    environment.setMessages([
      ...previousConversation, question,
      { id: 'recovered-answer', role: 'assistant', content: 'Seal review', request_id: submitted.request_id, created_at: new Date().toISOString() },
    ]);
    await refreshSessionMessages('active-chat');
    assert.equal(getRagChatSession().requestErrors['active-chat'], '');
    assert.equal(Boolean(getRagChatSession().pendingChats['active-chat']), false);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('a stale identity, profile, and admin response cannot affect a replacement account', async () => {
  const oldMe = deferred();
  const oldProfile = deferred();
  const oldAdmin = deferred();
  const environment = installApiEnvironment(async (url, options) => {
    const { op } = JSON.parse(options.body);
    if (op === 'me' && options.headers.Authorization === 'Bearer account-a') return oldMe.promise;
    if (op === 'me') return jsonResponse(200, {
      id: ACCOUNT_B_ID,
      login: 'ordinary@example.test',
      display_name: 'Account B',
      roles: [],
    });
    if (op === 'account.profile.update') return oldProfile.promise;
    if (url === '/api/admin') return oldAdmin.promise;
    if (op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${op}`);
  });

  try {
    const oldRefresh = refreshSessionAccount();
    const oldSave = saveSessionDisplayName('Account A renamed');
    const oldOperation = runAdminOperation('admin.users.list', { query: 'private' });

    signOutSession();
    environment.storage.setItem(TOKEN_KEY, 'account-b');
    await refreshSessionAccount();

    oldMe.resolve(jsonResponse(200, {
      id: ACCOUNT_A_ID,
      login: 'admin@example.test',
      display_name: 'Account A',
      roles: ['admin'],
    }));
    oldProfile.resolve(jsonResponse(200, {
      id: ACCOUNT_A_ID,
      login: 'admin@example.test',
      display_name: 'Account A renamed',
      roles: ['admin'],
    }));
    oldAdmin.resolve(errorResponse(401, 'unauthorized'));

    const staleErrors = await Promise.all([oldRefresh, oldSave, oldOperation].map(
      request => request.then(() => null, error => error),
    ));
    assert(staleErrors.every(error => error?.name === 'AbortError'));
    assert.equal(environment.storage.getItem(TOKEN_KEY), 'account-b');
    assert.deepEqual({
      authenticated: getRagChatSession().authenticated,
      userId: getRagChatSession().userId,
      loginName: getRagChatSession().loginName,
      roles: getRagChatSession().roles,
      displayName: getRagChatSession().displayName,
    }, {
      authenticated: true,
      userId: ACCOUNT_B_ID,
      loginName: 'ordinary@example.test',
      roles: [],
      displayName: 'Account B',
    });
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('a forbidden admin response preserves the current account and shared session state', async () => {
  const environment = installApiEnvironment(async (url, options) => {
    const { op } = JSON.parse(options.body);
    if (op === 'me') return jsonResponse(200, {
      id: ADMIN_ACCOUNT_ID,
      login: 'admin@example.test',
      display_name: 'Server Admin',
      roles: ['admin'],
    });
    if (url === '/api/admin') return errorResponse(403, 'forbidden');
    if (op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${op}`);
  });

  try {
    await refreshSessionAccount();
    const before = getRagChatSession();
    await assert.rejects(runAdminOperation('admin.users.list'), error => error.status === 403);
    assert.equal(environment.storage.getItem(TOKEN_KEY), 'account-a');
    assert.strictEqual(getRagChatSession(), before);
    assert.equal(getRagChatSession().authenticated, true);
    assert.deepEqual(getRagChatSession().roles, ['admin']);
    assert.equal(getRagChatSession().displayName, 'Server Admin');
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('a current admin 401 clears the server account, identity, and selections', async () => {
  const environment = installApiEnvironment(async (url, options) => {
    const { op } = JSON.parse(options.body);
    if (op === 'me') return jsonResponse(200, {
      id: ADMIN_ACCOUNT_ID,
      login: 'admin@example.test',
      display_name: 'Server Admin',
      roles: ['admin'],
    });
    if (url === '/api/admin') return errorResponse(401, 'unauthorized');
    if (op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${op}`);
  });
  environment.storage.setItem('hardissoft.ragchat.project', 'server-project');
  environment.storage.setItem('hardissoft.ragchat.chat', 'server-chat');

  try {
    await refreshSessionAccount();
    await assert.rejects(runAdminOperation('admin.users.list'), error => error.status === 401);
    assert.equal(environment.storage.getItem(TOKEN_KEY), null);
    assert.equal(environment.storage.getItem('hardissoft.ragchat.project'), null);
    assert.equal(environment.storage.getItem('hardissoft.ragchat.chat'), null);
    assert.deepEqual({
      authenticated: getRagChatSession().authenticated,
      userId: getRagChatSession().userId,
      loginName: getRagChatSession().loginName,
      roles: getRagChatSession().roles,
      displayName: getRagChatSession().displayName,
    }, {
      authenticated: false,
      userId: null,
      loginName: '',
      roles: [],
      displayName: null,
    });
    assert.deepEqual(getRagChatSession().projects, []);
    assert.deepEqual(getRagChatSession().chats, []);
  } finally {
    signOutSession();
    environment.restore();
  }
});

test('profile save normalizes the name and publishes only the server identity', async () => {
  let profileRequest;
  const environment = installApiEnvironment(async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.op === 'me') return jsonResponse(200, {
      id: PROFILE_ACCOUNT_ID,
      login: 'member@example.test',
      display_name: 'Before',
      roles: [],
    });
    if (request.op === 'account.profile.update') {
      profileRequest = request;
      return jsonResponse(200, {
        id: PROFILE_ACCOUNT_ID,
        login: 'member@example.test',
        display_name: 'Updated Server Name',
        roles: [],
      });
    }
    if (request.op === 'logout') return jsonResponse(200, null);
    throw new Error(`Unexpected API operation: ${request.op}`);
  });

  try {
    await refreshSessionAccount();
    const result = await saveSessionDisplayName('  Updated Server Name  ');
    assert.equal(profileRequest.display_name, 'Updated Server Name');
    assert.deepEqual(result, {
      id: PROFILE_ACCOUNT_ID,
      login: 'member@example.test',
      display_name: 'Updated Server Name',
      roles: [],
    });
    assert.equal(getRagChatSession().displayName, 'Updated Server Name');
    assert.deepEqual(getRagChatSession().roles, []);
  } finally {
    signOutSession();
    environment.restore();
  }
});
