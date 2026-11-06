// @vitest-environment jsdom
// tests/dashboard/widgets-search.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/search.ts — the
// middle-section search widget. Covers mount structure, the engine menu
// (selection, keyboard nav), Tab cycling, per-engine URL dispatch via
// chrome.tabs.update, the busy state after submit, localStorage
// persistence, and destroy cleanup.
//
// jsdom has no native popover support, so opening the menu via
// popovertarget is verified in a real browser; here the menu items are
// clicked directly (they are always in the DOM).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { mountSearch, SEARCH_ENGINE_KEY } from '../../extension/dashboard/src/widgets/search.ts';

const ORDER = ['google', 'baidu', 'xiaohongshu', 'bilibili', 'googlemaps'];

function installChrome(updateImpl) {
  const update = vi.fn(updateImpl);
  vi.stubGlobal('chrome', { tabs: { update } });
  return update;
}

function mountInSlot() {
  const slot = document.getElementById('slot');
  const handle = mountSearch(slot);
  return {
    slot,
    handle,
    form: slot.querySelector('form.search-widget'),
    input: slot.querySelector('input.search-widget-input'),
    button: slot.querySelector('button.search-widget-engine'),
    menu: slot.querySelector('.search-engine-menu'),
    option: (id) => slot.querySelector(`.search-engine-option[data-engine="${id}"]`),
  };
}

function submit(form) {
  const ev = new Event('submit', { cancelable: true });
  form.dispatchEvent(ev);
  return ev;
}

function keydown(target, key, init = {}) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mountSearch structure', () => {
  it('renders form, engine menu trigger, menu, and input', () => {
    installChrome();
    const { form, input, button, menu } = mountInSlot();

    expect(form.getAttribute('role')).toBe('search');
    expect(input.getAttribute('type')).toBe('search');
    expect(input.getAttribute('placeholder')).toBe('Search Google...');

    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('popovertarget')).toBe(menu.id);
    expect(button.dataset.engine).toBe('google');
    expect(button.querySelector('img[data-icon="google"]')).not.toBeNull();

    expect(menu.getAttribute('popover')).toBe('auto');
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll('.search-engine-option')];
    expect(items.map((i) => i.dataset.engine)).toEqual(ORDER);
    expect(items.map((i) => i.textContent)).toEqual(['Google', '百度', '小红书', 'B站', 'Google Maps']);
    items.forEach((i) => {
      expect(i.getAttribute('role')).toBe('menuitemradio');
      expect(i.getAttribute('type')).toBe('button');
      expect(i.querySelector(`img[data-icon="${i.dataset.engine}"]`)).not.toBeNull();
    });
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
  });

  it('every engine icon points at a bundled file under extension/icons/engines', () => {
    installChrome();
    const { menu } = mountInSlot();
    const dashboardDir = resolve(__dirname, '../../extension/dashboard');
    const imgs = [...menu.querySelectorAll('img.search-engine-icon')];
    expect(imgs).toHaveLength(ORDER.length);
    imgs.forEach((img) => {
      const src = img.getAttribute('src');
      expect(src).toBe(`../icons/engines/${img.dataset.icon}.png`);
      expect(existsSync(resolve(dashboardDir, src))).toBe(true);
      expect(img.getAttribute('alt')).toBe('');
    });
  });

  it('does NOT steal focus on mount', () => {
    installChrome();
    const { input } = mountInSlot();
    expect(document.activeElement).not.toBe(input);
  });

  it('destroy() removes the form and the menu', () => {
    installChrome();
    const { slot, handle } = mountInSlot();
    handle.destroy();
    expect(slot.querySelector('form.search-widget')).toBeNull();
    expect(slot.querySelector('.search-engine-menu')).toBeNull();
  });
});

