// Pure dashboard helpers. Side-effect-free; callers pass state in
// (no hidden reads from a module-level `openTabs`).

import type { Tab } from '../../shared/dist/tab-types.js';
export type { Tab };

import { DEFAULT_FRIENDLY_DOMAINS } from '../../shared/dist/domain-grouping.js';

let _userOverrides: Record<string, string> = {};

export function setFriendlyDomainsMap(map: Record<string, string>): void {
  _userOverrides = map;
  friendlyDomainCache.clear();
}

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

export function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function getDateDisplay(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function capitalize(str: string | null | undefined): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Memoize by hostname — the universe of hostnames a given dashboard
// ever sees is small (the user's open + saved tabs), and renderDomainCard
// calls this every repaint. Bounded cache in practice by the same ceiling
// the underlying browser has on concurrent tabs.
const friendlyDomainCache = new Map<string, string>();

function computeFriendlyDomain(hostname: string): string {
  if (_userOverrides[hostname]) return _userOverrides[hostname];
  if (DEFAULT_FRIENDLY_DOMAINS[hostname]) return DEFAULT_FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    const sub = hostname.replace('.substack.com', '');
    return capitalize(sub) + "'s Substack";
  }

  if (hostname.endsWith('.github.io')) {
    const sub = hostname.replace('.github.io', '');
    return capitalize(sub) + ' (GitHub Pages)';
  }

  const clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean
    .split('.')
    .map((part) => capitalize(part))
    .join(' ');
}

export function friendlyDomain(hostname: string | null | undefined): string {
  if (!hostname) return '';
  const cached = friendlyDomainCache.get(hostname);
  if (cached !== undefined) return cached;
  const resolved = computeFriendlyDomain(hostname);
  friendlyDomainCache.set(hostname, resolved);
  return resolved;
}

export function stripTitleNoise(title: string | null | undefined): string {
  if (!title) return '';

  let out = title.replace(/^\(\d+\+?\)\s*/, '');
  out = out.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  out = out.replace(
    /\s*[\-\u2010\u2011\u2012\u2013\u2014\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    '',
  );
  out = out.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  out = out.replace(/\s+on X:\s*/, ': ');
  out = out.replace(/\s*\/\s*X\s*$/, '');

  return out.trim();
}

export function cleanTitle(
  title: string | null | undefined,
  hostname: string | null | undefined,
): string {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain = hostname.replace(/^www\./, '');

  const separators = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of separators) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;

    const suffix = title.slice(idx + sep.length).trim();
    const suffixLower = suffix.toLowerCase();

    if (
      suffixLower === domain.toLowerCase() ||
      suffixLower === friendly.toLowerCase() ||
      suffixLower === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLower) ||
      friendly.toLowerCase().includes(suffixLower)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }

  return title;
}

export function smartTitle(
  title: string | null | undefined,
  url: string | null | undefined,
): string {
  if (!url) return title || '';

  let pathname = '';
  let hostname = '';
  try {
    const u = new URL(url);
    pathname = u.pathname;
    hostname = u.hostname;
  } catch {
    return title || '';
  }

  const titleIsUrl =
    !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if (
    (hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') &&
    pathname.includes('/status/')
  ) {
    const username = pathname.split('/')[1];
    if (username) {
      if (!titleIsUrl) return title!;
      return `Post by @${username}`;
    }
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      if (parts[2] === 'issues' && parts[3]) return `${owner}/${repo} Issue #${parts[3]}`;
      if (parts[2] === 'pull' && parts[3]) return `${owner}/${repo} PR #${parts[3]}`;
      if (parts[2] === 'blob' || parts[2] === 'tree')
        return `${owner}/${repo} — ${parts.slice(4).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if (
    (hostname === 'www.youtube.com' || hostname === 'youtube.com') &&
    pathname === '/watch'
  ) {
    if (titleIsUrl) return 'YouTube Video';
  }

  if (
    (hostname === 'www.reddit.com' ||
      hostname === 'reddit.com' ||
      hostname === 'old.reddit.com') &&
    pathname.includes('/comments/')
  ) {
    const parts = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      const sub = parts[subIdx + 1];
      if (titleIsUrl) return `r/${sub} post`;
    }
  }

  return title || url;
}

// Tab helpers take the array as an argument so the module stays pure —
// no hidden module-level reads — and tests can feed fixtures without
// stubbing state.

// Allowlist filter: keep tabs the dashboard should render. We drop other-
// browser internals (about/edge/brave) and Tab Out's own newtab pages so the
// dashboard never lists itself in the Extensions card. chrome:// and
// chrome-extension:// (other extensions) intentionally pass through.
export function getDisplayableTabs(tabs: ReadonlyArray<Tab>): Tab[] {
  return tabs.filter((t) => {
    if (t.isTabOut) return false;
    const url = t.url || '';
    return (
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

