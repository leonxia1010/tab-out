// Countdown widget — single-timer MVP in the header cluster.
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

// 25 = pomodoro, 45 = deep-work block, 60 = default meeting length.
// The 5/10/15 row covers quick reminders (stretch, tea, coffee timer).
export const PRESET_MINUTES = [5, 10, 15, 25, 45, 60] as const;
const DEFAULT_CUSTOM_MINUTES = 20;

const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"';
// Heroicons v2 outline clock.
const SVG_CLOCK = `<svg ${SVG_BASE} data-icon="clock"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;

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
  let destroyed = false;
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  let trigger: HTMLButtonElement | null = null;
  let popover: HTMLElement | null = null;
  let triggerLabel: HTMLElement | null = null;

  function buildTrigger(): HTMLButtonElement {
    triggerLabel = el('span', { className: 'countdown-widget-label' }, ['Timer']);
    return el('button', {
      type: 'button',
      className: 'countdown-widget countdown-idle',
      'aria-label': 'Countdown timer',
      popovertarget: POPOVER_ID,
    }, [
      el('span', { className: 'countdown-widget-icon', 'aria-hidden': 'true' }, [iconNode(SVG_CLOCK)]),
      triggerLabel,
    ]) as HTMLButtonElement;
  }

  function dismissPopover(): void {
    popover?.hidePopover?.();
  }

  function renderIdlePopover(): HTMLElement {
    const presetGrid = el('div', { className: 'countdown-presets' },
      PRESET_MINUTES.map((min) => {
        const b = el('button', {
          type: 'button',
          className: 'countdown-preset',
          'data-minutes': String(min),
        }, [`${min} min`]) as HTMLButtonElement;
        b.addEventListener('click', () => {
          void start(min);
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
      value: String(DEFAULT_CUSTOM_MINUTES),
      'aria-label': 'Custom minutes',
    }) as HTMLInputElement;
    const startBtn = el('button', {
      type: 'button',
      className: 'countdown-start-btn',
    }, ['Start']) as HTMLButtonElement;
    startBtn.addEventListener('click', () => {
      const val = Number(customInput.value);
      if (!Number.isFinite(val) || val < 1 || val > 600) return;
      void start(Math.floor(val));
      dismissPopover();
    });
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startBtn.click();
      }
    });

    return el('div', { className: 'countdown-popover-body' }, [
      el('div', { className: 'countdown-popover-title' }, ['Start a countdown']),
      presetGrid,
      el('div', { className: 'countdown-custom-row' }, [
        customInput,
        el('span', { className: 'countdown-custom-unit' }, ['min']),
        startBtn,
      ]),
    ]);
  }

  function renderRunningPopover(): HTMLElement {
    const pauseBtn = el('button', {
      type: 'button',
      className: 'countdown-popover-btn',
    }, ['Pause']) as HTMLButtonElement;
    pauseBtn.addEventListener('click', () => {
      void pause();
      dismissPopover();
    });
    const resetBtn = el('button', {
      type: 'button',
      className: 'countdown-popover-btn countdown-popover-btn-muted',
    }, ['Reset']) as HTMLButtonElement;
    resetBtn.addEventListener('click', () => {
      void reset();
      dismissPopover();
    });
    return el('div', { className: 'countdown-popover-body' }, [
      el('div', { className: 'countdown-popover-title' }, ['Timer running']),
      el('div', { className: 'countdown-popover-row' }, [pauseBtn, resetBtn]),
    ]);
  }

  function renderPausedPopover(): HTMLElement {
    const resumeBtn = el('button', {
      type: 'button',
      className: 'countdown-popover-btn',
    }, ['Resume']) as HTMLButtonElement;
    resumeBtn.addEventListener('click', () => {
      void resume();
      dismissPopover();
    });
    const resetBtn = el('button', {
      type: 'button',
      className: 'countdown-popover-btn countdown-popover-btn-muted',
    }, ['Reset']) as HTMLButtonElement;
    resetBtn.addEventListener('click', () => {
      void reset();
      dismissPopover();
    });
    return el('div', { className: 'countdown-popover-body' }, [
      el('div', { className: 'countdown-popover-title' }, ['Timer paused']),
      el('div', { className: 'countdown-popover-row' }, [resumeBtn, resetBtn]),
    ]);
  }

  function rebuildPopover(): void {
    if (!popover) return;
    const mode = modeFromState(state);
    let body: HTMLElement;
    if (mode === 'idle') body = renderIdlePopover();
    else if (mode === 'paused') body = renderPausedPopover();
    else body = renderRunningPopover();
    popover.replaceChildren(body);
  }

  function updateTriggerDisplay(): void {
    if (!trigger || !triggerLabel) return;
    const mode = modeFromState(state);
    trigger.classList.toggle('countdown-idle', mode === 'idle');
    trigger.classList.toggle('countdown-running', mode === 'running');
    trigger.classList.toggle('countdown-paused', mode === 'paused');

    if (!state) {
      triggerLabel.textContent = 'Timer';
      return;
    }
    const remaining = state.paused
      ? state.pauseRemainingMs ?? 0
      : Math.max(0, state.endsAt - Date.now());
    triggerLabel.textContent = formatCountdownMMSS(remaining);
  }

  function ensureTicker(): void {
    const mode = modeFromState(state);
    if (mode === 'running') {
      if (tickInterval == null) {
        tickInterval = setInterval(() => {
          if (destroyed) return;
          updateTriggerDisplay();
        }, 1000);
      }
    } else if (tickInterval != null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
  }

  function mount(): void {
    if (trigger) return;
    trigger = buildTrigger();
    popover = el('div', {
      id: POPOVER_ID,
      className: 'countdown-popover',
      popover: 'auto',
      role: 'dialog',
    }) as HTMLElement;
    container.appendChild(trigger);
    container.appendChild(popover);
    anchorPopoverTo(trigger, popover, POPOVER_GAP_PX);
    rebuildPopover();
    updateTriggerDisplay();
    ensureTicker();
  }

  function unmount(): void {
    if (tickInterval != null) {
      clearInterval(tickInterval);
      tickInterval = null;
    }
    trigger?.remove();
    popover?.remove();
    trigger = null;
    popover = null;
    triggerLabel = null;
  }

  async function start(minutes: number): Promise<void> {
    const durationMs = minutes * 60_000;
    const endsAt = Date.now() + durationMs;
    const next: CountdownState = { endsAt, durationMs, paused: false };
    await writeState(next);
    createAlarm(endsAt);
    // Optimistic local update so the trigger flips to running before the
    // onChanged round-trip. onChanged will fire and end up here again but
    // it's idempotent.
    state = next;
    rebuildPopover();
    updateTriggerDisplay();
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
    rebuildPopover();
    updateTriggerDisplay();
    ensureTicker();
  }

  async function resume(): Promise<void> {
    if (!state || !state.paused) return;
    const remaining = state.pauseRemainingMs ?? 0;
    if (remaining <= 0) {
      await reset();
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
    rebuildPopover();
    updateTriggerDisplay();
    ensureTicker();
  }

  async function reset(): Promise<void> {
    clearAlarm();
    await clearState();
    state = null;
    rebuildPopover();
    updateTriggerDisplay();
    ensureTicker();
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
    rebuildPopover();
    updateTriggerDisplay();
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
    rebuildPopover();
    updateTriggerDisplay();
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
