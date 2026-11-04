import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeEmailLogin,
  getRagChatMe,
  getRagChatToken,
  prepareEmailLogin,
  requestAdminOperation,
  requestEmailLogin,
  updateAccountProfile,
} from '../src/rag-chat-api.js';

const TOKEN_KEY = 'hardissoft.ragchat.session';
const PROJECT_KEY = 'hardissoft.ragchat.project';
const CHAT_KEY = 'hardissoft.ragchat.chat';
const EMAIL_USER_ID = '10000000-0000-4000-8000-000000000001';
const ABORTED_USER_ID = '10000000-0000-4000-8000-000000000002';
const ACCOUNT_A_ID = '10000000-0000-4000-8000-000000000003';
const ACCOUNT_B_ID = '10000000-0000-4000-8000-000000000004';
const PROFILE_ID = '10000000-0000-4000-8000-000000000005';
const VALID_ID = '10000000-0000-4000-8000-000000000006';

function dataResponse(status, data) {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, code) {
  return new Response(JSON.stringify({ code, error: 'Sign-in link could not be used.' }), {
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

function installApiEnvironment(fetchImpl) {
  const storage = makeStorage();
  storage.setItem(TOKEN_KEY, 'existing-session');
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

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('email auth uses exact public contracts without publishing a session token', async () => {
  const calls = [];
  const environment = installApiEnvironment(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (body.op === 'auth.email.request') return dataResponse(200, { ok: true });
    if (body.op === 'auth.email.prepare') return dataResponse(200, {
      email: 'founder@example.test',
      return_to: '/rag-chat?record=42',
      expires_at: 1_800_000_000,
    });
    if (body.op === 'auth.email.consume') return dataResponse(200, {
      id: EMAIL_USER_ID,
      login: 'founder@example.test',
      display_name: null,
      roles: [],
      token: 'new-email-session',
      expires_at: '2030-01-01T00:00:00Z',
    });
    throw new Error(`Unexpected operation: ${body.op}`);
  });

  try {
    assert.deepEqual(await requestEmailLogin('founder@example.test', 'turnstile-proof', '/rag-chat?record=42'), { ok: true });
    assert.deepEqual(await prepareEmailLogin('email-link-token'), {
      email: 'founder@example.test',
      return_to: '/rag-chat?record=42',
      expires_at: 1_800_000_000,
    });
    assert.deepEqual(await consumeEmailLogin('email-link-token'), {
      id: EMAIL_USER_ID,
      login: 'founder@example.test',
      display_name: null,
      roles: [],
      token: 'new-email-session',
      expires_at: '2030-01-01T00:00:00Z',
    });
    assert.deepEqual(calls.map(call => call.body), [
      { op: 'auth.email.request', email: 'founder@example.test', turnstile_token: 'turnstile-proof', return_to: '/rag-chat?record=42' },
      { op: 'auth.email.prepare', token: 'email-link-token' },
      { op: 'auth.email.consume', token: 'email-link-token' },
    ]);
    assert(calls.every(call => call.url === '/api/app' && !call.options.headers.Authorization));
    assert.equal(environment.storage.getItem(TOKEN_KEY), 'existing-session');
  } finally {
    environment.restore();
  }
});

test('invalid email links do not clear the current session token', async () => {
  const environment = installApiEnvironment(async () => errorResponse(400, 'invalid_link'));
  try {
    await assert.rejects(prepareEmailLogin('expired-link'), error => error.code === 'invalid_link');
    await assert.rejects(consumeEmailLogin('expired-link'), error => error.code === 'invalid_link');
    assert.equal(getRagChatToken(), 'existing-session');
  } finally {
    environment.restore();
  }
});

test('an aborted email sign-in cannot publish a late session', async () => {
  const emailResponse = deferred();
  const environment = installApiEnvironment(async (_url, options) => {
    const { op } = JSON.parse(options.body);
    if (op === 'auth.email.consume') return emailResponse.promise;
    if (op === 'logout') return dataResponse(200, null);
    throw new Error(`Unexpected operation: ${op}`);
  });
  const session = await import('../src/rag-chat-session.js?email-auth-epoch');

  try {
    const emailSignIn = session.consumeSessionEmailLogin('email-link-token');
    session.signOutSession();
    emailResponse.resolve(dataResponse(200, {
      id: ABORTED_USER_ID,
      login: 'email@example.test',
      display_name: null,
      roles: [],
      token: 'late-email-session',
      expires_at: '2030-01-01T00:00:00Z',
    }));
    assert.equal(getRagChatToken(), '');
    assert.equal(session.getRagChatSession().authenticated, false);
  } finally {
    session.signOutSession();
    environment.restore();
  }
});

test('invalid links preserve the active account and switching accounts clears its server data', async () => {
  const environment = installApiEnvironment(async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.op === 'me') return dataResponse(200, {
      id: ACCOUNT_A_ID,
      login: 'legacy-founder',
      display_name: 'Server Admin Name',
      roles: ['admin'],
    });
    if (body.op === 'projects.list') {
      return dataResponse(200, options.headers.Authorization === 'Bearer existing-session'
        ? [{ id: 'project-a', name: 'Account A project' }]
        : []);
    }
    if (body.op === 'todos.list') return dataResponse(200, [{ id: 'todo-a', text: 'Account A task' }]);
    if (body.op === 'chats.list') return dataResponse(200, [{ id: 'chat-a', title: 'Account A chat' }]);
    if (body.op === 'files.list') return dataResponse(200, [{ id: 'file-a', name: 'account-a.pdf' }]);
    if (body.op === 'messages.list') return dataResponse(200, [{ id: 'message-a', role: 'user', content: 'Account A message' }]);
    if (body.op === 'auth.email.consume') {
      assert.equal(options.headers.Authorization, undefined);
      if (body.token === 'invalid-link') return errorResponse(400, 'invalid_link');
      return dataResponse(200, {
        id: ACCOUNT_B_ID,
        login: 'founder@example.test',
        display_name: 'Server User Name',
        roles: [],
        token: 'account-b-session',
        expires_at: '2030-01-01T00:00:00Z',
      });
    }
    if (body.op === 'logout') return dataResponse(200, null);
    throw new Error(`Unexpected operation: ${body.op}`);
  });
  environment.storage.setItem(PROJECT_KEY, 'project-a');
  environment.storage.setItem(CHAT_KEY, 'chat-a');
  const session = await import('../src/rag-chat-session.js?email-auth-account-switch');

  try {
    await session.initializeRagChatSession();
    await session.refreshSessionTodos('project-a');
    await session.refreshSessionMessages('chat-a');
    assert.equal(session.getRagChatSession().authenticated, true);
    assert.equal(session.getRagChatSession().userId, ACCOUNT_A_ID);
    assert.deepEqual(session.getRagChatSession().roles, ['admin']);
    assert.equal(session.getRagChatSession().displayName, 'Server Admin Name');
    assert.equal(session.getRagChatSession().messagesByChat['chat-a'][0].content, 'Account A message');

    await assert.rejects(session.consumeSessionEmailLogin('invalid-link'), error => error.code === 'invalid_link');
    assert.equal(getRagChatToken(), 'existing-session');
    assert.equal(session.getRagChatSession().userId, ACCOUNT_A_ID);
    assert.equal(session.getRagChatSession().projects[0].id, 'project-a');

    assert.equal(await session.consumeSessionEmailLogin('valid-link'), true);
    const current = session.getRagChatSession();
    assert.equal(getRagChatToken(), 'account-b-session');
    assert.equal(current.userId, ACCOUNT_B_ID);
    assert.equal(current.loginName, 'founder@example.test');
    assert.deepEqual(current.roles, []);
    assert.equal(current.displayName, 'Server User Name');
    assert.deepEqual(current.projects, []);
    assert.deepEqual(current.chats, []);
    assert.deepEqual(current.files, []);
    assert.deepEqual(current.messagesByChat, {});
    assert.deepEqual(current.todosByProject, {});
    assert.equal(current.selectedProjectId, null);
    assert.equal(current.selectedChatId, null);
    assert.equal(environment.storage.getItem(PROJECT_KEY), null);
    assert.equal(environment.storage.getItem(CHAT_KEY), null);
    session.signOutSession();
    assert.deepEqual(session.getRagChatSession().roles, []);
    assert.equal(session.getRagChatSession().displayName, null);
    assert.equal(session.getRagChatSession().userId, null);
  } finally {
    session.signOutSession();
    environment.restore();
  }
});

test('profile and admin helpers use their fixed authenticated endpoints and preserve DTOs', async () => {
  const calls = [];
  const identity = {
    id: PROFILE_ID,
    login: 'member@example.test',
    display_name: 'Server Name',
    roles: ['expert'],
  };
  const page = { items: [], next_cursor: null };
  const environment = installApiEnvironment(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    if (body.op === 'account.profile.update') return dataResponse(200, identity);
    if (body.op === 'admin.users.list') return dataResponse(200, page);
    throw new Error(`Unexpected operation: ${body.op}`);
  });
  const controller = new AbortController();

  try {
    assert.deepEqual(await updateAccountProfile('Server Name', controller.signal), identity);
    assert.deepEqual(await requestAdminOperation('admin.users.list', { query: 'member' }, controller.signal), page);
    assert.deepEqual(await updateAccountProfile('   ', controller.signal), identity);
    assert.deepEqual(calls.map(({ url, body }) => ({ url, body })), [
      { url: '/api/app', body: { op: 'account.profile.update', display_name: 'Server Name' } },
      { url: '/api/admin', body: { op: 'admin.users.list', query: 'member' } },
      { url: '/api/app', body: { op: 'account.profile.update', display_name: null } },
    ]);
    assert(calls.every(({ options }) => (
      options.method === 'POST'
      && options.cache === 'no-store'
      && options.headers.Authorization === 'Bearer existing-session'
      && options.signal === controller.signal
    )));
  } finally {
    environment.restore();
  }
});

