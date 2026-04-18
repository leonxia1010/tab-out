// @vitest-environment jsdom
// tests/dashboard/widgets-settings-link.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/settings-link.ts — the
// header gear button that opens the options page. Structure + click behavior
// only; openOptionsPage is a pure chrome.runtime call with no return handling.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountSettingsLink } from '../../extension/dashboard/src/widgets/settings-link.ts';

let openOptionsPage;

beforeEach(() => {
  openOptionsPage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { openOptionsPage } });
  document.body.innerHTML = '<div id="slot"></div>';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mountSettingsLink', () => {
  it('appends a gear button to the slot', () => {
    const slot = document.getElementById('slot');
    mountSettingsLink(slot);

    const btn = slot.querySelector('button.settings-link-btn');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Open settings');
  });

  it('renders the cog icon inside the button', () => {
    const slot = document.getElementById('slot');
    mountSettingsLink(slot);

    const icon = slot.querySelector('button.settings-link-btn svg[data-icon="cog"]');
    expect(icon).not.toBeNull();
  });

  it('click invokes chrome.runtime.openOptionsPage', () => {
    const slot = document.getElementById('slot');
    mountSettingsLink(slot);

    const btn = slot.querySelector('button.settings-link-btn');
    btn.click();

    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('destroy() removes the button from the DOM', () => {
    const slot = document.getElementById('slot');
    const handle = mountSettingsLink(slot);

    handle.destroy();
    expect(slot.querySelector('button.settings-link-btn')).toBeNull();
  });

  it('swallows the click when chrome.runtime.openOptionsPage is absent', () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const slot = document.getElementById('slot');
    mountSettingsLink(slot);

    const btn = slot.querySelector('button.settings-link-btn');
    expect(() => btn.click()).not.toThrow();
  });
});
