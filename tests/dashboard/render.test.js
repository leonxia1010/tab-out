// @vitest-environment jsdom
// tests/dashboard/render.test.js
// ─────────────────────────────────────────────────────────────────────────────
// XSS hardening tests for dashboard/src/renderers.ts.
//
// Phase 2 PR G: rewritten to ESM import the source modules directly under
// vitest's jsdom environment. Earlier PRs injected hand-written legacy IIFE
// mirrors into a self-spawned JSDOM window — those mirrors and the dual-load
// dance are gone.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';

import {
  renderDeferredItem,
  renderArchiveItem,
  renderDomainCard,
} from '../../dashboard/src/renderers.ts';

function mountResult(container, out) {
  if (out == null) return;
  if (Array.isArray(out)) {
    container.replaceChildren(...out.filter((n) => n instanceof Node));
    return;
  }
  if (out instanceof Node) {
    container.replaceChildren(out);
    return;
  }
  throw new Error(`Unexpected render return type: ${typeof out}`);
}

function makeContainer() {
  return document.createElement('div');
}

const NOW_SECONDS = Math.floor(Date.now() / 1000);

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
      deferred_at: NOW_SECONDS - 60,
    };
    mountResult(container, renderDeferredItem(item));

    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x');
  });

  it('round-trips title with &<>"\' as visible text (case 3)', () => {
    const item = {
      id: 7,
      url: 'https://example.org',
      title: `a&b<c>d"e'f`,
      deferred_at: NOW_SECONDS - 120,
    };
    mountResult(container, renderDeferredItem(item));

    expect(container.textContent).toContain(`a&b<c>d"e'f`);
    expect(container.querySelector('c')).toBeNull();
  });

  it('falls back to url when title is empty (case 6)', () => {
    const item = {
      id: 1,
      url: 'https://example.com/path',
      title: '',
      deferred_at: NOW_SECONDS,
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
      deferred_at: NOW_SECONDS,
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
      deferred_at: NOW_SECONDS,
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
      archived_at: NOW_SECONDS - 3600,
    };
    mountResult(container, renderArchiveItem(item));

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('alert(1)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderDomainCard / page chips
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

    expect(container.querySelector('script')).toBeNull();
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

    expect(container.querySelector('[onload]')).toBeNull();
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
      deferred_at: NOW_SECONDS,
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
      archived_at: NOW_SECONDS - 3600,
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
      deferred_at: NOW_SECONDS,
    };
    mountResult(container, renderDeferredItem(item));

    const link = container.querySelector('.deferred-title');
    expect(link.getAttribute('href')).toBe('https://example.com/path?q=1#hash');
  });
});
