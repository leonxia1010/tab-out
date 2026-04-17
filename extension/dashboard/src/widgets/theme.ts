// Theme toggle widget — circular button + native popover with three options.
//
// Uses the HTML Popover API (browser-native, no custom click-away JS):
//   - button has popovertarget="<id>" -> browser toggles the popover
//   - each option has popovertargetaction="hide" -> browser closes it
//     on click
// Chromium 114+ ships the attribute; MV3 floor guarantees we're well
// above that.
//
// The click handlers (data-action="set-theme-*") live in handlers.ts —
// kept inside the single document-level dispatcher so we don't grow a
// second listener. handleSetTheme there calls setSettings(); the
// chrome.storage.onChanged listener in index.ts then applies the theme
// via applyTheme() AND calls ThemeToggleHandle.syncIcon so the trigger
// glyph tracks the currently-visible theme.
//
// Trigger icon reflects the EFFECTIVE theme (what the user sees), not
// the selected mode — so 'system' resolves through
// `prefers-color-scheme` and we listen for OS changes to keep the icon
// in sync while on system mode.
//
// Popover positioning: the native popover API puts the element in the
// browser top layer at the default (0,0) position. We listen to the
// `toggle` event and set `position: fixed` coords from the trigger's
// bounding rect each time it opens, so the menu stays anchored under
// the button (right-aligned).

import { el } from '../dom-utils.js';
import type { ThemeMode } from '../../../shared/dist/settings.js';

const POPOVER_ID = 'taboutThemePopover';
const ICON_SUN = '\u2600\u{FE0F}';   // ☀️
const ICON_MOON = '\u{1F319}';        // 🌙
const POPOVER_GAP_PX = 8;

interface Option {
  theme: ThemeMode;
  icon: string;
  label: string;
  action: string;
}

const OPTIONS: Option[] = [
  { theme: 'system', icon: '\u{1F5A5}\u{FE0F}', label: 'Follow system', action: 'set-theme-system' },
  { theme: 'light',  icon: ICON_SUN,             label: 'Light',         action: 'set-theme-light'  },
  { theme: 'dark',   icon: ICON_MOON,            label: 'Dark',          action: 'set-theme-dark'   },
];

export interface ThemeToggleHandle {
  // Called by index.ts#onSettingsChange so the trigger icon tracks the
  // selected theme (and the OS preference, when on 'system').
  syncIcon(theme: ThemeMode): void;
}

export function applyTheme(theme: ThemeMode): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// Resolve the mode the user actually sees. 'system' folds through the
// prefers-color-scheme media query; explicit light/dark pass through.
function effectiveTheme(theme: ThemeMode): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

function iconFor(theme: ThemeMode): string {
  return effectiveTheme(theme) === 'dark' ? ICON_MOON : ICON_SUN;
}

function optionButton(opt: Option): HTMLButtonElement {
  return el('button', {
    type: 'button',
    className: 'theme-option',
    'data-action': opt.action,
    popovertarget: POPOVER_ID,
    popovertargetaction: 'hide',
  }, [
    el('span', { className: 'theme-option-icon', 'aria-hidden': 'true' }, [opt.icon]),
    el('span', { className: 'theme-option-label' }, [opt.label]),
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
  }, [iconFor(initialTheme)]) as HTMLButtonElement;

  const popover = el('div', {
    id: POPOVER_ID,
    className: 'theme-popover',
    popover: 'auto',
    role: 'menu',
  }, OPTIONS.map(optionButton)) as HTMLElement;

  container.appendChild(trigger);
  container.appendChild(popover);

  // Track the selected mode so OS-level prefers-color-scheme changes
  // can refresh the icon when we're on 'system'.
  let current: ThemeMode = initialTheme;

  // Anchor the popover under the trigger every time it opens. We keep
  // this cheap: only runs on open, so tab hide/show doesn't leak.
  popover.addEventListener('toggle', (ev) => {
    const e = ev as ToggleEvent;
    if (e.newState !== 'open') return;
    const tr = trigger.getBoundingClientRect();
    const pw = popover.offsetWidth;
    const vw = window.innerWidth;
    let left = tr.right - pw;           // align right edges
    if (left < 8) left = 8;             // clamp against viewport edge
    if (left + pw > vw - 8) left = vw - pw - 8;
    popover.style.top = `${tr.bottom + POPOVER_GAP_PX}px`;
    popover.style.left = `${left}px`;
  });

  // Keep the icon in sync when the user is on 'system' and the OS
  // preference flips. We only add the listener when matchMedia exists
  // (jsdom + older shims may lack it).
  const mql = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
  const onMediaChange = (): void => {
    if (current === 'system') trigger.textContent = iconFor(current);
  };
  mql?.addEventListener?.('change', onMediaChange);

  return {
    syncIcon(theme: ThemeMode): void {
      current = theme;
      trigger.textContent = iconFor(theme);
    },
  };
}
