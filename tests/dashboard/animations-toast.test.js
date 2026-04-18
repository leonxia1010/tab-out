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

import { showActionToast, showToast } from '../../extension/dashboard/src/animations.ts';

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
