// Theme toggle widget — circular button + native popover with three options.
//
// Uses the HTML Popover API (Chromium 114+, guaranteed by the manifest
// minimum_chrome_version):
//   - button has popovertarget="<id>" -> browser toggles the popover
//   - each option has popovertargetaction="hide" -> browser closes on click
// Popover positioning lives in shared/dom-utils.ts#anchorPopoverTo —
// shortcuts.ts uses the same helper.
//
// Icons are Heroicons v2 outline (MIT, tailwindlabs/heroicons). Inline
// SVG so they inherit `currentColor` and swap cleanly between dark and
// light palettes. Each SVG carries `data-icon="sun|moon|system"` so
// tests can assert which glyph is mounted without poking at path data.
//
// Click handlers (data-action="set-theme-*") live in handlers.ts so we
// keep one document-level dispatcher. handleSetTheme calls setSettings();
// the chrome.storage.onChanged listener in index.ts then applies the
// theme and calls ThemeToggleHandle.syncIcon so the trigger glyph tracks
// the currently-visible theme.
//
// The trigger icon reflects the EFFECTIVE theme (what the user sees),
// not the selected mode — 'system' resolves through
// `prefers-color-scheme`, and we listen for OS changes to keep the icon
// in sync while on system mode.

import { anchorPopoverTo, el, iconNode } from '../../../shared/dist/dom-utils.js';
import { effectiveTheme } from '../../../shared/dist/settings.js';
import type { ThemeMode } from '../../../shared/dist/settings.js';

const POPOVER_ID = 'taboutThemePopover';
const POPOVER_GAP_PX = 8;

// Heroicons v2 outline — stroke-width 1.5, 24x24 viewBox, currentColor.
// Source: https://github.com/tailwindlabs/heroicons (MIT).
const SVG_BASE = 'xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true"';
const SVG_SUN = `<svg ${SVG_BASE} data-icon="sun"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>`;
const SVG_MOON = `<svg ${SVG_BASE} data-icon="moon"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>`;
const SVG_SYSTEM = `<svg ${SVG_BASE} data-icon="system"><path stroke-linecap="round" stroke-linejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"/></svg>`;
const SVG_CHECK = `<svg ${SVG_BASE} data-icon="check"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>`;

interface Option {
  theme: ThemeMode;
  iconSvg: string;
  label: string;
  action: string;
}

const OPTIONS: Option[] = [
  { theme: 'system', iconSvg: SVG_SYSTEM, label: 'Follow system', action: 'set-theme-system' },
  { theme: 'light',  iconSvg: SVG_SUN,    label: 'Light',         action: 'set-theme-light'  },
  { theme: 'dark',   iconSvg: SVG_MOON,   label: 'Dark',          action: 'set-theme-dark'   },
];

export interface ThemeToggleHandle {
  // Called by index.ts#onSettingsChange so the trigger icon tracks the
  // selected theme (and the OS preference, when on 'system').
  syncIcon(theme: ThemeMode): void;
  // Lifecycle parity with clock / search / shortcuts handles: detach
  // the OS media listener and remove the mounted DOM. No dashboard
  // path calls this today (widget lives for the page's lifetime) but
  // keeping the contract uniform makes future options-page live-
  // preview mounts safe.
  destroy(): void;
}

export function applyTheme(theme: ThemeMode): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// Trigger shows the currently-visible theme (sun or moon), never the
// system glyph — that glyph only appears inside the dropdown.
function triggerIconSvg(theme: ThemeMode): string {
  return effectiveTheme(theme) === 'dark' ? SVG_MOON : SVG_SUN;
}

function optionButton(opt: Option): HTMLButtonElement {
  // role=menuitemradio + aria-checked is the WAI-ARIA pattern for
  // "radio-group inside a menu" — screen readers announce "checked"
  // on the current theme. The trailing check icon visually mirrors
  // that state; CSS toggles its visibility off the aria-checked attr.
  return el('button', {
    type: 'button',
    className: 'theme-option',
    role: 'menuitemradio',
    'aria-checked': 'false',
    'data-theme': opt.theme,
    'data-action': opt.action,
    popovertarget: POPOVER_ID,
    popovertargetaction: 'hide',
  }, [
    el('span', { className: 'theme-option-icon', 'aria-hidden': 'true' }, [iconNode(opt.iconSvg)]),
    el('span', { className: 'theme-option-label' }, [opt.label]),
    el('span', { className: 'theme-option-check', 'aria-hidden': 'true' }, [iconNode(SVG_CHECK)]),
  ]) as HTMLButtonElement;
}

export function mountThemeToggle(
  container: HTMLElement,
  initialTheme: ThemeMode = 'system',
): ThemeToggleHandle {
  const trigger = el('button', {
    type: 'button',
    className: 'theme-toggle-btn',
    'aria-label': 'Change theme',
    popovertarget: POPOVER_ID,
  }, [iconNode(triggerIconSvg(initialTheme))]) as HTMLButtonElement;

  const optionButtons = OPTIONS.map(optionButton);
  const popover = el('div', {
    id: POPOVER_ID,
    className: 'theme-popover',
    popover: 'auto',
    role: 'menu',
  }, optionButtons) as HTMLElement;

  container.appendChild(trigger);
  container.appendChild(popover);

  const markCurrent = (theme: ThemeMode): void => {
    for (const btn of optionButtons) {
      const isCurrent = btn.dataset.theme === theme;
      // Single source of truth: aria-checked. CSS selects the current
      // option via `.theme-option[aria-checked="true"]`; maintaining a
      // mirror `is-current` class just invites drift.
      btn.setAttribute('aria-checked', isCurrent ? 'true' : 'false');
    }
  };
  markCurrent(initialTheme);

  // Track the selected mode so OS-level prefers-color-scheme changes
  // can refresh the icon when we're on 'system'.
  let current: ThemeMode = initialTheme;

  // Anchor the popover under the trigger on open, dismissing on
  // scroll/resize so the top-layer element doesn't float detached from
  // its anchor. Shared with widgets/shortcuts.ts.
  anchorPopoverTo(trigger, popover, POPOVER_GAP_PX);

  // Keep the icon in sync when the user is on 'system' and the OS
  // preference flips. We only add the listener when matchMedia exists
  // (jsdom + older shims may lack it).
  const mql = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  const onMediaChange = (): void => {
    if (current === 'system') {
      trigger.replaceChildren(iconNode(triggerIconSvg(current)));
    }
  };
  mql?.addEventListener?.('change', onMediaChange);

  return {
    syncIcon(theme: ThemeMode): void {
      current = theme;
      trigger.replaceChildren(iconNode(triggerIconSvg(theme)));
      markCurrent(theme);
    },
    destroy(): void {
      mql?.removeEventListener?.('change', onMediaChange);
      trigger.remove();
      popover.remove();
    },
  };
}
