// @vitest-environment jsdom
// tests/options/index.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Integration coverage for extension/options/src/index.ts — the options
// page's explicit Save model (v2.4.0). Draft/baseline isolation, dirty
// state tracking, beforeunload guard, keyboard shortcuts, external
// onSettingsChange gating — end-to-end against a mocked chrome.storage
// + a jsdom DOM.
//
// Listener tracking: vi.resetModules() + re-import causes new window
// and document listeners to accumulate (old module's listeners remain
// attached to the shared window). The trackingInstall/trackingRestore
// helpers below wrap addEventListener to collect registrations and
// remove them in afterEach, so each test starts with a clean listener
// graph.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SETTINGS_KEY = 'tabout:settings';

// Minimum DOM surface the options page drives. Keep structural
// attributes (ids, radio names, data) — drop copy / layout classes.
const OPTIONS_HTML = `
  <main class="settings-container">
    <header class="settings-header">
      <h1>Tab Out <span class="settings-heading-accent">— Settings</span><span class="dirty-dot" id="dirtyDot" hidden></span></h1>
    </header>
    <section>
      <fieldset class="settings-field">
        <label><input type="radio" name="theme" value="system"> Follow system</label>
        <label><input type="radio" name="theme" value="light"> Light</label>
        <label><input type="radio" name="theme" value="dark"> Dark</label>
      </fieldset>
    </section>
    <section>
      <fieldset class="settings-field">
        <label><input type="radio" name="clockFormat" value="12h"> 12h</label>
        <label><input type="radio" name="clockFormat" value="24h"> 24h</label>
      </fieldset>
    </section>
    <section>
      <fieldset class="settings-field">
        <label><input type="radio" name="layout" value="masonry"> Masonry</label>
        <label><input type="radio" name="layout" value="grid"> Grid</label>
      </fieldset>
    </section>
    <section>
      <label class="settings-toggle"><input type="checkbox" id="weatherEnabled"> Show weather widget</label>
      <div class="settings-field">
        <input type="text" id="weatherLocation">
        <button type="button" id="weatherLocationSearch">Find</button>
        <span id="weatherLocationFeedback"></span>
      </div>
      <fieldset class="settings-field">
        <label><input type="radio" name="weatherUnit" value="C"> Celsius</label>
        <label><input type="radio" name="weatherUnit" value="F"> Fahrenheit</label>
      </fieldset>
    </section>
    <section>
      <label class="settings-toggle"><input type="checkbox" id="countdownEnabled"> Show countdown widget</label>
      <label class="settings-toggle"><input type="checkbox" id="countdownSound"> Play sound</label>
    </section>
    <section>
      <ul class="settings-list" id="priorityList"></ul>
      <p class="settings-list-empty" id="priorityEmpty" hidden>No priority hostnames.</p>
      <div class="settings-inline-row">
        <input type="text" id="priorityAddInput">
        <button type="button" id="priorityAddBtn" disabled>Add</button>
      </div>
      <span id="priorityAddFeedback" aria-live="polite"></span>
    </section>
    <section>
      <ul class="settings-list" id="pinnedList"></ul>
      <ul class="settings-list" id="hiddenList"></ul>
    </section>
    <footer class="settings-footer">
      <span class="dirty-text" id="dirtyText" hidden>Unsaved changes</span>
      <button type="button" id="cancelBtn">Cancel</button>
      <button type="button" id="saveBtn" disabled>Save &amp; Close</button>
    </footer>
  </main>
`;

const origWindowAdd = window.addEventListener;
const origDocumentAdd = document.addEventListener;
let listenerRegistry = [];

function trackingInstall() {
  listenerRegistry = [];
  window.addEventListener = function (type, cb, opts) {
    listenerRegistry.push({ target: this, type, cb });
    return origWindowAdd.call(this, type, cb, opts);
  };
  document.addEventListener = function (type, cb, opts) {
    listenerRegistry.push({ target: this, type, cb });
    return origDocumentAdd.call(this, type, cb, opts);
  };
}

