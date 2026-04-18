// Countdown widget — inline `MM:SS ▶ ↺` in the header cluster.
//
// Trigger layout: three elements side by side inside one pill:
//   1. time display  (MM:SS, click to open preset picker)
//   2. play/pause    (▶ in idle+paused, ⏸ in running)
//   3. reset         (↺, always shown)
//
// State lives in chrome.storage.local['tabout:countdownState']:
//
//   null                         idle (no active timer)
//   { endsAt, durationMs, paused: false }
//                                running — DOM reads endsAt - now each tick
//   { endsAt, durationMs, paused: true, pauseRemainingMs }
//                                paused — DOM freezes on pauseRemainingMs
//
// Why storage as source of truth:
//   - pages reload: new-tab open mid-countdown shouldn't reset the timer
//   - cross-tab: two dashboards must agree on the same timer
//   - SW autonomy: alarm fires whether or not any tab is open
//
// Completion fan-out:
//   - background.js handleCountdownComplete deletes state + fires
//     chrome.notifications (visible regardless of tab focus)
//   - the widget's storage.onChanged listener sees the removal, returns
//     to idle, and (when focused + soundEnabled) plays the completion
//     sound + shows a toast. Only the focused tab does this so multi-
//     tab users don't get stacked toasts.

import { anchorPopoverTo, el, iconNode } from '../../../shared/dist/dom-utils.js';
import type { CountdownSettings } from '../../../shared/dist/settings.js';
import { playCompletionSound, showToast } from '../animations.js';

export interface CountdownHandle {
  destroy(): void;
  applySettings(next: CountdownSettings): void;
}

export interface CountdownState {
  endsAt: number;
  durationMs: number;
  paused: boolean;
  pauseRemainingMs?: number;
}

export const COUNTDOWN_STORAGE_KEY = 'tabout:countdownState';
const COUNTDOWN_ALARM = 'tabout-countdown-complete';
const POPOVER_ID = 'taboutCountdownPopover';
const POPOVER_GAP_PX = 8;

// 10 min is a good default: long enough for a focused stretch /
// coffee-timer use, short enough that hitting ▶ without thinking
// doesn't trap you for 25 minutes. Users can pick a different preset
// via the time-click popover (25 = pomodoro, 45 = deep-work block,
// 60 = default meeting length, 5/15 = quick reminders).
export const DEFAULT_MINUTES = 10;
export const PRESET_MINUTES = [5, 10, 15, 25, 45, 60] as const;

const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"';
const SVG_STROKE_BASE = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
// Filled glyphs for play/pause so they read as affordances at 14px,
// matching the visual weight of the reset chevron below.
const SVG_PLAY = `<svg ${SVG_BASE} data-icon="play"><path d="M8 5.5v13a1 1 0 0 0 1.53.848l11-6.5a1 1 0 0 0 0-1.696l-11-6.5A1 1 0 0 0 8 5.5Z"/></svg>`;
const SVG_PAUSE = `<svg ${SVG_BASE} data-icon="pause"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>`;
// Circular-arrow reset (counter-clockwise) — Heroicons v2 arrow-path
// family, simplified to a single stroke.
const SVG_RESET = `<svg ${SVG_STROKE_BASE} data-icon="reset"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4 4v4h4"/></svg>`;

export function formatCountdownMMSS(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function safeReadState(raw: unknown): CountdownState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<CountdownState>;
  if (typeof r.endsAt !== 'number' || !Number.isFinite(r.endsAt)) return null;
  if (typeof r.durationMs !== 'number' || r.durationMs <= 0) return null;
  return {
    endsAt: r.endsAt,
    durationMs: r.durationMs,
    paused: r.paused === true,
    pauseRemainingMs:
      typeof r.pauseRemainingMs === 'number' && r.pauseRemainingMs > 0
        ? r.pauseRemainingMs
        : undefined,
  };
}

async function readState(): Promise<CountdownState | null> {
  try {
    const r = await chrome.storage.local.get(COUNTDOWN_STORAGE_KEY);
    return safeReadState((r as Record<string, unknown>)[COUNTDOWN_STORAGE_KEY]);
  } catch {
    return null;
  }
}

async function writeState(state: CountdownState): Promise<void> {
  try {
    await chrome.storage.local.set({ [COUNTDOWN_STORAGE_KEY]: state });
  } catch {
    // Storage unavailable — the widget will simply stay in sync with
    // whatever onChanged reports; we don't retry.
  }
}

