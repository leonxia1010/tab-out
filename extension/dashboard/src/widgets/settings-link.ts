// Settings entry point — Heroicons cog button that opens the options page.
//
// manifest.json sets options_ui.open_in_tab: true, so openOptionsPage()
// opens a full Chrome tab rather than a popup. We intentionally don't
// reuse an existing options tab if one is already open; Chrome handles
// focus-vs-new based on user context, and we don't want to build that
// logic ourselves.
//
// Icon is Heroicons v2 outline cog-6-tooth (MIT, tailwindlabs/heroicons).
// Stroke-width 1.5 to match the theme-toggle glyph weight so they read
// as a visual pair in the header cluster.

import { el, iconNode } from '../../../shared/dist/dom-utils.js';

const SVG_COG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true" data-icon="cog"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.076.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.645.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.37-.49l-1.296-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.132.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /></svg>`;

export interface SettingsLinkHandle {
  destroy(): void;
}

function openOptions(): void {
  chrome.runtime?.openOptionsPage?.();
}

export function mountSettingsLink(container: HTMLElement): SettingsLinkHandle {
  const btn = el('button', {
    type: 'button',
    className: 'settings-link-btn',
    'aria-label': 'Open settings',
    title: 'Open settings',
  }, [iconNode(SVG_COG, 'cog')]) as HTMLButtonElement;

  btn.addEventListener('click', openOptions);
  container.appendChild(btn);

  return {
    destroy(): void {
      btn.removeEventListener('click', openOptions);
      btn.remove();
    },
  };
}