function trackingRestore() {
  for (const { target, type, cb } of listenerRegistry) {
    target.removeEventListener(type, cb);
  }
  listenerRegistry = [];
  window.addEventListener = origWindowAdd;
  document.addEventListener = origDocumentAdd;
}

function installMocks(initialSettings) {
  const store = new Map();
  if (initialSettings !== undefined) store.set(SETTINGS_KEY, initialSettings);
  const changeListeners = [];

  const storageLocal = {
    get: vi.fn(async (key) => (store.has(key) ? { [key]: store.get(key) } : {})),
    set: vi.fn(async (kv) => {
      for (const [k, v] of Object.entries(kv)) store.set(k, v);
    }),
  };

  vi.stubGlobal('chrome', {
    runtime: {
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
    },
    storage: {
      local: storageLocal,
      onChanged: {
        addListener: vi.fn((cb) => changeListeners.push(cb)),
        removeListener: vi.fn((cb) => {
          const i = changeListeners.indexOf(cb);
          if (i >= 0) changeListeners.splice(i, 1);
        }),
      },
    },
  });

  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });

  vi.stubGlobal('navigator', { language: 'en-US' });

  // jsdom refuses to navigate to chrome://newtab/. Replace window.location
  // with a plain object so `location.href = ...` becomes an observable
  // property write.
  Object.defineProperty(window, 'location', {
    value: { href: 'about:blank' },
    writable: true,
    configurable: true,
  });

  return {
    storageLocal,
    fireChange: (changes) => {
      for (const cb of changeListeners.slice()) cb(changes, 'local');
    },
  };
}

async function boot(initialSettings) {
  document.body.innerHTML = OPTIONS_HTML;
  const mocks = installMocks(initialSettings);
  vi.resetModules();
  await import('../../extension/options/src/index.ts');
  // Drain bootstrap()'s await getSettings + subsequent microtasks.
  await new Promise((r) => setTimeout(r, 0));
  return mocks;
}

function defaultInitial(patch = {}) {
  return {
    theme: 'system',
    clock: { format: '12h' },
    layout: 'masonry',
    priorityHostnames: [
      'mail.google.com',
      'x.com',
      'www.linkedin.com',
      'github.com',
    ],
    shortcutPins: [],
    shortcutHides: [],
    ...patch,
  };
}

beforeEach(() => {
  trackingInstall();
});

afterEach(() => {
  trackingRestore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('options page — pristine state', () => {
  it('hydrates form from storage without marking dirty', async () => {
    await boot(defaultInitial({ theme: 'dark', clock: { format: '24h' }, layout: 'grid' }));

    expect(document.querySelector('input[name="theme"][value="dark"]').checked).toBe(true);
    expect(document.querySelector('input[name="clockFormat"][value="24h"]').checked).toBe(true);
    expect(document.querySelector('input[name="layout"][value="grid"]').checked).toBe(true);

    expect(document.getElementById('saveBtn').disabled).toBe(true);
    expect(document.getElementById('dirtyDot').hidden).toBe(true);
    expect(document.getElementById('dirtyText').hidden).toBe(true);
  });
});

describe('options page — dirty transitions', () => {
  it('radio change marks dirty + enables Save + shows both indicators', async () => {
    await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.getElementById('saveBtn').disabled).toBe(false);
    expect(document.getElementById('dirtyDot').hidden).toBe(false);
    expect(document.getElementById('dirtyText').hidden).toBe(false);
  });

  it('layout and clock changes also mark dirty', async () => {
    await boot(defaultInitial());

    const grid = document.querySelector('input[name="layout"][value="grid"]');
    grid.checked = true;
    grid.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });
});

describe('options page — Save', () => {
  it('writes the full draft and navigates to new-tab', async () => {
    const mocks = await boot(defaultInitial());

    const light = document.querySelector('input[name="theme"][value="light"]');
    light.checked = true;
    light.dispatchEvent(new Event('change', { bubbles: true }));

    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));

    const call = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0]);
    expect(call).toBeDefined();
    expect(call[0][SETTINGS_KEY].theme).toBe('light');
    expect(window.location.href).toBe('chrome-extension://test/dashboard/index.html');
  });

  it('is a no-op when not dirty (button disabled)', async () => {
    const mocks = await boot(defaultInitial());

    mocks.storageLocal.set.mockClear();
    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(window.location.href).toBe('about:blank');
  });
});

