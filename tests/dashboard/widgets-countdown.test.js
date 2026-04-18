// @vitest-environment jsdom
// tests/dashboard/widgets-countdown.test.js
// ─────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/countdown.ts — header
// countdown widget with persistence in chrome.storage.local and cross-tab
// sync via storage.onChanged. Coverage:
//   - idle/running/paused mode transitions via preset + custom input
//   - storage writes on start / pause / resume / reset
//   - alarms.create + alarms.clear coupled with the same transitions
//   - MM:SS tick updating while running
//   - completion edge (storage cleared) triggers toast + sound when
//     focused, otherwise silent (background handles the notification)
//   - applySettings disable removes the mounted widget
//   - destroy() removes DOM + listener
//   - formatCountdownMMSS pure helper

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The animations module's Web Audio + toast side effects get mocked out
// so tests don't need a jsdom AudioContext shim and we can assert on
// exactly what got called.
const toastSpy = vi.fn();
const soundSpy = vi.fn();
vi.mock('../../extension/dashboard/src/animations.ts', () => ({
  showToast: (...args) => toastSpy(...args),
  playCompletionSound: () => soundSpy(),
}));

import {
  COUNTDOWN_STORAGE_KEY,
  formatCountdownMMSS,
  mountCountdown,
  PRESET_MINUTES,
} from '../../extension/dashboard/src/widgets/countdown.ts';

function installChrome(initialState) {
  const store = new Map();
  if (initialState !== undefined) store.set(COUNTDOWN_STORAGE_KEY, initialState);
  const changeListeners = [];
  const alarmsCreate = vi.fn();
  const alarmsClear = vi.fn(async () => true);

  vi.stubGlobal('chrome', {
    runtime: {},
    alarms: {
      create: alarmsCreate,
      clear: alarmsClear,
    },
    storage: {
      local: {
        get: vi.fn(async (key) => (store.has(key) ? { [key]: store.get(key) } : {})),
        set: vi.fn(async (kv) => {
          for (const [k, v] of Object.entries(kv)) store.set(k, v);
        }),
        remove: vi.fn(async (key) => {
          store.delete(key);
        }),
      },
      onChanged: {
        addListener: vi.fn((cb) => changeListeners.push(cb)),
        removeListener: vi.fn((cb) => {
          const i = changeListeners.indexOf(cb);
          if (i >= 0) changeListeners.splice(i, 1);
        }),
      },
    },
  });

  return {
    store,
    alarmsCreate,
    alarmsClear,
    fireChange: (newValue, area = 'local') => {
      // Mirror real Chrome: set/remove mutates the mock store first so
      // subsequent storage.get() calls inside the widget see the new
      // value (or absence).
      if (newValue === undefined) store.delete(COUNTDOWN_STORAGE_KEY);
      else store.set(COUNTDOWN_STORAGE_KEY, newValue);
      for (const cb of changeListeners.slice()) {
        cb({ [COUNTDOWN_STORAGE_KEY]: { newValue } }, area);
      }
    },
  };
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  toastSpy.mockReset();
  soundSpy.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatCountdownMMSS', () => {
  it('formats whole-minute durations with :00 seconds', () => {
    expect(formatCountdownMMSS(25 * 60_000)).toBe('25:00');
    expect(formatCountdownMMSS(60_000)).toBe('01:00');
  });
  it('rounds up partial seconds (ceil) so 59.1s shows 01:00', () => {
    expect(formatCountdownMMSS(59_100)).toBe('01:00');
    expect(formatCountdownMMSS(60_500)).toBe('01:01');
  });
  it('clamps negatives to 00:00', () => {
    expect(formatCountdownMMSS(-1)).toBe('00:00');
    expect(formatCountdownMMSS(-9999)).toBe('00:00');
  });
  it('exposes the 6 preset minutes in known order', () => {
    expect([...PRESET_MINUTES]).toEqual([5, 10, 15, 25, 45, 60]);
  });
});

