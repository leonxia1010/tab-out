// tests/dashboard/utils.test.js
//
// Pure-function tests for extension/dashboard/src/utils.ts (Phase 2 PR B). Node env,
// direct ESM import of the TS source — vitest transpiles on the fly.
//
// Coverage goal: the helpers that Phase 0 couldn't reach because they were
// trapped inside the app.js god file.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  timeAgo,
  getGreeting,
  getDateDisplay,
  capitalize,
  friendlyDomain,
  stripTitleNoise,
  cleanTitle,
  smartTitle,
  getRealTabs,
  getOpenTabsForMission,
  countOpenTabsForMission,
} from '../../extension/dashboard/src/utils.ts';

// ─────────────────────────────────────────────────────────────────────────────
// timeAgo — clock math, lots of branches per minute/hour/day
// ─────────────────────────────────────────────────────────────────────────────
describe('timeAgo', () => {
  afterEach(() => vi.useRealTimers());

  it('returns "" for null / undefined / empty input', () => {
    expect(timeAgo(null)).toBe('');
    expect(timeAgo(undefined)).toBe('');
    expect(timeAgo('')).toBe('');
  });

  it('returns "just now" for < 1 min diff', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 30 * 1000).toISOString())).toBe('just now');
  });

  it('returns "N min ago" for 1-59 min, singular stays "min"', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 1 * 60_000).toISOString())).toBe('1 min ago');
    expect(timeAgo(new Date(now.getTime() - 42 * 60_000).toISOString())).toBe('42 min ago');
  });

  it('pluralizes hours correctly: "1 hr ago" vs "3 hrs ago"', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 1 * 3600_000).toISOString())).toBe('1 hr ago');
    expect(timeAgo(new Date(now.getTime() - 3 * 3600_000).toISOString())).toBe('3 hrs ago');
  });

  it('returns "yesterday" for exactly 1 day ago', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 86_400_000).toISOString())).toBe('yesterday');
  });

  it('returns "N days ago" for ≥ 2 days', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo(new Date(now.getTime() - 5 * 86_400_000).toISOString())).toBe('5 days ago');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getGreeting — hour buckets
