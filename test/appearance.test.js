import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  getAppearanceSnapshot,
  initializeAppearance,
  resolveAppearance,
  setAppearancePreference,
} from '../src/appearance.js';

const APPEARANCE_KEY = 'hardviser.appearance.v1';
const WORKSPACE_KEY = 'hardissoft.workspace.v1';
let stopAppearance;
let previousWindow;
let previousDocument;
let hadWindow;
let hadDocument;

afterEach(() => {
  stopAppearance?.();
  stopAppearance = undefined;
  if (hadWindow) globalThis.window = previousWindow;
  else delete globalThis.window;
  if (hadDocument) globalThis.document = previousDocument;
  else delete globalThis.document;
});

function installBrowser({ storedPreference = null, systemDark = false, storageBlocked = false } = {}) {
  const workspace = '{"version":3,"projects":{"local-project":{"records":[]}}}';
  const values = new Map([[WORKSPACE_KEY, workspace]]);
  const writes = [];
  if (storedPreference !== null) values.set(APPEARANCE_KEY, storedPreference);
  const storage = {
    getItem(key) {
      if (storageBlocked) throw new Error('Storage is blocked');
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push(key);
      if (storageBlocked) throw new Error('Storage is blocked');
      values.set(key, String(value));
    },
  };
  const listeners = new Set();
  const media = {
    matches: systemDark,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener);
    },
  };
  const themeColor = { content: '' };
  const document = {
    documentElement: { dataset: {}, style: {} },
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? themeColor : null;
    },
  };
  const window = {
    localStorage: storage,
    matchMedia(query) {
      assert.equal(query, '(prefers-color-scheme: dark)');
      return media;
    },
    getComputedStyle(element) {
      return { getPropertyValue(name) {
        return name === '--paper' ? (element.dataset.theme === 'dark' ? '#181D21' : '#F7F8F6') : '';
      } };
    },
  };

  hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  previousWindow = globalThis.window;
  previousDocument = globalThis.document;
  globalThis.window = window;
  globalThis.document = document;

  return {
    document,
    media,
    setSystemDark(value) {
      media.matches = value;
      for (const listener of listeners) listener({ matches: value });
    },
    themeColor,
    values,
    workspace,
    writes,
  };
}

function startAppearance(options) {
  const browser = installBrowser(options);
  stopAppearance = initializeAppearance();
  return browser;
}

test('system resolves to the current OS preference while explicit themes do not', () => {
  assert.equal(resolveAppearance('system', true), 'dark');
  assert.equal(resolveAppearance('system', false), 'light');
  assert.equal(resolveAppearance('light', true), 'light');
  assert.equal(resolveAppearance('dark', false), 'dark');
});

test('saved Dark is applied before the application mounts', () => {
  const browser = startAppearance({ storedPreference: 'dark', systemDark: false });

  assert.deepEqual(getAppearanceSnapshot(), {
    preference: 'dark',
    theme: 'dark',
    persistence: 'saved',
  });
  assert.equal(browser.document.documentElement.dataset.theme, 'dark');
  assert.equal(browser.document.documentElement.style.colorScheme, 'dark');
  assert.equal(browser.themeColor.content, '#181D21');
});

test('System follows OS changes while it is selected', () => {
  const browser = startAppearance({ storedPreference: 'system', systemDark: false });
  assert.equal(getAppearanceSnapshot().theme, 'light');

  browser.setSystemDark(true);
  assert.deepEqual(getAppearanceSnapshot(), {
    preference: 'system',
    theme: 'dark',
    persistence: 'saved',
  });
  assert.equal(browser.document.documentElement.dataset.theme, 'dark');

  browser.setSystemDark(false);
  assert.equal(getAppearanceSnapshot().theme, 'light');
});

test('explicit preference stays selected across OS changes and writes only its own key', () => {
  const browser = startAppearance({ storedPreference: 'light', systemDark: true });
  setAppearancePreference('dark');
  browser.setSystemDark(false);

  assert.equal(getAppearanceSnapshot().theme, 'dark');
  assert.equal(browser.values.get(APPEARANCE_KEY), 'dark');
  assert.deepEqual(browser.writes, [APPEARANCE_KEY]);
  assert.equal(browser.values.get(WORKSPACE_KEY), browser.workspace);
});

test('an invalid stored preference falls back to Light without changing other browser data', () => {
  const browser = startAppearance({ storedPreference: 'sepia', systemDark: true });

  assert.deepEqual(getAppearanceSnapshot(), {
    preference: 'light',
    theme: 'light',
    persistence: 'saved',
  });
  assert.equal(browser.document.documentElement.dataset.theme, 'light');
  assert.equal(browser.values.get(APPEARANCE_KEY), 'sepia');
  assert.equal(browser.values.get(WORKSPACE_KEY), browser.workspace);
  assert.deepEqual(browser.writes, []);
});

test('blocked storage keeps theme changes usable in memory without touching workspace data', () => {
  const browser = startAppearance({ storageBlocked: true, systemDark: false });
  assert.deepEqual(getAppearanceSnapshot(), {
    preference: 'light',
    theme: 'light',
    persistence: 'memory',
  });

  setAppearancePreference('dark');

  assert.deepEqual(getAppearanceSnapshot(), {
    preference: 'dark',
    theme: 'dark',
    persistence: 'memory',
  });
  assert.equal(browser.document.documentElement.dataset.theme, 'dark');
  assert.deepEqual(browser.writes, [APPEARANCE_KEY]);
  assert.equal(browser.values.get(WORKSPACE_KEY), browser.workspace);
});

test('appearance snapshots keep the same identity until appearance state changes', () => {
  startAppearance();
  const initial = getAppearanceSnapshot();
  assert.equal(getAppearanceSnapshot(), initial);

  setAppearancePreference('dark');
  const changed = getAppearanceSnapshot();
  assert.notEqual(changed, initial);
  assert.equal(getAppearanceSnapshot(), changed);
});
