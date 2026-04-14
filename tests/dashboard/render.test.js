// tests/dashboard/render.test.js
// ─────────────────────────────────────────────────────────────────────────────
// XSS hardening tests for dashboard/app.js render functions.
//
// Approach: spin up a JSDOM window with runScripts:'dangerously', inject
// dom-utils.js and app.js as <script> tags, then read render functions off
// the resulting window. Designed to fail against the current string-based
// innerHTML implementation and pass after the DOM-API migration.
//
// The mountResult() helper accepts either strings (current API) or Nodes
// (post-refactor API), so the same tests apply before and after.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOM_UTILS_PATH = path.resolve(__dirname, '../../dashboard/dom-utils.js');
const UTILS_PATH = path.resolve(__dirname, '../../dashboard/utils.js');
const APP_PATH = path.resolve(__dirname, '../../dashboard/app.js');

let win;
let renderDeferredItem;
let renderArchiveItem;
let renderDomainCard;
let buildOverflowChips;
let renderPageChip;

beforeAll(() => {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><footer></footer></body></html>`,
    { runScripts: 'dangerously', url: 'http://localhost:3456/' }
  );
  win = dom.window;

  // Neutralize anything app.js's top-level calls would reach out to.
  // renderDashboard() and checkForUpdates() run on load; mock fetch so they
  // silently fail in the catch block instead of crashing the sandbox.
  win.fetch = () => Promise.reject(new Error('fetch disabled in tests'));

  const DOM_UTILS_SRC = fs.readFileSync(DOM_UTILS_PATH, 'utf8');
  const UTILS_SRC = fs.readFileSync(UTILS_PATH, 'utf8');
  const APP_SRC = fs.readFileSync(APP_PATH, 'utf8');

  const s1 = win.document.createElement('script');
  s1.textContent = DOM_UTILS_SRC;
  win.document.head.appendChild(s1);

  const sUtils = win.document.createElement('script');
  sUtils.textContent = UTILS_SRC;
  win.document.head.appendChild(sUtils);

  const s2 = win.document.createElement('script');
  s2.textContent = APP_SRC + `
    window.__tests = {
      renderDeferredItem: typeof renderDeferredItem === 'function' ? renderDeferredItem : null,
      renderArchiveItem: typeof renderArchiveItem === 'function' ? renderArchiveItem : null,
      renderDomainCard: typeof renderDomainCard === 'function' ? renderDomainCard : null,
      buildOverflowChips: typeof buildOverflowChips === 'function' ? buildOverflowChips : null,
      renderPageChip: typeof renderPageChip === 'function' ? renderPageChip : null,
    };
  `;
  win.document.head.appendChild(s2);

  ({
    renderDeferredItem,
    renderArchiveItem,
    renderDomainCard,
    buildOverflowChips,
    renderPageChip,
  } = win.__tests);
});

// Accept either string (pre-refactor), HTMLElement (post-refactor), or array.
function mountResult(container, out) {
  if (out == null) return;
  if (typeof out === 'string') {
    container.innerHTML = out;
    return;
  }
  if (Array.isArray(out)) {
    container.replaceChildren(...out.filter((n) => n instanceof win.Node));
    return;
  }
  if (out instanceof win.Node) {
    container.replaceChildren(out);
    return;
  }
  throw new Error(`Unexpected render return type: ${typeof out}`);
}

function makeContainer() {
  return win.document.createElement('div');
}

const NOW = Math.floor(Date.now() / 1000);

// ─────────────────────────────────────────────────────────────────────────────
// renderDeferredItem
// ─────────────────────────────────────────────────────────────────────────────
describe('renderDeferredItem — XSS hardening', () => {
  let container;
  beforeEach(() => { container = makeContainer(); });

  it('refuses to materialize <img onerror> from title (case 1)', () => {
    const item = {
      id: 42,
      url: 'https://example.com',
      title: '<img src=x onerror="alert(1)">',
      deferred_at: NOW - 60,
    };
    mountResult(container, renderDeferredItem(item));

    // The bug: current code does `${item.title || item.url}` into innerHTML,
    // which parses the <img> tag and produces a real element with onerror.
    expect(container.querySelector('img[onerror]')).toBeNull();
    // The literal text must still be visible to the user
    expect(container.textContent).toContain('<img src=x');
  });

  it('round-trips title with &<>"\' as visible text (case 3)', () => {
    const item = {
      id: 7,
      url: 'https://example.org',
      title: `a&b<c>d"e'f`,
      deferred_at: NOW - 120,
    };
    mountResult(container, renderDeferredItem(item));

    // textContent should include all five special chars literally
    expect(container.textContent).toContain(`a&b<c>d"e'f`);
    // No HTML elements derived from the angle brackets should exist
    expect(container.querySelector('c')).toBeNull();
  });

  it('falls back to url when title is empty (case 6)', () => {
    const item = {
      id: 1,
      url: 'https://example.com/path',
      title: '',
      deferred_at: NOW,
    };
    expect(() => {
      mountResult(container, renderDeferredItem(item));
    }).not.toThrow();
    expect(container.textContent).toContain('example.com');
  });

  it('does not crash on malformed URL (case 7)', () => {
    const item = {
      id: 2,
      url: 'not a url',
      title: 'Some title',
      deferred_at: NOW,
    };
    expect(() => {
      mountResult(container, renderDeferredItem(item));
    }).not.toThrow();
    expect(container.textContent).toContain('Some title');
  });

  it('locks data-action + data-deferred-id on dismiss button (case 8)', () => {
    const item = {
      id: 99,
      url: 'https://example.com',
      title: 'safe',
      deferred_at: NOW,
    };
    mountResult(container, renderDeferredItem(item));

    const dismiss = container.querySelector('[data-action="dismiss-deferred"]');
    expect(dismiss).not.toBeNull();
    expect(dismiss.getAttribute('data-deferred-id')).toBe('99');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderArchiveItem
// ─────────────────────────────────────────────────────────────────────────────
describe('renderArchiveItem — XSS hardening', () => {
  it('refuses to materialize <script> from title', () => {
    const container = makeContainer();
    const item = {
      url: 'https://example.com',
      title: '<script>alert(1)</script>hello',
      archived_at: NOW - 3600,
    };
    mountResult(container, renderArchiveItem(item));

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('alert(1)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderDomainCard / page chips (covers buildOverflowChips chip rendering
// via the inline copy in renderDomainCard; also exercises renderPageChip
// once extracted in commit 4).
// ─────────────────────────────────────────────────────────────────────────────
describe('renderDomainCard — chip XSS hardening', () => {
  it('strips <script> from a tab title (case 5, subset)', () => {
    const container = makeContainer();
    const group = {
      domain: 'example.com',
      tabs: [
        { url: 'https://example.com/a', title: '<script>alert(1)</script>' },
        { url: 'https://example.com/b', title: 'normal' },
      ],
    };
    mountResult(container, renderDomainCard(group, 0));

    // No executable <script> element anywhere in the subtree.
    expect(container.querySelector('script')).toBeNull();
    // The literal "<script>" characters must appear as text (chip label is
    // cleanTitle/smartTitle-cleaned, so "alert(1)" may be truncated; the
    // key XSS assertion is that the tag does not materialize as a real node).
    expect(container.textContent).toContain('<script>');
  });

  it('does not interpret " in title as attribute break (case 4)', () => {
    const container = makeContainer();
    const group = {
      domain: 'example.com',
      tabs: [
        { url: 'https://example.com', title: 'quote"injection onload=alert(1)' },
      ],
    };
    mountResult(container, renderDomainCard(group, 0));

    // XSS assertion: the double-quote must not close any attribute and
    // smuggle in an onload handler.
    expect(container.querySelector('[onload]')).toBeNull();
    // The literal quote + injection prefix is preserved as text somewhere
    // (suffixes like "(1)" may be trimmed by the chip-label cleaners).
    expect(container.textContent).toContain('quote"injection');
  });

  it('survives many tabs with mixed XSS payloads (case 2 + 5)', () => {
    const container = makeContainer();
    const group = {
      domain: 'example.com',
      tabs: Array.from({ length: 12 }, (_, i) => ({
        url: i % 2 === 0 ? 'https://example.com/' + i : 'javascript:alert(' + i + ')',
        title: i % 3 === 0
          ? '<img src=x onerror="alert(' + i + ')">'
          : 'tab ' + i,
      })),
    };
    mountResult(container, renderDomainCard(group, 0));

    expect(container.querySelectorAll('img[onerror]').length).toBe(0);
    expect(container.querySelectorAll('script').length).toBe(0);
    // javascript: URLs get sanitized by dom-utils.el() and become href="#".
    // No anchor in the subtree may carry a javascript: scheme.
    const unsafeHrefs = Array.from(container.querySelectorAll('a[href], [href]'))
      .map((a) => a.getAttribute('href'))
      .filter((h) => /^javascript:/i.test(h));
    expect(unsafeHrefs).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL scheme sanitization — javascript:/data:/vbscript: downgrade to '#'
// ─────────────────────────────────────────────────────────────────────────────
describe('href scheme sanitization', () => {
  it('downgrades javascript: URL in renderDeferredItem to "#"', () => {
    const container = makeContainer();
    const item = {
      id: 55,
      url: 'javascript:alert(document.domain)',
      title: 'evil',
      deferred_at: NOW,
    };
    mountResult(container, renderDeferredItem(item));

    const link = container.querySelector('.deferred-title');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('#');
  });

  it('downgrades data: URL in renderArchiveItem to "#"', () => {
    const container = makeContainer();
    const item = {
      url: 'data:text/html,<script>alert(1)</script>',
      title: 'evil',
      archived_at: NOW - 3600,
    };
    mountResult(container, renderArchiveItem(item));

    const link = container.querySelector('.archive-item-title');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('#');
  });

  it('preserves https: URL unchanged', () => {
    const container = makeContainer();
    const item = {
      id: 56,
      url: 'https://example.com/path?q=1#hash',
      title: 'safe',
      deferred_at: NOW,
    };
    mountResult(container, renderDeferredItem(item));

    const link = container.querySelector('.deferred-title');
    expect(link.getAttribute('href')).toBe('https://example.com/path?q=1#hash');
  });
});