async function clearState(): Promise<void> {
  try {
    await chrome.storage.local.remove(COUNTDOWN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function createAlarm(when: number): void {
  try {
    chrome.alarms?.create?.(COUNTDOWN_ALARM, { when });
  } catch {
    // ignore
  }
}

function clearAlarm(): void {
  try {
    chrome.alarms?.clear?.(COUNTDOWN_ALARM);
  } catch {
    // ignore
  }
}

type Mode = 'idle' | 'running' | 'paused';

function modeFromState(state: CountdownState | null): Mode {
  if (!state) return 'idle';
  return state.paused ? 'paused' : 'running';
}

export function mountCountdown(
  container: HTMLElement,
  initialSettings: CountdownSettings,
): CountdownHandle {
  let settings: CountdownSettings = initialSettings;
  let state: CountdownState | null = null;
  // Last-used duration in the current session. Reset to DEFAULT_MINUTES
  // on destroy; intentionally not persisted — the default-10 hint is
  // that "open Tab Out, hit play, get a 10-min timer" is the baseline
  // experience and lingering 45-min picks would erode it.
  let selectedMinutes: number = DEFAULT_MINUTES;
  let destroyed = false;
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  let widget: HTMLElement | null = null;
  let timeBtn: HTMLButtonElement | null = null;
  let playBtn: HTMLButtonElement | null = null;
  let resetBtn: HTMLButtonElement | null = null;
  let popover: HTMLElement | null = null;

  function buildTrigger(): HTMLElement {
    timeBtn = el('button', {
      type: 'button',
      className: 'countdown-time-btn',
      'aria-label': 'Countdown duration',
      popovertarget: POPOVER_ID,
    }, ['00:00']) as HTMLButtonElement;

    playBtn = el('button', {
      type: 'button',
      className: 'countdown-icon-btn',
      'aria-label': 'Start',
    }, [iconNode(SVG_PLAY)]) as HTMLButtonElement;
    playBtn.addEventListener('click', () => { void togglePlay(); });

    resetBtn = el('button', {
      type: 'button',
      className: 'countdown-icon-btn countdown-icon-btn-muted',
      'aria-label': 'Reset',
    }, [iconNode(SVG_RESET)]) as HTMLButtonElement;
    resetBtn.addEventListener('click', () => { void resetTimer(); });

    return el('div', {
      className: 'countdown-widget countdown-idle',
    }, [timeBtn, playBtn, resetBtn]);
  }

  function dismissPopover(): void {
    popover?.hidePopover?.();
  }

  function buildPopover(): HTMLElement {
    const presetGrid = el('div', { className: 'countdown-presets' },
      PRESET_MINUTES.map((min) => {
        const b = el('button', {
          type: 'button',
          className: 'countdown-preset',
          'data-minutes': String(min),
        }, [`${min} min`]) as HTMLButtonElement;
        b.addEventListener('click', () => {
          selectedMinutes = min;
          updateTimeDisplay();
          dismissPopover();
        });
        return b;
      }),
    );

    const customInput = el('input', {
      type: 'number',
      className: 'countdown-custom-input',
      min: '1',
      max: '600',
      value: String(selectedMinutes),
      'aria-label': 'Custom minutes',
    }) as HTMLInputElement;
    const applyCustom = (): void => {
      const val = Number(customInput.value);
      if (!Number.isFinite(val) || val < 1 || val > 600) return;
      selectedMinutes = Math.floor(val);
      updateTimeDisplay();
      dismissPopover();
    };
    const applyBtn = el('button', {
      type: 'button',
      className: 'countdown-custom-apply',
    }, ['Set']) as HTMLButtonElement;
    applyBtn.addEventListener('click', applyCustom);
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyCustom();
      }
    });

    return el('div', {
      id: POPOVER_ID,
      className: 'countdown-popover',
      popover: 'auto',
      role: 'dialog',
    }, [
      el('div', { className: 'countdown-popover-title' }, ['Countdown duration']),
      presetGrid,
      el('div', { className: 'countdown-custom-row' }, [
        customInput,
        el('span', { className: 'countdown-custom-unit' }, ['min']),
        applyBtn,
      ]),
    ]) as HTMLElement;
  }

  function updateTimeDisplay(): void {
    if (!timeBtn) return;
    if (!state) {
      timeBtn.textContent = formatCountdownMMSS(selectedMinutes * 60_000);
      return;
    }
    const remaining = state.paused
      ? state.pauseRemainingMs ?? 0
      : Math.max(0, state.endsAt - Date.now());
    timeBtn.textContent = formatCountdownMMSS(remaining);
  }

  function updateButtons(): void {
    if (!widget || !playBtn || !timeBtn) return;
    const mode = modeFromState(state);
    widget.classList.toggle('countdown-idle', mode === 'idle');
    widget.classList.toggle('countdown-running', mode === 'running');
    widget.classList.toggle('countdown-paused', mode === 'paused');

    // Popover is only useful in idle mode — picking a new duration
    // mid-timer would just be confusing. Disable the trigger in
    // running/paused so clicking the time doesn't open the picker.
    const isIdle = mode === 'idle';
    timeBtn.disabled = !isIdle;
    if (isIdle) {
      timeBtn.setAttribute('popovertarget', POPOVER_ID);
    } else {
      timeBtn.removeAttribute('popovertarget');
    }

    const playingNow = mode === 'running';
    playBtn.replaceChildren(iconNode(playingNow ? SVG_PAUSE : SVG_PLAY));
    playBtn.setAttribute('aria-label', playingNow ? 'Pause' : mode === 'paused' ? 'Resume' : 'Start');
  }

  function render(): void {
    updateTimeDisplay();
    updateButtons();
  }

  function ensureTicker(): void {
    const mode = modeFromState(state);
    if (mode === 'running') {
      if (tickInterval == null) {
        tickInterval = setInterval(() => {
          if (destroyed) return;
          updateTimeDisplay();
        }, 1000);
      }
    } else if (tickInterval != null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function mount(): void {
    if (widget) return;
    widget = buildTrigger();
    popover = buildPopover();
    container.appendChild(widget);
    container.appendChild(popover);
    if (timeBtn) anchorPopoverTo(timeBtn, popover, POPOVER_GAP_PX);
    render();
    ensureTicker();
  }

  function unmount(): void {
    if (tickInterval != null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    widget?.remove();
    popover?.remove();
    widget = null;
    timeBtn = null;
    playBtn = null;
    resetBtn = null;
    popover = null;
  }

  async function start(minutes: number): Promise<void> {
    const durationMs = minutes * 60_000;
    const endsAt = Date.now() + durationMs;
    const next: CountdownState = { endsAt, durationMs, paused: false };
    await writeState(next);
    createAlarm(endsAt);
    // Optimistic local update so the trigger flips to running before
    // onChanged round-trips. onChanged will fire and end up here again
    // but the render is idempotent.
    state = next;
    render();
    ensureTicker();
  }

  async function pause(): Promise<void> {
    if (!state || state.paused) return;
    const remaining = Math.max(0, state.endsAt - Date.now());
    const next: CountdownState = {
      endsAt: state.endsAt,
      durationMs: state.durationMs,
      paused: true,
      pauseRemainingMs: remaining,
    };
    await writeState(next);
    clearAlarm();
    state = next;
    render();
    ensureTicker();
  }

  async function resume(): Promise<void> {
    if (!state || !state.paused) return;
    const remaining = state.pauseRemainingMs ?? 0;
    if (remaining <= 0) {
      await resetTimer();
      return;
    }
    const endsAt = Date.now() + remaining;
    const next: CountdownState = {
      endsAt,
      durationMs: state.durationMs,
      paused: false,
    };
    await writeState(next);
    createAlarm(endsAt);
    state = next;
    render();
    ensureTicker();
  }

  async function resetTimer(): Promise<void> {
    if (state) {
      clearAlarm();
      await clearState();
      state = null;
    } else if (selectedMinutes !== DEFAULT_MINUTES) {
      // idle + user-picked a longer duration → snap back to the 10-min
      // default (matches what a reset would mean if they'd never picked
      // a different preset).
      selectedMinutes = DEFAULT_MINUTES;
    }
    render();
    ensureTicker();
  }

  async function togglePlay(): Promise<void> {
    const mode = modeFromState(state);
    if (mode === 'running') await pause();
    else if (mode === 'paused') await resume();
    else await start(selectedMinutes);
  }

  // onChanged drives every cross-source state transition: completion
  // from background, or a twin dashboard tab pausing/starting. The
  // widget's own writes also bounce back through this listener, which
  // is fine — the UI render is idempotent.
  function handleStorageChange(
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void {
    if (destroyed) return;
    if (area !== 'local' || !(COUNTDOWN_STORAGE_KEY in changes)) return;
    const entry = changes[COUNTDOWN_STORAGE_KEY];
    const prevState = state;
    const nextState = safeReadState(entry.newValue);
    state = nextState;
    render();
    ensureTicker();

    // Completion edge: storage transitioned running → cleared. Only the
    // focused tab does the user-feedback (toast + sound) so multi-tab
    // users don't get stacked effects; chrome.notifications handles the
    // cross-tab case.
    const wasActive = prevState !== null;
    const isCleared = nextState === null;
    if (wasActive && isCleared) {
      const visible = typeof document !== 'undefined'
        && document.visibilityState === 'visible'
        && typeof document.hasFocus === 'function'
        && document.hasFocus();
      if (visible) {
        showToast('Countdown complete!');
        if (settings.soundEnabled) playCompletionSound();
      }
    }
  }
  chrome.storage.onChanged.addListener(handleStorageChange);

  // Initial hydration — mount only if the user has the widget enabled,
  // then read any in-flight state (surviving reload) and render it.
  void (async () => {
    if (destroyed) return;
    if (settings.enabled) mount();
    state = await readState();
    // Paused-past-expiry safety: if a tab that was mid-countdown got
    // suspended and its `endsAt` has already slipped past, don't keep
    // rendering "00:00" forever — clear state and let the alarm (if
    // still pending) be a no-op.
    if (state && !state.paused && state.endsAt < Date.now()) {
      await clearState();
      state = null;
    }
    render();
    ensureTicker();
  })();

  return {
    destroy(): void {
      destroyed = true;
      chrome.storage.onChanged.removeListener(handleStorageChange);
      unmount();
    },
    applySettings(next: CountdownSettings): void {
      if (destroyed) return;
      const prev = settings;
      settings = next;
      if (!next.enabled && prev.enabled) {
        // Disable: remove from header but keep any running state so
        // re-enabling resumes right where we left off.
        unmount();
      } else if (next.enabled && !prev.enabled) {
        mount();
      }
    },
  };
}