describe('mountCountdown — idle', () => {
  it('appends a widget button showing "Timer" when enabled', async () => {
    installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    const btn = document.querySelector('.countdown-widget');
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('countdown-idle')).toBe(true);
    const label = btn.querySelector('.countdown-widget-label');
    expect(label.textContent).toBe('Timer');
  });

  it('does NOT mount when disabled', async () => {
    installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: false, soundEnabled: true });
    await flush();
    expect(document.querySelector('.countdown-widget')).toBeNull();
  });

  it('popover body renders the 6 preset buttons + custom input', async () => {
    installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    const presets = document.querySelectorAll('.countdown-preset');
    expect(presets).toHaveLength(PRESET_MINUTES.length);
    expect(document.querySelector('.countdown-custom-input')).not.toBeNull();
    expect(document.querySelector('.countdown-start-btn')).not.toBeNull();
  });
});

describe('mountCountdown — start', () => {
  it('clicking a preset writes storage, creates the alarm, flips running', async () => {
    const env = installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    const fivePreset = Array.from(document.querySelectorAll('.countdown-preset'))
      .find((b) => b.textContent.trim() === '5 min');
    fivePreset.click();
    await flush();

    const state = env.store.get(COUNTDOWN_STORAGE_KEY);
    expect(state).toBeDefined();
    expect(state.durationMs).toBe(5 * 60_000);
    expect(state.paused).toBe(false);
    expect(env.alarmsCreate).toHaveBeenCalledTimes(1);
    const btn = document.querySelector('.countdown-widget');
    expect(btn.classList.contains('countdown-running')).toBe(true);
  });

  it('custom input starts a timer with the given minutes', async () => {
    const env = installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    const input = document.querySelector('.countdown-custom-input');
    input.value = '12';
    document.querySelector('.countdown-start-btn').click();
    await flush();

    expect(env.store.get(COUNTDOWN_STORAGE_KEY).durationMs).toBe(12 * 60_000);
  });

  it('custom input rejects non-numeric / out-of-range values silently', async () => {
    const env = installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    const input = document.querySelector('.countdown-custom-input');
    input.value = '0';
    document.querySelector('.countdown-start-btn').click();
    await flush();
    expect(env.store.get(COUNTDOWN_STORAGE_KEY)).toBeUndefined();

    input.value = 'abc';
    document.querySelector('.countdown-start-btn').click();
    await flush();
    expect(env.store.get(COUNTDOWN_STORAGE_KEY)).toBeUndefined();
  });
});