describe('mountSearch engine menu', () => {
  it('picking a menu item switches engine, icon, placeholder, and checked state', () => {
    installChrome();
    const { input, button, menu, option } = mountInSlot();

    option('bilibili').click();

    expect(button.dataset.engine).toBe('bilibili');
    expect(button.querySelector('img[data-icon="bilibili"]')).not.toBeNull();
    expect(button.querySelector('img[data-icon="google"]')).toBeNull();
    expect(input.placeholder).toBe('Search Bilibili...');
    const checked = [...menu.querySelectorAll('[aria-checked="true"]')].map((i) => i.dataset.engine);
    expect(checked).toEqual(['bilibili']);
  });

  it('xiaohongshu is labelled 小红书 in the menu and RedNote in the placeholder', () => {
    installChrome();
    const { input, option } = mountInSlot();
    expect(option('xiaohongshu').textContent).toBe('小红书');
    option('xiaohongshu').click();
    expect(input.placeholder).toBe('Search RedNote...');
  });

  it('picking an item returns focus to the input', () => {
    installChrome();
    const { input, option } = mountInSlot();
    option('baidu').click();
    expect(document.activeElement).toBe(input);
  });

  it('clicking the trigger or a menu item never submits', () => {
    const update = installChrome();
    const { input, button, option } = mountInSlot();
    input.value = 'should not fire';

    button.click();
    option('xiaohongshu').click();

    expect(update).not.toHaveBeenCalled();
    expect(input.value).toBe('should not fire');
  });

  it('ArrowDown / ArrowUp / Home / End move focus between items, wrapping', () => {
    installChrome();
    const { menu, option } = mountInSlot();
    option('google').focus();

    keydown(menu, 'ArrowDown');
    expect(document.activeElement).toBe(option('baidu'));
    keydown(menu, 'End');
    expect(document.activeElement).toBe(option('googlemaps'));
    keydown(menu, 'ArrowDown');
    expect(document.activeElement).toBe(option('google'));
    keydown(menu, 'ArrowUp');
    expect(document.activeElement).toBe(option('googlemaps'));
    keydown(menu, 'Home');
    expect(document.activeElement).toBe(option('google'));
  });
});

