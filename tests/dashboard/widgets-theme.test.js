// @vitest-environment jsdom
// tests/dashboard/widgets-theme.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/theme.ts — mounts the
// header moon button + native popover menu and exposes applyTheme() for
// DOM reconciliation. Handler wiring (data-action dispatch) is covered by
// handlers.test.js; this file covers structure + applyTheme semantics.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';

import { applyTheme, mountThemeToggle } from '../../extension/dashboard/src/widgets/theme.ts';

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.body.innerHTML = '<div id="slot"></div>';
});

describe('applyTheme', () => {
  it('sets data-theme="dark" on <html> for dark', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('sets data-theme="light" on <html> for light', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('removes data-theme on <html> for system', () => {
    document.documentElement.dataset.theme = 'dark';
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('is idempotent when reapplied', () => {
    applyTheme('dark');
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('mountThemeToggle', () => {
  it('appends a trigger button and a popover with three options to the slot', () => {
    const slot = document.getElementById('slot');
    mountThemeToggle(slot);

    const trigger = slot.querySelector('button.theme-toggle-btn');
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('Change theme');

    const popoverId = trigger.getAttribute('popovertarget');
    expect(popoverId).toBeTruthy();

    const popover = slot.querySelector(`#${popoverId}`);
    expect(popover).not.toBeNull();
    expect(popover.getAttribute('popover')).toBe('auto');

    const options = popover.querySelectorAll('button.theme-option');
    expect(options).toHaveLength(3);
  });

  it('each option carries a data-action that the dispatcher will recognize', () => {
    const slot = document.getElementById('slot');
    mountThemeToggle(slot);

    const actions = Array.from(
      slot.querySelectorAll('button.theme-option'),
    ).map((b) => b.dataset.action);

    expect(actions).toEqual(['set-theme-system', 'set-theme-light', 'set-theme-dark']);
  });

  it('each option has popovertargetaction="hide" so click auto-closes popover', () => {
    const slot = document.getElementById('slot');
    mountThemeToggle(slot);

    for (const btn of slot.querySelectorAll('button.theme-option')) {
      expect(btn.getAttribute('popovertargetaction')).toBe('hide');
    }
  });

  it('option labels are readable', () => {
    const slot = document.getElementById('slot');
    mountThemeToggle(slot);

    const labels = Array.from(
      slot.querySelectorAll('button.theme-option .theme-option-label'),
    ).map((s) => s.textContent);

    expect(labels).toEqual(['Follow system', 'Light', 'Dark']);
  });
});

// ─── Trigger icon tracking (v2.1.1 fix) ──────────────────────────────────────
// The trigger glyph reflects the *effective* theme, not the selected mode.
// Explicit light/dark pass through; 'system' folds through
// prefers-color-scheme. syncIcon() is called by index.ts whenever settings
// change so the glyph stays in sync.

const ICON_SUN = '\u2600\u{FE0F}';
const ICON_MOON = '\u{1F319}';

function mockPrefersDark(matches) {
  const listeners = new Set();
  window.matchMedia = (q) => ({
    matches: q === '(prefers-color-scheme: dark)' ? matches : false,
    media: q,
    addEventListener: (_t, cb) => listeners.add(cb),
    removeEventListener: (_t, cb) => listeners.delete(cb),
    dispatchEvent: () => true,
  });
}

describe('trigger icon reflects effective theme', () => {
  it('explicit light mounts the sun glyph', () => {
    mockPrefersDark(true);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'light');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_SUN);
  });

  it('explicit dark mounts the moon glyph', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'dark');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_MOON);
  });

  it('system + OS dark resolves to the moon glyph', () => {
    mockPrefersDark(true);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'system');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_MOON);
  });

  it('system + OS light resolves to the sun glyph', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'system');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_SUN);
  });

  it('syncIcon swaps the glyph after a theme change', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    const handle = mountThemeToggle(slot, 'light');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_SUN);
    handle.syncIcon('dark');
    expect(slot.querySelector('button.theme-toggle-btn').textContent).toBe(ICON_MOON);
  });
});

// ─── Popover anchoring (v2.1.1 fix) ──────────────────────────────────────────
// Native popovers default to the top-layer origin (0,0). On every open we
// compute the trigger rect and set fixed top/left so the menu appears under
// the button, right-aligned. jsdom has no layout engine so we stub
// getBoundingClientRect + offsetWidth + innerWidth.

describe('popover anchoring', () => {
  it('sets fixed coordinates under the trigger on open', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'light');

    const trigger = slot.querySelector('button.theme-toggle-btn');
    const popover = document.getElementById('taboutThemePopover');

    trigger.getBoundingClientRect = () => ({
      top: 40, left: 900, right: 936, bottom: 76, width: 36, height: 36,
    });
    Object.defineProperty(popover, 'offsetWidth', { configurable: true, value: 180 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    const openEv = new Event('toggle');
    openEv.oldState = 'closed';
    openEv.newState = 'open';
    popover.dispatchEvent(openEv);

    // Right-aligned: trigger.right (936) - popover.offsetWidth (180) = 756.
    expect(popover.style.top).toBe('84px');   // bottom 76 + gap 8
    expect(popover.style.left).toBe('756px');
  });

  it('does not reposition when the popover is closing', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'light');
    const popover = document.getElementById('taboutThemePopover');

    const closeEv = new Event('toggle');
    closeEv.oldState = 'open';
    closeEv.newState = 'closed';
    popover.dispatchEvent(closeEv);

    expect(popover.style.top).toBe('');
    expect(popover.style.left).toBe('');
  });

  it('clamps to the viewport when the trigger sits near the left edge', () => {
    mockPrefersDark(false);
    const slot = document.getElementById('slot');
    mountThemeToggle(slot, 'light');

    const trigger = slot.querySelector('button.theme-toggle-btn');
    const popover = document.getElementById('taboutThemePopover');

    trigger.getBoundingClientRect = () => ({
      top: 40, left: 0, right: 36, bottom: 76, width: 36, height: 36,
    });
    Object.defineProperty(popover, 'offsetWidth', { configurable: true, value: 180 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });

    const openEv = new Event('toggle');
    openEv.oldState = 'closed';
    openEv.newState = 'open';
    popover.dispatchEvent(openEv);

    expect(popover.style.left).toBe('8px');
  });
});
