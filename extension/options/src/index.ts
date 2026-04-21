import {
  getSettings,
  setSettings,
  onSettingsChange,
  defaultSettings,
  normalizePriorityHostnames,
  type ToutSettings,
  type ThemeMode,
  type ClockFormat,
  type Layout,
  type TemperatureUnit,
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
    priorityHostnames: [...s.priorityHostnames],
    shortcutPins: s.shortcutPins.map((p) => ({ ...p })),
    shortcutHides: [...s.shortcutHides],
    weather: { ...s.weather },
    countdown: { ...s.countdown },
  };
}

function pinsKey(pins: readonly { url: string; title: string }[]): string {
  return pins.map((p) => `${p.url}\u0000${p.title}`).join('\u0001');
}

function weatherKey(w: ToutSettings['weather']): string {
  return [
    w.enabled ? '1' : '0',
    w.unit,
    w.locationLabel ?? '',
    w.latitude ?? '',
    w.longitude ?? '',
  ].join('\u0001');
}

function countdownKey(c: ToutSettings['countdown']): string {
  return `${c.enabled ? '1' : '0'}|${c.soundEnabled ? '1' : '0'}`;
}

function isDirty(): boolean {
  return draft.theme !== baseline.theme
    || draft.clock.format !== baseline.clock.format
    || draft.layout !== baseline.layout
    || draft.priorityHostnames.join('\u0001') !== baseline.priorityHostnames.join('\u0001')
    || pinsKey(draft.shortcutPins) !== pinsKey(baseline.shortcutPins)
    || draft.shortcutHides.join('\u0001') !== baseline.shortcutHides.join('\u0001')
    || weatherKey(draft.weather) !== weatherKey(baseline.weather)
    || countdownKey(draft.countdown) !== countdownKey(baseline.countdown);
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

function renderPriorityList(): void {
  const list = document.getElementById('priorityList');
  const empty = document.getElementById('priorityEmpty');
  if (empty) empty.toggleAttribute('hidden', draft.priorityHostnames.length > 0);
  if (!list) return;
  list.replaceChildren(
    ...draft.priorityHostnames.map((hostname) => {
      const remove = el('button', {
        type: 'button',
        className: 'settings-list-remove',
      }, ['Remove']) as HTMLButtonElement;
      remove.addEventListener('click', () => {
        draft.priorityHostnames = draft.priorityHostnames.filter((h) => h !== hostname);
        renderPriorityList();
        renderDirtyState();
      });
      return el('li', { className: 'settings-list-item' }, [
        el('span', { className: 'settings-list-item-title' }, [hostname]),
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

function renderWeatherSection(): void {
  const enabled = document.getElementById('weatherEnabled') as HTMLInputElement | null;
  const location = document.getElementById('weatherLocation') as HTMLInputElement | null;
  if (enabled) enabled.checked = draft.weather.enabled;
  if (location) location.value = draft.weather.locationLabel ?? '';
  setRadioValue('weatherUnit', draft.weather.unit);
}

function renderCountdownSection(): void {
  const enabled = document.getElementById('countdownEnabled') as HTMLInputElement | null;
  const sound = document.getElementById('countdownSound') as HTMLInputElement | null;
  if (enabled) enabled.checked = draft.countdown.enabled;
  if (sound) sound.checked = draft.countdown.soundEnabled;
}

function renderForm(): void {
  setRadioValue('theme', draft.theme);
  setRadioValue('clockFormat', draft.clock.format);
  setRadioValue('layout', draft.layout);
  renderPriorityList();
  renderPinnedList();
  renderHiddenList();
  renderWeatherSection();
  renderCountdownSection();
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

function isTemperatureUnit(v: string): v is TemperatureUnit {
  return v === 'C' || v === 'F';
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

// Open-Meteo geocoding — free, no key. We only need the first result;
// the user's city name is stored verbatim in `locationLabel` for the
// popover readout, and lat/lon is what the forecast endpoint actually
// consumes.
interface GeocodingResult {
  name: string;
  admin1?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
}

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

function formatGeocodingLabel(r: GeocodingResult): string {
  const parts: string[] = [r.name];
  if (r.admin1) parts.push(r.admin1);
  if (r.country_code) parts.push(r.country_code);
  return parts.join(', ');
}

async function lookupLocation(query: string): Promise<GeocodingResult | null> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const first = Array.isArray(body?.results) && body.results.length > 0 ? body.results[0] : null;
    if (!first || typeof first.latitude !== 'number' || typeof first.longitude !== 'number') return null;
    return first as GeocodingResult;
  } catch {
    return null;
  }
}

function wirePriorityHostnames(): void {
  const input = document.getElementById('priorityAddInput') as HTMLInputElement | null;
  const addBtn = document.getElementById('priorityAddBtn') as HTMLButtonElement | null;
  const feedback = document.getElementById('priorityAddFeedback');

  const syncAddBtn = (): void => {
    if (!addBtn) return;
    addBtn.disabled = !input || input.value.trim().length === 0;
  };

  const commit = (): void => {
    if (!input) return;
    const raw = input.value;
    const normalized = normalizePriorityHostnames([raw]);
    if (normalized.length === 0) {
      if (feedback) feedback.textContent = 'Enter a hostname like github.com.';
      return;
    }
    const hostname = normalized[0];
    if (draft.priorityHostnames.includes(hostname)) {
      if (feedback) feedback.textContent = `${hostname} is already in the list.`;
      return;
    }
    draft.priorityHostnames = [...draft.priorityHostnames, hostname];
    input.value = '';
    if (feedback) feedback.textContent = `Added ${hostname}.`;
    renderPriorityList();
    renderDirtyState();
    syncAddBtn();
  };

  addBtn?.addEventListener('click', commit);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  });
  input?.addEventListener('input', () => {
    if (feedback) feedback.textContent = '';
    syncAddBtn();
  });

  syncAddBtn();
}

function wireWeather(): void {
  const enabled = document.getElementById('weatherEnabled') as HTMLInputElement | null;
  const location = document.getElementById('weatherLocation') as HTMLInputElement | null;
  const findBtn = document.getElementById('weatherLocationSearch') as HTMLButtonElement | null;
  const feedback = document.getElementById('weatherLocationFeedback');

  enabled?.addEventListener('change', () => {
    draft.weather = { ...draft.weather, enabled: enabled.checked };
    renderDirtyState();
  });

  // Free-text typing mid-edit doesn't commit anything — the user has
  // to hit Find (or Enter) to resolve new coordinates. But clearing
  // the input to empty IS a commit: it tells us the user wants no
  // location at all, so we drop lat/lon/label from the draft. Save
  // then lands a null location and the dashboard widget returns to
  // its "Set weather location" onboarding prompt.
  location?.addEventListener('input', () => {
    if (feedback) feedback.textContent = '';
    if (location.value.trim() === '' && draft.weather.latitude !== null) {
      draft.weather = {
        ...draft.weather,
        locationLabel: null,
        latitude: null,
        longitude: null,
      };
      renderDirtyState();
    }
  });

  const runLookup = async (): Promise<void> => {
    if (!location || !feedback) return;
    const query = location.value.trim();
    if (!query) {
      feedback.textContent = 'Enter a city or ZIP first.';
      return;
    }
    feedback.textContent = 'Searching\u2026';
    const hit = await lookupLocation(query);
    if (!hit) {
      feedback.textContent = 'Location not found.';
      return;
    }
    const label = formatGeocodingLabel(hit);
    draft.weather = {
      ...draft.weather,
      locationLabel: label,
      latitude: hit.latitude,
      longitude: hit.longitude,
    };
    location.value = label;
    feedback.textContent = `Using ${label}.`;
    renderDirtyState();
  };

  findBtn?.addEventListener('click', () => {
    void runLookup();
  });
  location?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void runLookup();
    }
  });

  wireRadio('weatherUnit', (value) => {
    if (isTemperatureUnit(value)) {
      draft.weather = { ...draft.weather, unit: value };
      renderDirtyState();
    }
  });
}

function wireCountdown(): void {
  const enabled = document.getElementById('countdownEnabled') as HTMLInputElement | null;
  const sound = document.getElementById('countdownSound') as HTMLInputElement | null;

  enabled?.addEventListener('change', () => {
    draft.countdown = { ...draft.countdown, enabled: enabled.checked };
    renderDirtyState();
  });
  sound?.addEventListener('change', () => {
    draft.countdown = { ...draft.countdown, soundEnabled: sound.checked };
    renderDirtyState();
  });
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

  wirePriorityHostnames();
  wireWeather();
  wireCountdown();

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
