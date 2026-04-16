// Dashboard entry point.
//
// Owns:
//   - module wiring (each src/*.ts file is imported here)
//   - bootstrap: renderDashboard() + checkForUpdates() on load
//   - event listener attach (handlers.attachListeners is idempotent)
//
// Update banner (phase 4 PR-B): background.js writes update state to
// chrome.storage.local['tabout:updateStatus'] every 48h; we read it here,
// render the banner via dom-utils.el() so no innerHTML touches user data,
// and let the user dismiss it against the current latestTag.

import * as handlers from './handlers.js';
import { renderDashboard } from './renderers.js';
import { attachTabsListeners } from './refresh.js';
import { getUpdateStatus } from './api.js';
import { el } from './dom-utils.js';

const UPDATE_STATUS_KEY = 'tabout:updateStatus';
const RELEASE_URL = 'https://github.com/leonxia1010/tab-out/releases/latest';

// Matches the shape written by background.js#checkForUpdate. Declared
// narrow instead of casting through Record<string, unknown>; ts-level
// autocomplete on s.dismissedTag etc. is the main win.
interface UpdateStatusRecord {
  updateAvailable?: boolean;
  latestTag?: string;
  currentTag?: string;
  checkedAt?: string;
  dismissedTag?: string | null;
}

async function dismissBanner(e: Event): Promise<void> {
  const banner = (e.currentTarget as HTMLElement | null)?.closest('.update-banner');
  banner?.remove();
  // Persist dismissal so the banner stays gone until the next release.
  // Silent on failure — the banner is already removed visually.
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get(UPDATE_STATUS_KEY);
    const s = (result as Record<string, UpdateStatusRecord | undefined>)[UPDATE_STATUS_KEY];
    if (!s?.latestTag) return;
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: { ...s, dismissedTag: s.latestTag },
    });
  } catch {
    // noop
  }
}

async function checkForUpdates(): Promise<void> {
  try {
    const body = await getUpdateStatus();
    if (!body.updateAvailable) return;

    const footer = document.querySelector('footer');
    if (!footer) return;

    const dismissBtn = el('button', {
      className: 'update-banner-dismiss',
      'aria-label': 'Dismiss',
    }, ['\u00d7']);
    dismissBtn.addEventListener('click', dismissBanner);

    const banner = el('div', { className: 'update-banner' }, [
      el('div', { className: 'update-banner-left' }, [
        el('span', { className: 'update-banner-icon' }, ['\u2728']),
        el('span', { className: 'update-banner-text' }, [
          'A new version of Tab Out is available.',
        ]),
      ]),
      el('div', { className: 'update-banner-right' }, [
        el('a', {
          className: 'update-banner-btn',
          href: RELEASE_URL,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, ['See on GitHub']),
        dismissBtn,
      ]),
    ]);
    footer.after(banner);
  } catch {
    // Storage read failed — silently skip the banner.
  }
}

handlers.attachListeners();
attachTabsListeners();
void renderDashboard();
void checkForUpdates();
