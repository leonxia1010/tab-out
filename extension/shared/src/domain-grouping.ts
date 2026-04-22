// Hostname lookup tables + the pure transform that groups tabs into
// domain cards. Shared between dashboard (render + organize) and popup
// (organize — popup has no render state of its own, so it rebuilds
// groups from chrome.tabs.query on open).
//
// DEFAULT_PRIORITY_HOSTNAMES: the "always-available" entry points (mail,
// social, code host) that the user treats as ambient and expects on the
// left side of the grid regardless of open-order. Now the default seed
// for `tabout:settings.priorityHostnames` (v2.8.0) — each user picks
// their own set; the live set is threaded into groupTabsByDomain.
//
// DEFAULT_DOMAIN_ALIASES / DEFAULT_FRIENDLY_DOMAINS: hardcoded seed
// tables. v2.9.0 copies them into `tabout:settings` on first boot
// (full-copy model — storage is the single truth after seeding).
// effectiveDomain() and groupTabsByDomain() accept an optional aliases
// override so callers can pass the user's stored aliases at runtime.
//
// Don't add google.com aliases — Gmail / Docs / Drive stay on separate
// cards on purpose via friendlyDomains display names.

import type { DomainGroup, Tab } from './tab-types.js';

// Card-key form only: twitter.com collapses to x.com via DEFAULT_DOMAIN_ALIASES, so
// listing twitter.com separately here would silently dedupe to x.com once
// the settings normalizer runs. The pre-v2.8.0 hardcoded set used to carry
// both; dropped as dead entry now that the list is user-editable (and the
// normalizer enforces the invariant that stored entries match group keys).
export const DEFAULT_PRIORITY_HOSTNAMES: readonly string[] = [
  'mail.google.com',
  'x.com',
  'www.linkedin.com',
  'github.com',
];

export const DEFAULT_DOMAIN_ALIASES: Record<string, string> = {
  // Bilibili — subdomains + b23.tv share shortlink
  'www.bilibili.com':    'bilibili.com',
  'search.bilibili.com': 'bilibili.com',
  'm.bilibili.com':      'bilibili.com',
  'live.bilibili.com':   'bilibili.com',
  't.bilibili.com':      'bilibili.com',
  'space.bilibili.com':  'bilibili.com',
  'b23.tv':              'bilibili.com',

  // YouTube — www / mobile / youtu.be share shortlink.
  // music.youtube.com stays separate on purpose (friendlyDomains → "YouTube Music").
  'www.youtube.com':     'youtube.com',
  'm.youtube.com':       'youtube.com',
  'youtu.be':            'youtube.com',

  // Twitter / X — Musk rename left both domains live; collapse to x.com (current
  // official name). Both default into the v2.8.0 priority list; the settings
  // normalizer also applies effectiveDomain on user input so typing
  // "twitter.com" lands as "x.com" and actually pins the collapsed group.
  'www.x.com':           'x.com',
  'twitter.com':         'x.com',
  'www.twitter.com':     'x.com',

  // Taobao + Tmall — same Alibaba commerce; users treat "逛淘宝/逛天猫" as one shopping card.
  'www.taobao.com':      'taobao.com',
  's.taobao.com':        'taobao.com',
  'item.taobao.com':     'taobao.com',
  'tmall.com':           'taobao.com',
  'www.tmall.com':       'taobao.com',
  'detail.tmall.com':    'taobao.com',

  // JD — legacy 360buy + regional jd.hk fold into jd.com.
  'www.jd.com':          'jd.com',
  'item.jd.com':         'jd.com',
  'jd.hk':               'jd.com',
  '360buy.com':          'jd.com',

  // Amazon — regional storefronts (.co.jp / .de / .fr / …) fold into amazon.com.
  // Trade-off: loses "which region" visibility; user opted for brand-level grouping.
  'www.amazon.com':      'amazon.com',
  'amazon.co.jp':        'amazon.com',
  'amazon.co.uk':        'amazon.com',
  'amazon.de':           'amazon.com',
  'amazon.fr':           'amazon.com',
  'amazon.cn':           'amazon.com',

  // Meta — vanity shortlinks fb.com / fb.me redirect to facebook.com.
  'www.facebook.com':    'facebook.com',
  'm.facebook.com':      'facebook.com',
  'fb.com':              'facebook.com',
  'fb.me':               'facebook.com',
};

export function effectiveDomain(
  hostname: string,
  aliases?: Record<string, string>,
): string {
  const table = aliases ?? DEFAULT_DOMAIN_ALIASES;
  return table[hostname] ?? hostname;
}

// Stable DOM key for each domain card. diff.ts (set-diff lookup) and
// handlers.ts (close-domain action) rebuild the same slug; exporting
// keeps the call sites locked together — if the sanitization rule
// ever changes, no silent drift.
export function domainIdFor(domain: string): string {
  return 'domain-' + domain.replace(/[^a-z0-9]/g, '-');
}

function firstIndex(group: DomainGroup): number {
  let min = Infinity;
  for (const t of group.tabs) {
    if (typeof t.index === 'number' && t.index < min) min = t.index;
  }
  return min;
}

export function groupTabsByDomain(
  realTabs: Tab[],
  priorityHostnames: ReadonlySet<string>,
  aliases?: Record<string, string>,
): DomainGroup[] {
  const groupMap: Record<string, DomainGroup> = {};

  for (const tab of realTabs) {
    try {
      const url = tab.url || '';
      let hostname: string;
      if (url.startsWith('file://')) {
        hostname = 'local-files';
      } else if (url.startsWith('chrome://')) {
        hostname = '__chrome-internal__';
      } else if (url.startsWith('chrome-extension://')) {
        hostname = '__extensions__';
      } else {
        hostname = effectiveDomain(new URL(url).hostname, aliases);
      }
      if (!hostname) continue;
      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  const groups = Object.values(groupMap);
  // Pre-compute first-seen indices once: sort's comparator is called
  // O(N log N) times, and firstIndex() is a linear scan over each
  // group's tabs — caching avoids the quadratic-ish O(N log N × k)
  // blow-up on users with many tabs per domain.
  const firstSeen = new Map<string, number>(
    groups.map((g) => [g.domain, firstIndex(g)]),
  );
  return groups.sort((a, b) => {
    // Priority tier: hostnames in the passed set pin above the rest.
    // Within the tier, leaf (first-seen) still decides order — the list
    // controls membership, not internal ordering (see ROADMAP v2.8.0).
    const aIsPriority = priorityHostnames.has(a.domain);
    const bIsPriority = priorityHostnames.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    // Leaf tier: first-seen. A group's position is anchored to its
    // earliest-opened tab's chrome-tab index, so opening/closing tabs
    // on other domains doesn't reshuffle this card. This stability is
    // the precondition for the card-level diff — "order changed →
    // full re-render" (rule 4) would otherwise fire on every tab add.
    //
    // tab.index may be missing in tests/mocks or if chrome omits it;
    // Infinity pushes such groups to the end, which is harmless and
    // deterministic.
    return (firstSeen.get(a.domain) ?? Infinity) - (firstSeen.get(b.domain) ?? Infinity);
  });
}

export const DEFAULT_FRIENDLY_DOMAINS: Record<string, string> = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
  '__chrome-internal__':  'Chrome System',
  '__extensions__':       'Extensions',
  'taobao.com':           'Taobao / Tmall',
  'jd.com':               'JD',
  'facebook.com':         'Facebook',
};
