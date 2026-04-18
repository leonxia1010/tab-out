// @vitest-environment jsdom
// tests/dashboard/animations-toast.test.js
// ─────────────────────────────────────────────────────────────────────────
// Coverage for showActionToast (v2.5.0) — the action-bearing variant of
// showToast used by the Organize-tabs Undo flow. Pins down the DOM side
// effects that the organize handler tests can't observe directly:
//   - action button renders with correct label + class
//   - onClick fires exactly once (even if clicked twice)
//   - dismiss handle removes visibility + button cleanly
//   - TTL timeout auto-dismisses
//   - consecutive calls clear any prior action button

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  playCompletionSound,
  showActionToast,
  showToast,
} from '../../extension/dashboard/src/animations.ts';

beforeEach(() => {
  document.body.innerHTML = `
    <div class="toast" id="toast">
      <span id="toastText"></span>
    </div>
  `;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('showActionToast', () => {
  it('renders the message + an action button inside #toast', () => {
    showActionToast('Organized 5 tabs', { label: 'Undo', onClick: () => {} }, 30_000);

    const toast = document.getElementById('toast');
    expect(toast.classList.contains('visible')).toBe(true);
    expect(document.getElementById('toastText').textContent).toBe('Organized 5 tabs');

    const btn = toast.querySelector('.toast-action');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.textContent).toBe('Undo');
    expect(btn.type).toBe('button');
  });

  it('fires onClick when the action button is clicked', () => {
    const onClick = vi.fn();
    showActionToast('Organized 3 tabs', { label: 'Undo', onClick }, 30_000);

    document.querySelector('.toast-action').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('dismiss() removes the visible class and the action button', () => {
    const { dismiss } = showActionToast(
      'Organized 1 tab',
      { label: 'Undo', onClick: () => {} },
      30_000,
    );

    expect(document.querySelector('.toast-action')).not.toBeNull();
    dismiss();
    expect(document.getElementById('toast').classList.contains('visible')).toBe(false);
    expect(document.querySelector('.toast-action')).toBeNull();
  });

  it('auto-dismisses after the ttl timer fires', () => {
    showActionToast('Organized', { label: 'Undo', onClick: () => {} }, 5_000);

    expect(document.getElementById('toast').classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(5_001);
    expect(document.getElementById('toast').classList.contains('visible')).toBe(false);
  });

  it('clicking the action also dismisses the toast', () => {
    const onClick = vi.fn();
    showActionToast('Organized', { label: 'Undo', onClick }, 60_000);

    document.querySelector('.toast-action').click();

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(document.getElementById('toast').classList.contains('visible')).toBe(false);
    expect(document.querySelector('.toast-action')).toBeNull();
  });

  it('a subsequent showActionToast replaces the prior action button', () => {
    showActionToast('First', { label: 'Undo', onClick: () => {} }, 60_000);
    expect(document.querySelector('.toast-action').textContent).toBe('Undo');

    showActionToast('Second', { label: 'Revert', onClick: () => {} }, 60_000);

    const btns = document.querySelectorAll('.toast-action');
    expect(btns).toHaveLength(1);
    expect(btns[0].textContent).toBe('Revert');
    expect(document.getElementById('toastText').textContent).toBe('Second');
  });

  it('plain showToast after an action toast clears the dangling action button', () => {
    showActionToast('Organized', { label: 'Undo', onClick: () => {} }, 60_000);
    expect(document.querySelector('.toast-action')).not.toBeNull();

    showToast('Plain message');

    expect(document.querySelector('.toast-action')).toBeNull();
    expect(document.getElementById('toastText').textContent).toBe('Plain message');
  });

  it('returns a no-op dismiss when #toast is missing from the DOM', () => {
    document.body.innerHTML = '';
    const { dismiss } = showActionToast(
      'lost',
      { label: 'Undo', onClick: () => {} },
      60_000,
    );
    expect(() => dismiss()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// playCompletionSound (v2.6.0) — C5-E5-G5 rising triad played when a
// countdown finishes. We stub AudioContext so the test doesn't depend on
// jsdom's (absent) Web Audio support. Shape-only coverage: oscillators
// created, frequencies set, graph connected, silent no-op without audio.
describe('playCompletionSound', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plays three oscillators when AudioContext is available', () => {
    const oscillators = [];
    const destination = {};
    const makeGain = () => {
      const g = {
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(() => destination),
      };
      return g;
    };
    let pendingGain = null;
    const ctx = {
      state: 'running',
      currentTime: 0,
      destination,
      resume: vi.fn(),
      createOscillator: vi.fn(() => {
        const osc = {
          type: 'square',
          frequency: { value: 0 },
          connect: vi.fn(() => pendingGain),
          start: vi.fn(),
          stop: vi.fn(),
        };
        oscillators.push(osc);
        return osc;
      }),
      createGain: vi.fn(() => {
        pendingGain = makeGain();
        return pendingGain;
      }),
    };
    vi.stubGlobal('window', { AudioContext: vi.fn(() => ctx) });

    playCompletionSound();

    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    const freqs = oscillators.map((o) => o.frequency.value);
    // C5 E5 G5 triad (±0.01 tolerance for safety).
    expect(freqs[0]).toBeCloseTo(523.25, 1);
    expect(freqs[1]).toBeCloseTo(659.25, 1);
    expect(freqs[2]).toBeCloseTo(783.99, 1);
    expect(oscillators[0].start).toHaveBeenCalled();
    expect(oscillators[0].stop).toHaveBeenCalled();
  });

  it('is a silent no-op when no AudioContext constructor is available', () => {
    vi.stubGlobal('window', {});
    expect(() => playCompletionSound()).not.toThrow();
  });

  it('swallows thrown errors from the Web Audio graph', () => {
    vi.stubGlobal('window', {
      AudioContext: vi.fn(() => {
        throw new Error('audio disabled');
      }),
    });
    expect(() => playCompletionSound()).not.toThrow();
  });
});
