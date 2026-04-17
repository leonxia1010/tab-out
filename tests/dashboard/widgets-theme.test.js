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