test('identity and email login endpoints reject incomplete or malformed server identity DTOs', async () => {
  let responseIdentity;
  const invalidIdentities = [
    { id: VALID_ID, login: 'member@example.test', display_name: null },
    { id: 'not-a-uuid', login: 'member@example.test', display_name: null, roles: [] },
    { id: VALID_ID, login: ' member@example.test ', display_name: null, roles: [] },
    { id: VALID_ID, login: 'member@example.test\n', display_name: null, roles: [] },
    { id: VALID_ID, login: 'x'.repeat(255), display_name: null, roles: [] },
    { id: VALID_ID, login: 'member@example.test', display_name: null, roles: ['admin', 'admin'] },
    { id: VALID_ID, login: 'member@example.test', display_name: 'Invalid\nName', roles: [] },
  ];
  const environment = installApiEnvironment(async (_url, options) => {
    const { op } = JSON.parse(options.body);
    return dataResponse(200, op === 'auth.email.consume'
      ? { ...responseIdentity, token: 'session-token', expires_at: '2030-01-01T00:00:00Z' }
      : responseIdentity);
  });

  try {
    for (const identity of invalidIdentities) {
      responseIdentity = identity;
      await assert.rejects(getRagChatMe(), error => error.code === 'invalid_response');
      await assert.rejects(consumeEmailLogin('email-link'), error => error.code === 'invalid_response');
    }
  } finally {
    environment.restore();
  }
});