describe('options page — Cancel', () => {
  it('navigates to new-tab without writing storage (dirty)', async () => {
    const mocks = await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    mocks.storageLocal.set.mockClear();
    document.getElementById('cancelBtn').click();

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(window.location.href).toBe('chrome-extension://test/dashboard/index.html');
  });

  it('navigates to new-tab when pristine', async () => {
    const mocks = await boot(defaultInitial());

    document.getElementById('cancelBtn').click();

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(window.location.href).toBe('chrome-extension://test/dashboard/index.html');
  });
});

describe('options page — onSettingsChange gating', () => {
  it('pristine form: external write re-renders to the new value', async () => {
    const mocks = await boot(defaultInitial());

    mocks.fireChange({
      [SETTINGS_KEY]: {
        newValue: {
          theme: 'dark', clock: { format: '24h' }, layout: 'grid',
          shortcutPins: [], shortcutHides: [],
        },
      },
    });

    expect(document.querySelector('input[name="theme"][value="dark"]').checked).toBe(true);
    expect(document.getElementById('saveBtn').disabled).toBe(true);
  });

  it('dirty form: external write updates baseline but leaves draft alone', async () => {
    const mocks = await boot(defaultInitial());

    // User picks light.
    const light = document.querySelector('input[name="theme"][value="light"]');
    light.checked = true;
    light.dispatchEvent(new Event('change', { bubbles: true }));

    // External write flips theme to dark.
    mocks.fireChange({
      [SETTINGS_KEY]: {
        newValue: {
          theme: 'dark', clock: { format: '12h' }, layout: 'masonry',
          shortcutPins: [], shortcutHides: [],
        },
      },
    });

    // Draft preserved: form still shows light.
    expect(document.querySelector('input[name="theme"][value="light"]').checked).toBe(true);
    expect(document.querySelector('input[name="theme"][value="dark"]').checked).toBe(false);
    // Still dirty vs new baseline.
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });

  it('external write matching the dirty draft clears dirty', async () => {
    // Subtle case: user edited to dark; external write also sets dark.
    // After the write, draft === baseline, so dirty flips off.
    const mocks = await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('saveBtn').disabled).toBe(false);

    mocks.fireChange({
      [SETTINGS_KEY]: {
        newValue: {
          theme: 'dark', clock: { format: '12h' }, layout: 'masonry',
          shortcutPins: [], shortcutHides: [],
        },
      },
    });

    expect(document.getElementById('saveBtn').disabled).toBe(true);
  });
});

describe('options page — keyboard', () => {
  it('Escape triggers Cancel (navigates, no write)', async () => {
    const mocks = await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    mocks.storageLocal.set.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(window.location.href).toBe('chrome-extension://test/dashboard/index.html');
  });

  it('Cmd+S triggers Save when dirty', async () => {
    const mocks = await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    mocks.storageLocal.set.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.storageLocal.set).toHaveBeenCalled();
  });

  it('Ctrl+S also triggers Save', async () => {
    const mocks = await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    mocks.storageLocal.set.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.storageLocal.set).toHaveBeenCalled();
  });

  it('Cmd+S is a no-op when pristine', async () => {
    const mocks = await boot(defaultInitial());

    mocks.storageLocal.set.mockClear();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
  });
});

