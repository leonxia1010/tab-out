// Hostname lookup tables for the open-tabs domain card grouping.
//
// PRIORITY_HOSTNAMES: the "always-available" entry points (mail, social,
// code host) that the user treats as ambient and expects on the left side
// of the grid regardless of open-order.
//
// DOMAIN_ALIASES: explicit hostname → card-key map. Replaces an older
// endsWith('.' + root) heuristic because (1) cross-TLD short links like
// b23.tv aren't subdomains of bilibili.com so endsWith never matched
// them; (2) endsWith without a dot prefix risked fakebilibili.com
// getting folded into bilibili. Laying each hostname out by hand is the
// "dumb but clear" fix — new subdomains take one line each, no clever
// matching required.
//
// Don't add google.com aliases — Gmail / Docs / Drive stay on separate
// cards on purpose via FRIENDLY_DOMAINS in utils.ts.

export const PRIORITY_HOSTNAMES = new Set<string>([
  'mail.google.com',
  'x.com',
  'twitter.com',
  'www.linkedin.com',
  'github.com',
]);

export const DOMAIN_ALIASES: Record<string, string> = {
  // Bilibili — subdomains + b23.tv share shortlink
  'www.bilibili.com':    'bilibili.com',
  'search.bilibili.com': 'bilibili.com',
  'm.bilibili.com':      'bilibili.com',
  'live.bilibili.com':   'bilibili.com',
  't.bilibili.com':      'bilibili.com',
  'space.bilibili.com':  'bilibili.com',
  'b23.tv':              'bilibili.com',

  // YouTube — www / mobile / youtu.be share shortlink.
  // music.youtube.com stays separate on purpose (FRIENDLY_DOMAINS → "YouTube Music").
  'www.youtube.com':     'youtube.com',
  'm.youtube.com':       'youtube.com',
  'youtu.be':            'youtube.com',

  // Twitter / X — Musk rename left both domains live; collapse to x.com (current
  // official name). Both twitter.com and x.com are in PRIORITY_HOSTNAMES so
  // either way a tab on them pins above normal cards.
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

export function effectiveDomain(hostname: string): string {
  return DOMAIN_ALIASES[hostname] ?? hostname;
}

// Stable DOM key for each domain card. diff.ts (set-diff lookup) and
// handlers.ts (close-domain action) rebuild the same slug; exporting
// keeps the three call sites locked together — if the sanitization rule
// ever changes, no silent drift.
export function domainIdFor(domain: string): string {
  return 'domain-' + domain.replace(/[^a-z0-9]/g, '-');
}
