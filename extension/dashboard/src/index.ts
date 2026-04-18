// Dashboard entry point.
//
// Owns:
//   - module wiring (each src/*.ts file is imported here)
//   - bootstrap: renderDashboard() + checkForUpdates() on load
//   - event listener attach (handlers.attachListeners is idempotent)
//
// Update banner: background.js writes update state to
// chrome.storage.local['tabout:updateStatus'] every 48h; we read it here,
// render the banner via dom-utils.el() so no innerHTML touches user data,
// and let the user dismiss it against the current latestTag.

import * as handlers from './handlers.js';
import { renderDashboard } from './renderers.js';
import { attachTabsListeners } from './refresh.js';
import { dismissUpdateBanner, getUpdateStatus } from './api.js';
import { el, svg } from '../../shared/dist/dom-utils.js';
import { getSettings, onSettingsChange } from '../../shared/dist/settings.js';
import { applyTheme, mountThemeToggle, type ThemeToggleHandle } from './widgets/theme.js';
import { mountClock, type ClockHandle } from './widgets/clock.js';
import { mountSearch } from './widgets/search.js';
import { mountShortcuts, type ShortcutsHandle } from './widgets/shortcuts.js';
import { mountSettingsLink } from './widgets/settings-link.js';
import { mountWeather, type WeatherHandle } from './widgets/weather.js';

const RELEASE_URL = 'https://github.com/leonxia1010/tab-out/releases/latest';

async function dismissBanner(e: Event): Promise<void> {
  const banner = (e.currentTarget as HTMLElement | null)?.closest('.update-banner');
  banner?.remove();
  await dismissUpdateBanner();
}

async function checkForUpdates(): Promise<void> {
  try {
    const body = await getUpdateStatus();
    if (!body.updateAvailable) return;

    const container = document.querySelector('.container');
    if (!container) return;

    // Heroicons x-mark at stroke-width 1.5 — thinner than the archive/theme
    // family's 2, so it reads quieter inside the announcement strip.
    const dismissBtn = el('button', {
      className: 'update-banner-dismiss',
      'aria-label': 'Dismiss',
    }, [svg('<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>')]);
    dismissBtn.addEventListener('click', dismissBanner);

    // CTA dismissal: clicking "See on GitHub" also counts as acknowledgement
    // (VSCode / Slack / GitHub convention). Without this the banner returns
    // on every new-tab open until the user explicitly clicks the X.
    const ctaLink = el('a', {
      className: 'update-banner-btn',
      href: RELEASE_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, ['See on GitHub']);
    ctaLink.addEventListener('click', dismissBanner);

    const banner = el('div', { className: 'update-banner' }, [
      el('div', { className: 'update-banner-left' }, [
        el('span', { className: 'update-banner-icon' }, ['\u2728']),
        el('span', { className: 'update-banner-text' }, [
          'A new version of Tab Out is available.',
        ]),
      ]),
      el('div', { className: 'update-banner-right' }, [ctaLink, dismissBtn]),
    ]);
    container.prepend(banner);
  } catch {
    // Storage read failed — silently skip the banner.
  }
}

// Settings bootstrap. theme-bootstrap.js has already set html[data-theme]
// from the localStorage cache before any paint; this call reconciles
// against the chrome.storage source of truth (handles stale/missing
// cache) and registers the onChanged listener so changes from the
// options page update the dashboard without a reload.
//
// getSettings() swallows chrome.storage errors and returns defaults,
// so no try/catch needed here. Mount order: clock on the left, theme
// toggle on the right (header reads left-to-right).
function applyLayout(layout: 'masonry' | 'grid'): void {
  // 'masonry' is the default — clear the attribute so the base .domains
  // rule applies. Only 'grid' needs the explicit override selector.
  const root = document.documentElement;
  if (layout === 'grid') {
    root.dataset.layout = 'grid';
  } else {
    delete root.dataset.layout;
  }
}

async function bootstrapSettings(): Promise<void> {
  const slot = document.getElementById('headerRight');
  const middleSlot = document.getElementById('middleSection');
  const settings = await getSettings();
  applyTheme(settings.theme);
  applyLayout(settings.layout);

  let clock: ClockHandle | null = null;
  let themeToggle: ThemeToggleHandle | null = null;
  let weather: WeatherHandle | null = null;
  if (slot) {
    clock = mountClock(slot, settings.clock.format);
    // Weather sits between clock (time) and theme (visual affordance)
    // so the info-bearing widgets cluster on the left of the right
    // group and controls cluster on the right.
    weather = mountWeather(slot, settings.weather);
    themeToggle = mountThemeToggle(slot, settings.theme);
    // Settings is a meta tool (go configure, come back) — parked
    // rightmost in the cluster so the common-use widgets read first.
    mountSettingsLink(slot);
  }
  let shortcuts: ShortcutsHandle | null = null;
  if (middleSlot) {
    // Search first so it renders above the shortcut row — the whole
    // middle section reads top-down: type-to-search, then quick-launch.
    mountSearch(middleSlot);
    shortcuts = mountShortcuts(middleSlot, settings);
  }

  onSettingsChange((next) => {
    applyTheme(next.theme);
    applyLayout(next.layout);
    themeToggle?.syncIcon(next.theme);
    clock?.applyFormat(next.clock.format);
    shortcuts?.applySettings(next);
    weather?.applySettings(next.weather);
  });
}

handlers.attachListeners();
attachTabsListeners();
void bootstrapSettings();
void renderDashboard();
void checkForUpdates();
