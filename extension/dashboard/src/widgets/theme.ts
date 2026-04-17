// Theme toggle widget — moon button + native popover with three options.
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
// via applyTheme() (same code path for both header-toggle and
// options-page radio writes).

import { el } from '../dom-utils.js';
import type { ThemeMode } from '../../../shared/dist/settings.js';

const POPOVER_ID = 'taboutThemePopover';

interface Option {
  theme: ThemeMode;
  icon: string;
  label: string;
  action: string;
}

const OPTIONS: Option[] = [
  { theme: 'system', icon: '\u{1F5A5}\u{FE0F}', label: 'Follow system', action: 'set-theme-system' },
  { theme: 'light',  icon: '\u2600\u{FE0F}',    label: 'Light',         action: 'set-theme-light'  },
  { theme: 'dark',   icon: '\u{1F319}',         label: 'Dark',          action: 'set-theme-dark'   },
];

export function applyTheme(theme: ThemeMode): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
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

export function mountThemeToggle(container: HTMLElement): void {
  const trigger = el('button', {
    type: 'button',
    className: 'theme-toggle-btn',
    'aria-label': 'Change theme',
    popovertarget: POPOVER_ID,
  }, ['\u{1F319}']);

  const popover = el('div', {
    id: POPOVER_ID,
    className: 'theme-popover',
    popover: 'auto',
    role: 'menu',
  }, OPTIONS.map(optionButton));

  container.appendChild(trigger);
  container.appendChild(popover);
}