describe('options page — beforeunload guard', () => {
  it('preventDefault() called when dirty', async () => {
    await boot(defaultInitial());

    const dark = document.querySelector('input[name="theme"][value="dark"]');
    dark.checked = true;
    dark.dispatchEvent(new Event('change', { bubbles: true }));

    const evt = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(evt, 'returnValue', { value: '', writable: true });
    window.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(true);
  });

  it('preventDefault() NOT called when pristine', async () => {
    await boot(defaultInitial());

    const evt = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(evt, 'returnValue', { value: '', writable: true });
    window.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
  });
});

describe('options page — weather section (v2.6.0)', () => {
  it('toggling the weather checkbox marks the form dirty', async () => {
    // defaultInitial() omits weather entirely → normalizeSettings hydrates
    // with the defaults (enabled:true). Flipping it off should mark dirty.
    await boot(defaultInitial());
    const enabled = document.getElementById('weatherEnabled');
    expect(enabled.checked).toBe(true);
    enabled.checked = false;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });

  it('switching the unit radio marks dirty', async () => {
    await boot(defaultInitial());
    const f = document.querySelector('input[name="weatherUnit"][value="F"]');
    f.checked = true;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });

  it('Find populates draft from a geocoding hit', async () => {
    const mocks = await boot(defaultInitial({
      weather: { enabled: true, locationLabel: null, latitude: null, longitude: null, unit: 'C' },
    }));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          name: 'Boston', admin1: 'Massachusetts', country_code: 'US',
          latitude: 42.3601, longitude: -71.0589,
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = document.getElementById('weatherLocation');
    input.value = 'Boston';
    document.getElementById('weatherLocationSearch').click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('weatherLocationFeedback').textContent).toMatch(/Using/);
    expect(document.getElementById('saveBtn').disabled).toBe(false);

    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));
    const saved = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0])[0][SETTINGS_KEY];
    expect(saved.weather.latitude).toBeCloseTo(42.3601, 4);
    expect(saved.weather.longitude).toBeCloseTo(-71.0589, 4);
    expect(saved.weather.locationLabel).toMatch(/Boston/);
  });

  it('Find with no matches reports "Location not found" and leaves draft clean', async () => {
    await boot(defaultInitial());

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = document.getElementById('weatherLocation');
    input.value = 'Zzzzzzzzzz';
    document.getElementById('weatherLocationSearch').click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.getElementById('weatherLocationFeedback').textContent).toBe('Location not found.');
    expect(document.getElementById('saveBtn').disabled).toBe(true);
  });

  it('Find with empty input prompts to enter something', async () => {
    await boot(defaultInitial());
    document.getElementById('weatherLocation').value = '   ';
    document.getElementById('weatherLocationSearch').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('weatherLocationFeedback').textContent).toBe('Enter a city or ZIP first.');
  });

  it('clearing the location input drops lat/lon/label from the draft', async () => {
    const mocks = await boot(defaultInitial({
      weather: {
        enabled: true,
        locationLabel: 'Boston, MA, US',
        latitude: 42.36,
        longitude: -71.06,
        unit: 'C',
      },
    }));

    const input = document.getElementById('weatherLocation');
    expect(input.value).toBe('Boston, MA, US');

    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Empty input marks dirty so the user can Save the cleared state.
    expect(document.getElementById('saveBtn').disabled).toBe(false);

    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));

    const saved = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0])[0][SETTINGS_KEY];
    expect(saved.weather.latitude).toBeNull();
    expect(saved.weather.longitude).toBeNull();
    expect(saved.weather.locationLabel).toBeNull();
    expect(saved.weather.enabled).toBe(true);
  });
});