// ─────────────────────────────────────────────────────────────────────────────
describe('getGreeting', () => {
  afterEach(() => vi.useRealTimers());

  it('returns correct greeting for each hour bucket', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T06:00:00'));
    expect(getGreeting()).toBe('Good morning');
    vi.setSystemTime(new Date('2026-04-14T13:00:00'));
    expect(getGreeting()).toBe('Good afternoon');
    vi.setSystemTime(new Date('2026-04-14T20:00:00'));
    expect(getGreeting()).toBe('Good evening');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDateDisplay — just a sanity check that it produces a non-empty string
// (the locale-specific format is delegated to the runtime).
// ─────────────────────────────────────────────────────────────────────────────
describe('getDateDisplay', () => {
  it('returns a non-empty string containing the year', () => {
    const out = getDateDisplay();
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/\d{4}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// capitalize — trivial but part of the public surface
// ─────────────────────────────────────────────────────────────────────────────
describe('capitalize', () => {
  it('uppercases the first character, leaves rest alone', () => {
    expect(capitalize('github')).toBe('Github');
    expect(capitalize('a')).toBe('A');
  });

  it('returns "" for falsy input', () => {
    expect(capitalize('')).toBe('');
    expect(capitalize(null)).toBe('');
    expect(capitalize(undefined)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// friendlyDomain — lookup table, subdomain patterns, fallback
// ─────────────────────────────────────────────────────────────────────────────
describe('friendlyDomain', () => {
  it('resolves known hostnames via the lookup table', () => {
    expect(friendlyDomain('github.com')).toBe('GitHub');
    expect(friendlyDomain('mail.google.com')).toBe('Gmail');
    expect(friendlyDomain('old.reddit.com')).toBe('Reddit');
  });

  it('formats *.substack.com as "X\'s Substack"', () => {
    expect(friendlyDomain('lenny.substack.com')).toBe("Lenny's Substack");
  });

  it('formats *.github.io as "X (GitHub Pages)"', () => {
    expect(friendlyDomain('leonxia1010.github.io')).toBe('Leonxia1010 (GitHub Pages)');
  });

  it('falls back to stripped + capitalized name for unknown domains', () => {
    expect(friendlyDomain('myapp.com')).toBe('Myapp');
    expect(friendlyDomain('www.myapp.com')).toBe('Myapp');
    expect(friendlyDomain('blog.example.io')).toBe('Blog Example');
  });

  it('returns "" for empty input', () => {
    expect(friendlyDomain('')).toBe('');
    expect(friendlyDomain(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripTitleNoise — notification counts, emails, X cruft
// ─────────────────────────────────────────────────────────────────────────────
describe('stripTitleNoise', () => {
  it('strips leading notification count "(N)"', () => {
    expect(stripTitleNoise('(5) Vibe coding ideas')).toBe('Vibe coding ideas');
    expect(stripTitleNoise('(99+) Inbox')).toBe('Inbox');
  });

  it('strips inline count like "(16,359)"', () => {
    expect(stripTitleNoise('Inbox (16,359)')).toBe('Inbox');
  });

  it('strips trailing email addresses with separator', () => {
    expect(stripTitleNoise('Subject - user@example.com - Gmail')).toBe('Subject - Gmail');
  });

  it('collapses "Name on X: quote" → "Name: quote"', () => {
    expect(stripTitleNoise('Alice on X: hello world')).toBe('Alice: hello world');
  });

  it('strips trailing " / X"', () => {
    expect(stripTitleNoise('Post title / X')).toBe('Post title');
  });

  it('returns "" for empty / null input', () => {
    expect(stripTitleNoise('')).toBe('');
    expect(stripTitleNoise(null)).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cleanTitle — trailing-domain stripping
// ─────────────────────────────────────────────────────────────────────────────
describe('cleanTitle', () => {
  it('strips trailing " - <Site>" when the suffix matches domain/friendly', () => {
    expect(cleanTitle('Great article - Medium', 'medium.com')).toBe('Great article');
    expect(cleanTitle('Thread discussion | Reddit', 'reddit.com')).toBe('Thread discussion');
  });

  it('leaves title alone when no separator is present', () => {
    expect(cleanTitle('Hello there', 'example.com')).toBe('Hello there');
  });

  it('leaves title alone when suffix does not match the domain', () => {
    expect(cleanTitle('Hello - goodbye', 'example.com')).toBe('Hello - goodbye');
  });

  it('does not strip if the cleaned prefix would be < 5 chars', () => {
    // "Hi" (2 chars) is under the 5-char threshold, so we keep the suffix.
    expect(cleanTitle('Hi - Reddit', 'reddit.com')).toBe('Hi - Reddit');
  });

  it('returns passthrough for missing title / hostname', () => {
    expect(cleanTitle('', 'github.com')).toBe('');
    expect(cleanTitle('Something', '')).toBe('Something');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// smartTitle — URL → meaningful title fallbacks
// ─────────────────────────────────────────────────────────────────────────────
describe('smartTitle', () => {
  it('X post with URL-as-title becomes "Post by @user"', () => {
    expect(smartTitle('https://x.com/alice/status/42', 'https://x.com/alice/status/42')).toBe(
      'Post by @alice',
    );
  });

  it('X post preserves a real (non-URL) title', () => {
    expect(smartTitle('Alice on X: cool thread', 'https://x.com/alice/status/42')).toBe(
      'Alice on X: cool thread',
    );
  });

  it('GitHub repo root resolves to "owner/repo"', () => {
    expect(smartTitle('https://github.com/leonxia1010/tab-out', 'https://github.com/leonxia1010/tab-out')).toBe(
      'leonxia1010/tab-out',
    );
  });

  it('GitHub issue formats as "owner/repo Issue #N"', () => {
    expect(
      smartTitle(
        'https://github.com/foo/bar/issues/7',
        'https://github.com/foo/bar/issues/7',
      ),
    ).toBe('foo/bar Issue #7');
  });

  it('GitHub pull request formats as "owner/repo PR #N"', () => {
    expect(
      smartTitle(
        'https://github.com/foo/bar/pull/3',
        'https://github.com/foo/bar/pull/3',
      ),
    ).toBe('foo/bar PR #3');
  });

  it('Reddit thread with URL-as-title becomes "r/<sub> post"', () => {
    const url = 'https://www.reddit.com/r/javascript/comments/abc/hello_world/';
    expect(smartTitle(url, url)).toBe('r/javascript post');
  });

  it('YouTube watch with URL-as-title becomes "YouTube Video"', () => {
    const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(smartTitle(url, url)).toBe('YouTube Video');
  });

  it('unknown domain falls back to the original title', () => {
    expect(smartTitle('My page', 'https://example.com/some/path')).toBe('My page');
  });

  it('invalid URL returns the given title unchanged', () => {
    expect(smartTitle('Good title', 'not a url')).toBe('Good title');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getRealTabs — scheme filtering
// ─────────────────────────────────────────────────────────────────────────────
describe('getRealTabs', () => {
  it('keeps http(s) + chrome:// + chrome-extension:// tabs, drops about/edge/brave', () => {
    const tabs = [
      { url: 'https://github.com' },
      { url: 'http://localhost:3456' },
      { url: 'chrome://extensions' },
      { url: 'chrome-extension://abc/newtab.html' },
      { url: 'about:blank' },
      { url: 'edge://settings' },
      { url: 'brave://rewards' },
    ];
    const kept = getRealTabs(tabs);
    expect(kept.map((t) => t.url)).toEqual([
      'https://github.com',
      'http://localhost:3456',
      'chrome://extensions',
      'chrome-extension://abc/newtab.html',
    ]);
  });

  it('returns empty array for empty input (no throw)', () => {
    expect(getRealTabs([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getOpenTabsForMission / countOpenTabsForMission — hostname matching
// ─────────────────────────────────────────────────────────────────────────────
describe('getOpenTabsForMission', () => {
  const tabs = [
    { url: 'https://github.com/a' },
    { url: 'https://docs.github.com/b' },
    { url: 'https://example.com/c' },
    { url: 'https://reddit.com/r/foo' },
  ];

  it('matches tabs by hostname containment (either direction)', () => {
    const result = getOpenTabsForMission(['github.com'], tabs);
    expect(result.map((t) => t.url)).toEqual([
      'https://github.com/a',
      'https://docs.github.com/b',
    ]);
  });

  it('accepts mission URLs as plain strings or objects with .url', () => {
    const withObjects = getOpenTabsForMission([{ url: 'reddit.com' }], tabs);
    expect(withObjects.map((t) => t.url)).toEqual(['https://reddit.com/r/foo']);
  });

  it('returns [] for empty mission URL list or empty tabs', () => {
    expect(getOpenTabsForMission([], tabs)).toEqual([]);
    expect(getOpenTabsForMission(['github.com'], [])).toEqual([]);
    expect(getOpenTabsForMission(null, tabs)).toEqual([]);
  });

  it('countOpenTabsForMission returns the length of getOpenTabsForMission', () => {
    expect(countOpenTabsForMission(['github.com'], tabs)).toBe(2);
    expect(countOpenTabsForMission([], tabs)).toBe(0);
  });
});
