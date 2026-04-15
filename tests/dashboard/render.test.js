// @vitest-environment jsdom
// tests/dashboard/render.test.js
// ─────────────────────────────────────────────────────────────────────────────
// XSS hardening tests for extension/dashboard/src/renderers.ts.
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
  groupTabsByDomain,
  renderOpenTabsSection,
} from '../../extension/dashboard/src/renderers.ts';

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

// ─────────────────────────────────────────────────────────────────────────────
// groupTabsByDomain — bucket assignment for special schemes + subdomain merge
// ─────────────────────────────────────────────────────────────────────────────
describe('groupTabsByDomain', () => {
  function bucket(groups, domain) {
    return groups.find((g) => g.domain === domain);
  }

  it('youtube root no longer becomes a Homepages tab', () => {
    const groups = groupTabsByDomain([
      { url: 'https://www.youtube.com/' },
      { url: 'https://www.youtube.com/watch?v=abc' },
    ]);
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
    expect(bucket(groups, 'youtube.com').tabs.length).toBe(2);
    expect(bucket(groups, 'www.youtube.com')).toBeUndefined();
  });

  it('collapses youtu.be + m.youtube.com + www.youtube.com into youtube.com', () => {
    const groups = groupTabsByDomain([
      { url: 'https://youtu.be/dQw4w9WgXcQ' },
      { url: 'https://m.youtube.com/watch?v=abc' },
      { url: 'https://www.youtube.com/feed/subscriptions' },
    ]);
    expect(bucket(groups, 'youtube.com').tabs.length).toBe(3);
    expect(bucket(groups, 'youtu.be')).toBeUndefined();
    expect(bucket(groups, 'm.youtube.com')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('collapses twitter.com + www.x.com into x.com', () => {
    const groups = groupTabsByDomain([
      { url: 'https://twitter.com/elonmusk' },
      { url: 'https://www.x.com/jack' },
      { url: 'https://x.com/tim_cook' },
    ]);
    expect(bucket(groups, 'x.com').tabs.length).toBe(3);
    expect(bucket(groups, 'twitter.com')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('twitter.com/home lands in Homepages just like x.com/home', () => {
    const groups = groupTabsByDomain([
      { url: 'https://twitter.com/home' },
      { url: 'https://x.com/home' },
    ]);
    expect(bucket(groups, '__landing-pages__').tabs.length).toBe(2);
    expect(bucket(groups, 'x.com')).toBeUndefined();
  });

  it('collapses tmall.com + taobao subdomains into taobao.com (Alibaba ecommerce)', () => {
    const groups = groupTabsByDomain([
      { url: 'https://tmall.com/item/1' },
      { url: 'https://detail.tmall.com/item/2' },
      { url: 'https://item.taobao.com/3' },
      { url: 'https://s.taobao.com/search?q=book' },
    ]);
    expect(bucket(groups, 'taobao.com').tabs.length).toBe(4);
    expect(bucket(groups, 'tmall.com')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('collapses jd.hk + 360buy.com into jd.com', () => {
    const groups = groupTabsByDomain([
      { url: 'https://jd.hk/product/1' },
      { url: 'https://360buy.com/' },
      { url: 'https://item.jd.com/100.html' },
    ]);
    expect(bucket(groups, 'jd.com').tabs.length).toBe(3);
    expect(bucket(groups, 'jd.hk')).toBeUndefined();
    expect(bucket(groups, '360buy.com')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('collapses regional amazon.* storefronts into amazon.com', () => {
    const groups = groupTabsByDomain([
      { url: 'https://amazon.co.jp/dp/abc' },
      { url: 'https://amazon.de/dp/def' },
      { url: 'https://amazon.co.uk/dp/ghi' },
      { url: 'https://amazon.fr/dp/mno' },
      { url: 'https://amazon.cn/dp/pqr' },
      { url: 'https://www.amazon.com/dp/jkl' },
    ]);
    expect(bucket(groups, 'amazon.com').tabs.length).toBe(6);
    expect(bucket(groups, 'amazon.co.jp')).toBeUndefined();
    expect(bucket(groups, 'amazon.de')).toBeUndefined();
    expect(bucket(groups, 'amazon.fr')).toBeUndefined();
    expect(bucket(groups, 'amazon.cn')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('collapses fb.com + fb.me + m.facebook.com into facebook.com', () => {
    const groups = groupTabsByDomain([
      { url: 'https://fb.com/zuck' },
      { url: 'https://fb.me/share/abc' },
      { url: 'https://m.facebook.com/home.php' },
      { url: 'https://www.facebook.com/me' },
    ]);
    expect(bucket(groups, 'facebook.com').tabs.length).toBe(4);
    expect(bucket(groups, 'fb.com')).toBeUndefined();
    expect(bucket(groups, 'fb.me')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('does NOT collapse unrelated lookalikes (costco stays out of amazon; qianniu stays out of taobao)', () => {
    const groups = groupTabsByDomain([
      { url: 'https://costco.com/item' },
      { url: 'https://qianniu.taobao.com/admin' },
      { url: 'https://www.amazon.com/dp/abc' },
      { url: 'https://www.taobao.com/' },
    ]);
    expect(bucket(groups, 'costco.com').tabs.length).toBe(1);
    expect(bucket(groups, 'qianniu.taobao.com').tabs.length).toBe(1);
    expect(bucket(groups, 'amazon.com').tabs.length).toBe(1);
    expect(bucket(groups, 'taobao.com').tabs.length).toBe(1);
  });

  it('still treats github root as a Homepages tab', () => {
    const groups = groupTabsByDomain([
      { url: 'https://github.com/' },
      { url: 'https://github.com/owner/repo' },
    ]);
    expect(bucket(groups, '__landing-pages__').tabs.length).toBe(1);
    expect(bucket(groups, 'github.com').tabs.length).toBe(1);
  });

  it('collapses bilibili subdomains + b23.tv short link into one card', () => {
    const groups = groupTabsByDomain([
      { url: 'https://www.bilibili.com/video/BV1' },
      { url: 'https://search.bilibili.com/all?keyword=test' },
      { url: 'https://bilibili.com/' },
      { url: 'https://b23.tv/abc123' },
      { url: 'https://m.bilibili.com/video/BV2' },
    ]);
    expect(bucket(groups, 'bilibili.com').tabs.length).toBe(5);
    expect(bucket(groups, 'search.bilibili.com')).toBeUndefined();
    expect(bucket(groups, 'www.bilibili.com')).toBeUndefined();
    expect(bucket(groups, 'b23.tv')).toBeUndefined();
    expect(bucket(groups, 'm.bilibili.com')).toBeUndefined();
    expect(bucket(groups, '__landing-pages__')).toBeUndefined();
  });

  it('does NOT fold fakebilibili.com into bilibili (prefix-only match is forbidden)', () => {
    const groups = groupTabsByDomain([
      { url: 'https://fakebilibili.com/phish' },
      { url: 'https://www.bilibili.com/video/BV1' },
    ]);
    expect(bucket(groups, 'fakebilibili.com').tabs.length).toBe(1);
    expect(bucket(groups, 'bilibili.com').tabs.length).toBe(1);
  });

  it('does NOT collapse google subdomains (Docs / Drive stay separate)', () => {
    const groups = groupTabsByDomain([
      { url: 'https://docs.google.com/document/d/1' },
      { url: 'https://drive.google.com/drive/folders/abc' },
    ]);
    expect(bucket(groups, 'docs.google.com').tabs.length).toBe(1);
    expect(bucket(groups, 'drive.google.com').tabs.length).toBe(1);
    expect(bucket(groups, 'google.com')).toBeUndefined();
  });

  it('groups all chrome:// pages into __chrome-internal__', () => {
    const groups = groupTabsByDomain([
      { url: 'chrome://settings/' },
      { url: 'chrome://extensions/' },
      { url: 'chrome://history/' },
    ]);
    expect(bucket(groups, '__chrome-internal__').tabs.length).toBe(3);
  });

  it('groups all chrome-extension:// pages into __extensions__', () => {
    const groups = groupTabsByDomain([
      { url: 'chrome-extension://abc/popup.html' },
      { url: 'chrome-extension://def/options.html' },
    ]);
    expect(bucket(groups, '__extensions__').tabs.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderOpenTabsSection — empty-state behaviour
//
// Regression for the "refresh while Tab Out is the only open tab erases the
// inbox-zero empty state" bug. The old implementation hid the whole section
// when sortedGroups was empty, so the affirmation disappeared on every
// reload even though the user genuinely had zero non-TabOut tabs.
// ─────────────────────────────────────────────────────────────────────────────
describe('renderOpenTabsSection — empty state', () => {
  function setupDashboardDOM() {
    document.body.innerHTML = `
      <div class="active-section" id="openTabsSection" style="display:none">
        <header>
          <h2 id="openTabsSectionTitle">Right now</h2>
          <div class="section-count" id="openTabsSectionCount"></div>
        </header>
        <div class="domains" id="openTabsDomains"></div>
      </div>
    `;
  }

  beforeEach(setupDashboardDOM);

  it('keeps the section visible and paints inbox-zero markup when no groups', () => {
    renderOpenTabsSection([], 0);

    const section = document.getElementById('openTabsSection');
    const domains = document.getElementById('openTabsDomains');
    const count = document.getElementById('openTabsSectionCount');

    expect(section.style.display).toBe('block');
    expect(domains.querySelector('.domains-empty-state')).not.toBeNull();
    expect(domains.textContent).toMatch(/Inbox zero/);
    expect(count.textContent).toBe('0 domains');
  });

  it('renders domain cards and shows the section when groups are present', () => {
    const groups = groupTabsByDomain([
      { url: 'https://github.com/a', title: 'A' },
      { url: 'https://github.com/b', title: 'B' },
    ]);
    renderOpenTabsSection(groups, 2);

    const section = document.getElementById('openTabsSection');
    const domains = document.getElementById('openTabsDomains');

    expect(section.style.display).toBe('block');
    expect(domains.querySelector('.domain-card')).not.toBeNull();
    expect(domains.querySelector('.domains-empty-state')).toBeNull();
  });

  it('switches from populated to empty state on re-render (close-all flow)', () => {
    const groups = groupTabsByDomain([
      { url: 'https://x.test/a', title: 'A' },
    ]);
    renderOpenTabsSection(groups, 1);
    expect(document.querySelector('.domain-card')).not.toBeNull();

    // User closed every tab → next render pass gets empty groups.
    renderOpenTabsSection([], 0);
    const section = document.getElementById('openTabsSection');
    expect(section.style.display).toBe('block');
    expect(document.querySelector('.domain-card')).toBeNull();
    expect(document.querySelector('.domains-empty-state')).not.toBeNull();
  });
});