describe('mountSearch Tab cycling', () => {
  it('Tab inside the input cycles through all engines in order and prevents default', () => {
    installChrome();
    const { input, button } = mountInSlot();

    const seen = [];
    for (let i = 0; i < ORDER.length; i++) {
      const ev = keydown(input, 'Tab');
      expect(ev.defaultPrevented).toBe(true);
      seen.push(button.dataset.engine);
    }
    expect(seen).toEqual([...ORDER.slice(1), 'google']);
  });

  it('Shift+Tab is left native so focus can leave the field', () => {
    installChrome();
    const { input, button } = mountInSlot();
    const ev = keydown(input, 'Tab', { shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(button.dataset.engine).toBe('google');
  });

  it('Tab during IME composition is not intercepted', () => {
    installChrome();
    const { input, button } = mountInSlot();
    const ev = keydown(input, 'Tab', { isComposing: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(button.dataset.engine).toBe('google');
  });
});

describe('mountSearch submit', () => {
  const CASES = [
    ['google', 'https://www.google.com/search?q=%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87'],
    ['baidu', 'https://www.baidu.com/s?wd=%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87'],
    ['xiaohongshu', 'https://www.xiaohongshu.com/search_result?keyword=%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87'],
    ['bilibili', 'https://search.bilibili.com/all?keyword=%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87'],
    ['googlemaps', 'https://www.google.com/maps/search/%E9%9C%B2%E8%90%A5%E8%A3%85%E5%A4%87'],
  ];

  it.each(CASES)('%s opens the encoded, trimmed query in the current tab', (id, url) => {
    const update = installChrome();
    const { form, input, option } = mountInSlot();
    option(id).click();
    input.value = '  露营装备  ';

    submit(form);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ url });
  });

  it('encodes reserved characters in the query', () => {
    const update = installChrome();
    const { form, input } = mountInSlot();
    input.value = 'a&b c/d?';
    submit(form);
    expect(update).toHaveBeenCalledWith({ url: 'https://www.google.com/search?q=a%26b%20c%2Fd%3F' });
  });

  it('prevents default so the form never navigates', () => {
    installChrome();
    const { form, input } = mountInSlot();
    input.value = 'anything';
    expect(submit(form).defaultPrevented).toBe(true);
  });

  it('is a no-op when the input is empty or whitespace-only', () => {
    const update = installChrome();
    const { form, input } = mountInSlot();
    input.value = '';
    submit(form);
    input.value = '   ';
    submit(form);
    expect(update).not.toHaveBeenCalled();
    expect(form.classList.contains('is-loading')).toBe(false);
  });

  it('enters a busy state: keeps the query, read-only input, aria-busy', () => {
    installChrome();
    const { form, input } = mountInSlot();
    input.value = 'camping';

    submit(form);

    expect(form.classList.contains('is-loading')).toBe(true);
    expect(form.getAttribute('aria-busy')).toBe('true');
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe('camping');
  });

  it('ignores a second submit while busy', () => {
    const update = installChrome();
    const { form, input } = mountInSlot();
    input.value = 'camping';
    submit(form);
    submit(form);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('clears the busy state when chrome.tabs.update rejects', async () => {
    installChrome(() => Promise.reject(new Error('No current window')));
    const { form, input } = mountInSlot();
    input.value = 'camping';

    submit(form);
    await Promise.resolve();
    await Promise.resolve();

    expect(form.classList.contains('is-loading')).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('camping');
  });

  it('clears the busy state when chrome.tabs.update throws synchronously', () => {
    installChrome(() => { throw new Error('boom'); });
    const { form, input } = mountInSlot();
    input.value = 'camping';

    expect(() => submit(form)).not.toThrow();
    expect(form.classList.contains('is-loading')).toBe(false);
  });

  it('swallows submit quietly without entering busy state when chrome is unavailable', () => {
    vi.stubGlobal('chrome', undefined);
    const { form, input } = mountInSlot();
    input.value = 'fallback';

    expect(() => submit(form)).not.toThrow();
    expect(form.classList.contains('is-loading')).toBe(false);
  });

  it('Esc while busy clears the busy state so the user can search again', () => {
    const update = installChrome(() => new Promise(() => {}));
    const { form, input } = mountInSlot();
    input.value = 'camping';
    submit(form);

    const ev = keydown(input, 'Escape');

    expect(ev.defaultPrevented).toBe(false);
    expect(form.classList.contains('is-loading')).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('camping');

    submit(form);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('resets to an empty, idle field when restored from the bfcache', () => {
    installChrome();
    const { form, input } = mountInSlot();
    input.value = 'camping';
    submit(form);

    const notPersisted = new Event('pageshow');
    notPersisted.persisted = false;
    window.dispatchEvent(notPersisted);
    expect(form.classList.contains('is-loading')).toBe(true);

    const restored = new Event('pageshow');
    restored.persisted = true;
    window.dispatchEvent(restored);
    expect(form.classList.contains('is-loading')).toBe(false);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe('');
  });
});

describe('mountSearch engine persistence', () => {
  it('persists the chosen engine and clears the key for google', () => {
    installChrome();
    const { option } = mountInSlot();

    option('xiaohongshu').click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBe('xiaohongshu');
    option('googlemaps').click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBe('googlemaps');
    option('google').click();
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBeNull();
  });

  it('Tab cycling persists too', () => {
    installChrome();
    const { input } = mountInSlot();
    keydown(input, 'Tab');
    expect(localStorage.getItem(SEARCH_ENGINE_KEY)).toBe('baidu');
  });

  it('restores the last-used engine on mount', () => {
    installChrome();
    localStorage.setItem(SEARCH_ENGINE_KEY, 'bilibili');
    const { input, button, option } = mountInSlot();

    expect(button.dataset.engine).toBe('bilibili');
    expect(input.placeholder).toBe('Search Bilibili...');
    expect(option('bilibili').getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to google for an unknown stored value', () => {
    installChrome();
    localStorage.setItem(SEARCH_ENGINE_KEY, 'yahoo');
    const { button } = mountInSlot();
    expect(button.dataset.engine).toBe('google');
  });

  it('survives a throwing localStorage on read and write', () => {
    installChrome();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });

    const { button, option } = mountInSlot();
    expect(button.dataset.engine).toBe('google');
    expect(() => option('baidu').click()).not.toThrow();
    expect(button.dataset.engine).toBe('baidu');
  });
});
