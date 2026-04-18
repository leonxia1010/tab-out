import {
  getSettings,
  setSettings,
  onSettingsChange,
  defaultSettings,
  type ToutSettings,
  type ThemeMode,
  type ClockFormat,
  type Layout,
} from '../../shared/dist/settings.js';
import { el } from '../../shared/dist/dom-utils.js';
import { extractHostname } from '../../shared/dist/url.js';

// Explicit Save model (v2.4.0). draft holds in-flight edits; baseline
// mirrors the last-known storage value. Save writes draft → storage;
// Cancel navigates away and the browser discards the draft. isDirty()
// compares the two. A storage event from another window updates
// baseline always (so dirty stays meaningful against the latest remote
// value), but only replaces draft + re-renders when the user hadn't
// started editing — their open session wins.
let draft: ToutSettings = defaultSettings();
let baseline: ToutSettings = defaultSettings();

function cloneSettings(s: ToutSettings): ToutSettings {
  return {
    theme: s.theme,
    clock: { ...s.clock },
    layout: s.layout,
    shortcutPins: s.shortcutPins.map((p) => ({ ...p })),
    shortcutHides: [...s.shortcutHides],
  };
}

function pinsKey(pins: readonly { url: string; title: string }[]): string {
  return pins.map((p) => `${p.url}\u0000${p.title}`).join('\u0001');
}

function isDirty(): boolean {
  return draft.theme !== baseline.theme
    || draft.clock.format !== baseline.clock.format
    || draft.layout !== baseline.layout
    || pinsKey(draft.shortcutPins) !== pinsKey(baseline.shortcutPins)
    || draft.shortcutHides.join('\u0001') !== baseline.shortcutHides.join('\u0001');
}

function radios(name: string): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`);
}

function setRadioValue(name: string, value: string): void {
  for (const input of radios(name)) {
    input.checked = input.value === value;
  }
}

function hostOf(rawUrl: string): string {
  // Fall back to the raw string so a malformed stored URL still renders
  // something readable in the pinned/hidden lists instead of an empty cell.
  return extractHostname(rawUrl) ?? rawUrl;
}

// Shortcut list rendering routes every user-supplied string through
// shared/dom-utils el() so hostile titles (chrome.topSites → pin action)
// can't inject HTML — same discipline the dashboard widgets use.
function renderPinnedList(): void {
  const list = document.getElementById('pinnedList');
  if (!list) return;
  list.replaceChildren(
    ...draft.shortcutPins.map((pin) => {
      const remove = el('button', {
        type: 'button',
        className: 'settings-list-remove',
      }, ['Remove']) as HTMLButtonElement;
      remove.addEventListener('click', () => {
        draft.shortcutPins = draft.shortcutPins.filter((p) => p.url !== pin.url);
        renderPinnedList();
        renderDirtyState();
      });
      return el('li', { className: 'settings-list-item' }, [
        el('span', { className: 'settings-list-item-title' }, [pin.title || hostOf(pin.url)]),
        el('span', { className: 'settings-list-item-url' }, [pin.url]),
        remove,
      ]);
    }),
  );
}

function renderHiddenList(): void {
  const list = document.getElementById('hiddenList');
  if (!list) return;
  list.replaceChildren(
    ...draft.shortcutHides.map((url) => {
      const restore = el('button', {
        type: 'button',
        className: 'settings-list-remove',
      }, ['Unhide']) as HTMLButtonElement;
      restore.addEventListener('click', () => {
        draft.shortcutHides = draft.shortcutHides.filter((u) => u !== url);
        renderHiddenList();
        renderDirtyState();
      });
      return el('li', { className: 'settings-list-item' }, [
        el('span', { className: 'settings-list-item-title' }, [hostOf(url)]),
        el('span', { className: 'settings-list-item-url' }, [url]),
        restore,
      ]);
    }),
  );
}

function renderForm(): void {
  setRadioValue('theme', draft.theme);
  setRadioValue('clockFormat', draft.clock.format);
  setRadioValue('layout', draft.layout);
  renderPinnedList();
  renderHiddenList();
}

function renderDirtyState(): void {
  const dirty = isDirty();
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement | null;
  const dirtyText = document.getElementById('dirtyText');
  const dirtyDot = document.getElementById('dirtyDot');
  if (saveBtn) saveBtn.disabled = !dirty;
  if (dirtyText) dirtyText.toggleAttribute('hidden', !dirty);
  if (dirtyDot) dirtyDot.toggleAttribute('hidden', !dirty);
}

function isTheme(v: string): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

function isClockFormat(v: string): v is ClockFormat {
  return v === '12h' || v === '24h';
}

function isLayout(v: string): v is Layout {
  return v === 'masonry' || v === 'grid';
}

function wireRadio(name: string, handler: (value: string) => void): void {
  for (const input of radios(name)) {
    input.addEventListener('change', () => {
      if (input.checked) handler(input.value);
    });
  }
}

function navigateToDashboard(): void {
  // Chrome blocks chrome-extension:// → chrome:// navigation via
  // location.href (it silently no-ops). chrome.runtime.getURL()
  // returns a chrome-extension:// URL to our own origin, which is
  // allowed. Functionally identical for the user because our
  // new-tab override resolves chrome://newtab/ to the same file.
  const url = chrome.runtime?.getURL?.('dashboard/index.html');
  if (url) window.location.href = url;
}

async function save(): Promise<void> {
  const saveBtn = document.getElementById('saveBtn') as HTMLButtonElement | null;
  if (saveBtn?.disabled) return;
  await setSettings(draft);
  navigateToDashboard();
}

function cancel(): void {
  // Cancel navigates away unconditionally. If draft is dirty, the
  // beforeunload guard below prompts the user; if the user confirms,
  // the draft is discarded by virtue of the page unloading. No
  // in-page revert needed.
  navigateToDashboard();
}

async function bootstrap(): Promise<void> {
  const initial = await getSettings();
  baseline = cloneSettings(initial);
  draft = cloneSettings(initial);
  renderForm();
  renderDirtyState();

  wireRadio('theme', (value) => {
    if (isTheme(value)) {
      draft.theme = value;
      renderDirtyState();
    }
  });

  wireRadio('clockFormat', (value) => {
    if (isClockFormat(value)) {
      draft.clock = { ...draft.clock, format: value };
      renderDirtyState();
    }
  });

  wireRadio('layout', (value) => {
    if (isLayout(value)) {
      draft.layout = value;
      renderDirtyState();
    }
  });

  document.getElementById('saveBtn')?.addEventListener('click', () => {
    void save();
  });
  document.getElementById('cancelBtn')?.addEventListener('click', cancel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return;
    e.preventDefault();
    // Modern browsers (Chrome/Firefox/Safari post-2017) ignore custom
    // strings and show their own generic "Leave site?" dialog. The
    // assignment is kept so the guard's intent is self-documenting
    // and because a handful of legacy browsers still honor it.
    e.returnValue = 'You have unsaved changes.';
  });

  // External writes (dashboard toggle, another options tab) always
  // update baseline — that keeps "dirty" meaningful against the
  // latest remote value. draft only follows if the user hadn't
  // started editing (wasDirty=false); otherwise we leave their
  // in-flight edits alone.
  onSettingsChange((next) => {
    const wasDirty = isDirty();
    baseline = cloneSettings(next);
    if (!wasDirty) {
      draft = cloneSettings(next);
      renderForm();
    }
    renderDirtyState();
  });
}

void bootstrap();
