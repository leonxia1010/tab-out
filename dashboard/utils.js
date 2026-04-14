'use strict';

/*
 * dashboard/utils.js — legacy IIFE mirror of dashboard/src/utils.ts.
 *
 * NOT loaded by index.html (browsers get window.utils from dist/index.js's
 * `import * as utils` bridge). This file exists ONLY so tests/dashboard/
 * render.test.js can inject it as a <script> string into JSDOM, alongside
 * app.js, until PR G rewrites that test to `import` the ESM source directly.
 *
 * Keep this a mechanical mirror of utils.ts: same function bodies, same
 * signatures, same behavior. PR G deletes this file.
 */
(function () {
  const FRIENDLY_DOMAINS = {
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
  };

  function timeAgo(dateStr) {
    if (!dateStr) return '';
    const then = new Date(dateStr);
    const now = new Date();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1)   return 'just now';
    if (diffMins < 60)  return diffMins + ' min ago';
    if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
    if (diffDays === 1) return 'yesterday';
    return diffDays + ' days ago';
  }

  function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function getDateDisplay() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function friendlyDomain(hostname) {
    if (!hostname) return '';
    if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

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

  function stripTitleNoise(title) {
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

  function cleanTitle(title, hostname) {
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

  function smartTitle(title, url) {
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
        if (!titleIsUrl) return title;
        return 'Post by @' + username;
      }
    }

    if (hostname === 'github.com' || hostname === 'www.github.com') {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0];
        const repo = parts[1];
        if (parts[2] === 'issues' && parts[3]) return owner + '/' + repo + ' Issue #' + parts[3];
        if (parts[2] === 'pull' && parts[3]) return owner + '/' + repo + ' PR #' + parts[3];
        if (parts[2] === 'blob' || parts[2] === 'tree')
          return owner + '/' + repo + ' — ' + parts.slice(4).join('/');
        if (titleIsUrl) return owner + '/' + repo;
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
        if (titleIsUrl) return 'r/' + sub + ' post';
      }
    }

    return title || url;
  }

  function getRealTabs(tabs) {
    return tabs.filter((t) => {
      const url = t.url || '';
      return (
        !url.startsWith('chrome://') &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('about:') &&
        !url.startsWith('edge://') &&
        !url.startsWith('brave://')
      );
    });
  }

  function getOpenTabsForMission(missionUrls, openTabs) {
    if (!missionUrls || missionUrls.length === 0 || openTabs.length === 0) return [];

    const missionDomains = missionUrls.map((item) => {
      const urlStr = typeof item === 'string' ? item : item.url || '';
      try {
        return new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
      } catch {
        return urlStr;
      }
    });

    return openTabs.filter((tab) => {
      try {
        const tabDomain = new URL(tab.url || '').hostname;
        return missionDomains.some((d) => tabDomain.includes(d) || d.includes(tabDomain));
      } catch {
        return false;
      }
    });
  }

  function countOpenTabsForMission(missionUrls, openTabs) {
    return getOpenTabsForMission(missionUrls, openTabs).length;
  }

  window.utils = {
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
  };
})();