describe('mountCountdown — pause / resume / reset', () => {
  it('pause writes paused state + clears the alarm', async () => {
    const env = installChrome({
      endsAt: Date.now() + 5 * 60_000,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    const pauseBtn = Array.from(document.querySelectorAll('.countdown-popover-btn'))
      .find((b) => b.textContent === 'Pause');
    pauseBtn.click();
    await flush();

    const state = env.store.get(COUNTDOWN_STORAGE_KEY);
    expect(state.paused).toBe(true);
    expect(state.pauseRemainingMs).toBeGreaterThan(0);
    expect(env.alarmsClear).toHaveBeenCalled();
  });

  it('resume writes a fresh endsAt + re-creates the alarm', async () => {
    const env = installChrome({
      endsAt: Date.now() + 2 * 60_000,
      durationMs: 5 * 60_000,
      paused: true,
      pauseRemainingMs: 2 * 60_000,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    const resumeBtn = Array.from(document.querySelectorAll('.countdown-popover-btn'))
      .find((b) => b.textContent === 'Resume');
    resumeBtn.click();
    await flush();

    const state = env.store.get(COUNTDOWN_STORAGE_KEY);
    expect(state.paused).toBe(false);
    expect(state.endsAt).toBeGreaterThan(Date.now());
    expect(env.alarmsCreate).toHaveBeenCalled();
  });

  it('reset deletes storage + clears the alarm', async () => {
    const env = installChrome({
      endsAt: Date.now() + 5 * 60_000,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    const resetBtn = Array.from(document.querySelectorAll('.countdown-popover-btn'))
      .find((b) => b.textContent === 'Reset');
    resetBtn.click();
    await flush();

    expect(env.store.has(COUNTDOWN_STORAGE_KEY)).toBe(false);
    expect(env.alarmsClear).toHaveBeenCalled();
    expect(document.querySelector('.countdown-widget').classList.contains('countdown-idle')).toBe(true);
  });
});

describe('mountCountdown — cross-tab sync via onChanged', () => {
  it('goes from idle to running when storage is written externally', async () => {
    const env = installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    env.fireChange({
      endsAt: Date.now() + 5 * 60_000,
      durationMs: 5 * 60_000,
      paused: false,
    });
    await flush();

    expect(document.querySelector('.countdown-widget').classList.contains('countdown-running')).toBe(true);
  });

  it('goes from running to paused when storage flips externally', async () => {
    const env = installChrome({
      endsAt: Date.now() + 5 * 60_000,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    env.fireChange({
      endsAt: Date.now() + 5 * 60_000,
      durationMs: 5 * 60_000,
      paused: true,
      pauseRemainingMs: 3 * 60_000,
    });
    await flush();

    expect(document.querySelector('.countdown-widget').classList.contains('countdown-paused')).toBe(true);
  });
});

describe('mountCountdown — completion feedback', () => {
  beforeEach(() => {
    // Force the "focused" branch: document.hasFocus = true and
    // visibilityState = 'visible'. jsdom defaults hasFocus to a
    // function returning false and visibilityState to 'visible'.
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible', configurable: true,
    });
    document.hasFocus = vi.fn(() => true);
  });

  it('plays sound + toast when the timer completes while focused', async () => {
    const env = installChrome({
      endsAt: Date.now() + 100,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    env.fireChange(undefined);
    await flush();

    expect(toastSpy).toHaveBeenCalledWith('Countdown complete!');
    expect(soundSpy).toHaveBeenCalledTimes(1);
  });

  it('suppresses sound when soundEnabled is false (toast still shows)', async () => {
    const env = installChrome({
      endsAt: Date.now() + 100,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: false });
    await flush();
    await flush();

    env.fireChange(undefined);
    await flush();

    expect(toastSpy).toHaveBeenCalled();
    expect(soundSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire toast/sound on a no-op change (idle → idle)', async () => {
    const env = installChrome();
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    env.fireChange(undefined);
    await flush();

    expect(toastSpy).not.toHaveBeenCalled();
    expect(soundSpy).not.toHaveBeenCalled();
  });
});

describe('mountCountdown — lifecycle', () => {
  it('applySettings disable unmounts the widget', async () => {
    installChrome();
    const handle = mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    expect(document.querySelector('.countdown-widget')).not.toBeNull();

    handle.applySettings({ enabled: false, soundEnabled: true });
    expect(document.querySelector('.countdown-widget')).toBeNull();
  });

  it('applySettings re-enable mounts the widget again', async () => {
    installChrome();
    const handle = mountCountdown(document.getElementById('slot'), { enabled: false, soundEnabled: true });
    await flush();
    expect(document.querySelector('.countdown-widget')).toBeNull();

    handle.applySettings({ enabled: true, soundEnabled: true });
    expect(document.querySelector('.countdown-widget')).not.toBeNull();
  });

  it('destroy() detaches listener and removes DOM', async () => {
    installChrome();
    const handle = mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();

    handle.destroy();
    expect(document.querySelector('.countdown-widget')).toBeNull();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalled();
  });

  it('running state with endsAt already in the past is treated as idle on mount', async () => {
    const env = installChrome({
      endsAt: Date.now() - 60_000,
      durationMs: 5 * 60_000,
      paused: false,
    });
    mountCountdown(document.getElementById('slot'), { enabled: true, soundEnabled: true });
    await flush();
    await flush();

    expect(env.store.has(COUNTDOWN_STORAGE_KEY)).toBe(false);
    expect(document.querySelector('.countdown-widget').classList.contains('countdown-idle')).toBe(true);
  });
});