describe('options page — countdown section (v2.6.0)', () => {
  it('toggling countdownEnabled marks dirty', async () => {
    await boot(defaultInitial());
    const cb = document.getElementById('countdownEnabled');
    // default is enabled=true, flip to false
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });

  it('toggling countdownSound marks dirty', async () => {
    await boot(defaultInitial());
    const cb = document.getElementById('countdownSound');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });

  it('Save persists countdown settings', async () => {
    const mocks = await boot(defaultInitial());
    const cb = document.getElementById('countdownSound');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));
    const saved = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0])[0][SETTINGS_KEY];
    expect(saved.countdown.soundEnabled).toBe(false);
    expect(saved.countdown.enabled).toBe(true);
  });
});

describe('options page — priority hostnames (v2.8.0)', () => {
  it('renders the default list items on boot', async () => {
    await boot(defaultInitial());
    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain('mail.google.com');
  });

  it('Add button is disabled when the input is empty, enabled when filled', async () => {
    await boot(defaultInitial({ priorityHostnames: [] }));
    const input = document.getElementById('priorityAddInput');
    const addBtn = document.getElementById('priorityAddBtn');
    expect(addBtn.disabled).toBe(true);

    input.value = 'example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(addBtn.disabled).toBe(false);

    // Whitespace-only still counts as empty.
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(addBtn.disabled).toBe(true);
  });

  it('Add button returns to disabled after a successful commit', async () => {
    await boot(defaultInitial({ priorityHostnames: [] }));
    const input = document.getElementById('priorityAddInput');
    const addBtn = document.getElementById('priorityAddBtn');
    input.value = 'example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(addBtn.disabled).toBe(false);

    addBtn.click();
    expect(input.value).toBe('');
    expect(addBtn.disabled).toBe(true);
  });

  it('Add button appends a normalized hostname and marks dirty', async () => {
    const mocks = await boot(defaultInitial({ priorityHostnames: ['github.com'] }));
    mocks.storageLocal.set.mockClear();

    const input = document.getElementById('priorityAddInput');
    input.value = '  Example.COM ';
    // Real-user flow: typing fires `input` which enables the Add button;
    // programmatic `input.value =` doesn't, so dispatch it explicitly.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();

    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(2);
    expect(items[1].textContent).toContain('example.com');
    expect(input.value).toBe('');
    expect(document.getElementById('saveBtn').disabled).toBe(false);
    // Draft-only: no storage write until Save.
    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
  });

  it('Enter key on input adds the hostname (no button click)', async () => {
    await boot(defaultInitial({ priorityHostnames: [] }));
    const input = document.getElementById('priorityAddInput');
    input.value = 'wikipedia.org';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('wikipedia.org');
  });

  it('applies effectiveDomain alias (twitter.com → x.com) on add', async () => {
    await boot(defaultInitial({ priorityHostnames: [] }));
    const input = document.getElementById('priorityAddInput');
    input.value = 'twitter.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();

    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('x.com');
  });

  it('rejects duplicate add with feedback, no mutation', async () => {
    await boot(defaultInitial({ priorityHostnames: ['github.com'] }));
    const input = document.getElementById('priorityAddInput');
    input.value = 'github.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();

    expect(document.querySelectorAll('#priorityList .settings-list-item')).toHaveLength(1);
    expect(document.getElementById('priorityAddFeedback').textContent).toMatch(/already/i);
    expect(document.getElementById('saveBtn').disabled).toBe(true);
  });

  it('Enter on whitespace-only input surfaces the "enter a hostname" feedback', async () => {
    // The Add button is disabled on empty/whitespace input, so the feedback
    // path fires only from the Enter key (which bypasses the disabled check).
    await boot(defaultInitial({ priorityHostnames: ['github.com'] }));
    const input = document.getElementById('priorityAddInput');
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(document.querySelectorAll('#priorityList .settings-list-item')).toHaveLength(1);
    expect(document.getElementById('priorityAddFeedback').textContent).toMatch(/hostname/i);
  });

  it('Remove button deletes the entry and marks dirty', async () => {
    const mocks = await boot(defaultInitial({
      priorityHostnames: ['github.com', 'mail.google.com'],
    }));
    mocks.storageLocal.set.mockClear();

    const firstRemove = document.querySelector('#priorityList .settings-list-remove');
    expect(firstRemove).not.toBeNull();
    firstRemove.click();

    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('mail.google.com');
    expect(document.getElementById('saveBtn').disabled).toBe(false);
    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
  });

  it('Save commits the full priorityHostnames array to storage', async () => {
    const mocks = await boot(defaultInitial({ priorityHostnames: [] }));
    const input = document.getElementById('priorityAddInput');
    input.value = 'example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();

    mocks.storageLocal.set.mockClear();
    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));

    const call = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0]);
    expect(call[0][SETTINGS_KEY].priorityHostnames).toEqual(['example.com']);
  });

  it('toggles the empty placeholder when the list becomes empty / non-empty', async () => {
    await boot(defaultInitial({ priorityHostnames: [] }));
    const empty = document.getElementById('priorityEmpty');
    expect(empty.hasAttribute('hidden')).toBe(false);

    const input = document.getElementById('priorityAddInput');
    input.value = 'github.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();
    expect(empty.hasAttribute('hidden')).toBe(true);

    document.querySelector('#priorityList .settings-list-remove').click();
    expect(empty.hasAttribute('hidden')).toBe(false);
  });

  it('external pristine write replaces the draft and re-renders', async () => {
    const mocks = await boot(defaultInitial({ priorityHostnames: ['github.com'] }));
    mocks.fireChange({
      [SETTINGS_KEY]: {
        newValue: defaultInitial({ priorityHostnames: ['example.com', 'github.com'] }),
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('example.com');
    expect(document.getElementById('saveBtn').disabled).toBe(true);
  });

  it('external write while dirty preserves in-flight draft', async () => {
    const mocks = await boot(defaultInitial({ priorityHostnames: ['github.com'] }));
    // Make draft dirty.
    const input = document.getElementById('priorityAddInput');
    input.value = 'example.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('priorityAddBtn').click();

    mocks.fireChange({
      [SETTINGS_KEY]: {
        newValue: defaultInitial({ priorityHostnames: ['completely.different'] }),
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    // Draft still holds original + example.com; remote list didn't clobber.
    const items = document.querySelectorAll('#priorityList .settings-list-item');
    expect(items.length).toBe(2);
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });
});

describe('options page — shortcut list mutations', () => {
  it('Remove pin mutates draft, not storage; Save commits', async () => {
    const mocks = await boot(defaultInitial({
      shortcutPins: [{ url: 'https://example.com', title: 'Example' }],
    }));

    mocks.storageLocal.set.mockClear();

    const removeBtn = document.querySelector('#pinnedList .settings-list-remove');
    expect(removeBtn).not.toBeNull();
    removeBtn.click();

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(document.querySelectorAll('#pinnedList .settings-list-item')).toHaveLength(0);
    expect(document.getElementById('saveBtn').disabled).toBe(false);

    document.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 0));

    const call = mocks.storageLocal.set.mock.calls.find((c) => SETTINGS_KEY in c[0]);
    expect(call[0][SETTINGS_KEY].shortcutPins).toHaveLength(0);
  });

  it('Unhide mutates draft, not storage', async () => {
    const mocks = await boot(defaultInitial({
      shortcutHides: ['https://hidden.example.com'],
    }));

    mocks.storageLocal.set.mockClear();

    const unhideBtn = document.querySelector('#hiddenList .settings-list-remove');
    expect(unhideBtn).not.toBeNull();
    unhideBtn.click();

    expect(mocks.storageLocal.set).not.toHaveBeenCalled();
    expect(document.querySelectorAll('#hiddenList .settings-list-item')).toHaveLength(0);
    expect(document.getElementById('saveBtn').disabled).toBe(false);
  });
});
