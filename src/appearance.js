const STORAGE_KEY = 'hardviser.appearance.v1';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';
const PREFERENCES = new Set(['light', 'dark', 'system']);

let snapshot = Object.freeze({
  preference: 'light',
  theme: 'light',
  persistence: 'saved',
});
const listeners = new Set();
let activeCleanup = null;
let systemMedia = null;
let systemChangeHandler = null;

export function resolveAppearance(preference, systemDark) {
  if (preference === 'dark') return 'dark';
  if (preference === 'system' && systemDark) return 'dark';
  return 'light';
}

function applyTheme(theme) {
  const doc = globalThis.document;
  const root = doc?.documentElement;
  if (!root) return;

  root.dataset.theme = theme;
  if (root.style) root.style.colorScheme = theme;

  const meta = doc.querySelector?.('meta[name="theme-color"]');
  if (!meta) return;
  try {
    const view = doc.defaultView || globalThis.window;
    const color = view?.getComputedStyle?.(root)?.getPropertyValue?.('--paper')?.trim();
    if (color) meta.content = color;
  } catch {
    // The stylesheet still supplies the correct surface if computed styles are unavailable.
  }
}

function publish(preference, theme, persistence) {
  if (snapshot.preference === preference
    && snapshot.theme === theme
    && snapshot.persistence === persistence) return false;

  snapshot = Object.freeze({ preference, theme, persistence });
  applyTheme(theme);
  for (const listener of listeners) listener();
  return true;
}

function readSystemDark() {
  try {
    return Boolean(globalThis.window?.matchMedia?.(SYSTEM_QUERY)?.matches);
  } catch {
    return false;
  }
}

function removeSystemListener() {
  if (!systemMedia || !systemChangeHandler) {
    systemMedia = null;
    systemChangeHandler = null;
    return;
  }

  if (typeof systemMedia.removeEventListener === 'function') {
    systemMedia.removeEventListener('change', systemChangeHandler);
  } else {
    systemMedia.removeListener?.(systemChangeHandler);
  }
  systemMedia = null;
  systemChangeHandler = null;
}

function followSystemWhenSelected() {
  removeSystemListener();
  if (snapshot.preference !== 'system') return;

  try {
    const media = globalThis.window?.matchMedia?.(SYSTEM_QUERY);
    if (!media) return;
    const onChange = event => {
      if (snapshot.preference !== 'system') return;
      publish('system', resolveAppearance('system', Boolean(event.matches)), snapshot.persistence);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
    } else {
      media.addListener?.(onChange);
    }
    systemMedia = media;
    systemChangeHandler = onChange;
  } catch {
    // System mode remains usable with the current OS value when live media queries are unavailable.
  }
}

export function initializeAppearance() {
  activeCleanup?.();
  activeCleanup = null;

  let preference = 'light';
  let persistence = 'saved';
  try {
    const stored = globalThis.window.localStorage.getItem(STORAGE_KEY);
    if (PREFERENCES.has(stored)) preference = stored;
  } catch {
    persistence = 'memory';
  }

  const theme = resolveAppearance(preference, preference === 'system' ? readSystemDark() : false);
  publish(preference, theme, persistence);
  applyTheme(theme);
  followSystemWhenSelected();

  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (activeCleanup === cleanup) activeCleanup = null;
    removeSystemListener();
  };
  activeCleanup = cleanup;
  return cleanup;
}

export function getAppearanceSnapshot() {
  return snapshot;
}

export function subscribeAppearance(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAppearancePreference(preference) {
  if (!PREFERENCES.has(preference)) return snapshot;

  let persistence = 'saved';
  try {
    globalThis.window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    persistence = 'memory';
  }

  const theme = resolveAppearance(preference, preference === 'system' ? readSystemDark() : false);
  publish(preference, theme, persistence);
  followSystemWhenSelected();
  return snapshot;
}
