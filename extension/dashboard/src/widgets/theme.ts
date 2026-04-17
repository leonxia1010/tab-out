// Theme toggle widget — circular button + native popover with three options.
//
// Uses the HTML Popover API (browser-native, no custom click-away JS):
//   - button has popovertarget="<id>" -> browser toggles the popover
//   - each option has popovertargetaction="hide" -> browser closes it
//     on click
// Chromium 114+ ships the attribute; MV3 floor guarantees we're well
// above that.
//
// Icons are Heroicons v2 outline (MIT, tailwindlabs/heroicons). Inline
// SVG so they inherit `currentColor` and swap cleanly between dark and
// light palettes without an image request or emoji-font dependency.
// Each SVG carries `data-icon="sun|moon|system"` so tests can assert
// which glyph is mounted without poking at path data.
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

import { el, svg } from '../dom-utils.js';
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

// Trigger shows the currently-visible theme (sun or moon), never the
// system glyph — that glyph only appears inside the dropdown.
function triggerIconSvg(theme: ThemeMode): string {
  return effectiveTheme(theme) === 'dark' ? SVG_MOON : SVG_SUN;
}

function iconNode(svgString: string): Element {
  const node = svg(svgString);
  if (!node) throw new Error('theme widget: failed to parse icon SVG');
  return node;
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
      btn.setAttribute('aria-checked', isCurrent ? 'true' : 'false');
      btn.classList.toggle('is-current', isCurrent);
    }
  };
  markCurrent(initialTheme);

  // Track the selected mode so OS-level prefers-color-scheme changes
  // can refresh the icon when we're on 'system'.
  let current: ThemeMode = initialTheme;

  // Anchor the popover under the trigger every time it opens. We keep
  // this cheap: only runs on open, so tab hide/show doesn't leak.
  //
  // Scroll/resize → close. The popover lives in the browser top layer
  // with position: fixed, so without this it would hover at the old
  // viewport coords while the page scrolls underneath — and could end
  // up detached from its trigger. Native <select> + OS menus close on
  // scroll; match that. Listener is attached on open and removed on
  // close, so we pay nothing while the menu is hidden.
  const dismissOnScroll = (): void => {
    if (typeof popover.hidePopover === 'function') popover.hidePopover();
  };
  popover.addEventListener('toggle', (ev) => {
    const e = ev as ToggleEvent;
    if (e.newState === 'open') {
      const tr = trigger.getBoundingClientRect();
      const pw = popover.offsetWidth;
      const vw = window.innerWidth;
      let left = tr.right - pw;           // align right edges
      if (left < 8) left = 8;             // clamp against viewport edge
      if (left + pw > vw - 8) left = vw - pw - 8;
      popover.style.top = `${tr.bottom + POPOVER_GAP_PX}px`;
      popover.style.left = `${left}px`;
      // Capture phase so nested scroll containers also trigger dismissal.
      window.addEventListener('scroll', dismissOnScroll, { capture: true, passive: true });
      window.addEventListener('resize', dismissOnScroll, { passive: true });
    } else {
      window.removeEventListener('scroll', dismissOnScroll, { capture: true });
      window.removeEventListener('resize', dismissOnScroll);
    }
  });

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
  };
}
