// Saved-for-later rendering: the right-column active/archive item rows
// plus the coordinator that repaints the column whenever the underlying
// deferredTabs list changes.

import { el, mount, svg } from '../../../shared/dist/dom-utils.js';
import { extractHostname } from '../../../shared/dist/url.js';
import { faviconUrl } from '../favicon.js';
import { timeAgo } from '../utils.js';
import { getDeferred, type DeferredTab } from '../api.js';

const DEFERRED_DISMISS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>';
// Heroicons v2 outline — arrow-uturn-left. Matches the dashboard's icon family.
const ARCHIVE_RESTORE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>';

export function renderDeferredItem(item: DeferredTab): HTMLElement {
  const host = extractHostname(item.url);
  const domain = host ? host.replace(/^www\./, '') : '';
  const faviconSrc = faviconUrl(item.url, 16);
  const ago = timeAgo(item.deferred_at);
  const titleText = item.title || item.url;

  const checkbox = el('input', {
    type: 'checkbox',
    className: 'deferred-checkbox',
    dataset: { action: 'check-deferred', deferredId: item.id },
  });

  // src is undefined when the URL won't parse — el() skips the attr so
  // the img issues no network request (an <img> without src is inert;
  // <img src=""> refetches the document per HTML spec).
  const favicon = el('img', {
    src: faviconSrc,
    alt: '',
    style: 'width:14px;height:14px;vertical-align:-2px;margin-right:4px',
  });
  favicon.addEventListener('error', () => { favicon.style.display = 'none'; });

  // data-action + data-saved-url let handlers.ts intercept the click and
  // go through chrome.tabs.create — chrome blocks anchor navigation to
  // chrome:// / chrome-extension:// from an extension page, so relying on
  // target="_blank" alone made those saved entries silently no-op (or
  // worse, resolve href='#' back to this dashboard URL when a stale
  // sanitizer was still in place). href stays the real URL so hover
  // tooltip + right-click "copy link address" still show the right thing.
  const link = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    className: 'deferred-title',
    title: item.title || '',
    dataset: { action: 'open-saved', savedUrl: item.url },
  }, [favicon, titleText]);

  const meta = el('div', { className: 'deferred-meta' }, [
    el('span', { textContent: domain }),
    el('span', { textContent: ago }),
  ]);

  const dismiss = el('button', {
    className: 'deferred-dismiss',
    title: 'Dismiss',
    dataset: { action: 'dismiss-deferred', deferredId: item.id },
  }, [svg(DEFERRED_DISMISS_SVG)]);

  return el('div', {
    className: 'deferred-item',
    dataset: { deferredId: item.id },
  }, [checkbox, el('div', { className: 'deferred-info' }, [link, meta]), dismiss]);
}

export function renderArchiveItem(item: DeferredTab): HTMLElement {
  const ago = item.archived_at ? timeAgo(item.archived_at) : '';
  const titleText = item.title || item.url;

  const link = el('a', {
    href: item.url,
    target: '_blank',
    rel: 'noopener',
    className: 'archive-item-title',
    title: item.title || '',
    textContent: titleText,
    dataset: { action: 'open-saved', savedUrl: item.url },
  });

  const restoreBtn = el('button', {
    className: 'archive-item-restore',
    'aria-label': 'Restore to saved for later',
    title: 'Restore',
    dataset: { action: 'restore-archived', deferredId: item.id },
  }, [svg(ARCHIVE_RESTORE_SVG)]);

  const deleteBtn = el('button', {
    className: 'archive-item-delete',
    'aria-label': 'Delete from archive',
    title: 'Delete',
    dataset: { action: 'delete-archived', deferredId: item.id },
  }, [svg(DEFERRED_DISMISS_SVG)]);

  // Two-line layout: title + action buttons share row 1; timestamp drops to
  // row 2 so the first line isn't crowded on a narrow sidebar column.
  const actions = el('div', { className: 'archive-item-actions' }, [
    restoreBtn,
    deleteBtn,
  ]);

  const main = el('div', { className: 'archive-item-main' }, [link, actions]);

  return el('div', {
    className: 'archive-item',
    dataset: { deferredId: item.id },
  }, [
    main,
    el('span', { className: 'archive-item-date', textContent: ago }),
  ]);
}

// Force-restart a CSS animation on an element that's already in the DOM.
// Needed because `.deferred-empty` / `.deferred-archive` are static HTML
// nodes whose `display:none → block` switch does NOT re-trigger their
// CSS animation in Chrome. Clearing inline `animation`, forcing a reflow,
// then re-clearing it lets the stylesheet rule kick back in from frame 0.
// (`.deferred-item` doesn't need this because mount() replaces those
// nodes — a fresh DOM insertion triggers animation naturally.)
function restartAnim(elem: HTMLElement | null): void {
  if (!elem) return;
  elem.style.animation = 'none';
  void elem.offsetHeight; // force reflow
  elem.style.animation = '';
}

// Waterfall on page-load only. Event-driven re-renders (save / check /
// dismiss / delete / clear all) must NOT stagger — the column would flash
// each time. Callers opt in via { waterfall: true } and the list has a
// single .animate-in class that scopes the CSS keyframes + nth-child delays.
export async function renderDeferredColumn(
  options: { waterfall?: boolean } = {},
): Promise<void> {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');
  const archiveClearEl = document.getElementById('archiveClearAll');

  if (!column) return;

  // Column + Archive header stay mounted even when both lists are empty so
  // the layout doesn't collapse on a fresh install / after Clear all. Empty
  // states fill the inner slots instead. Keep display manipulation here
  // but never replay the entrance animation — CSS covers page-load.
  column.style.display = 'block';
  if (archiveEl) archiveEl.style.display = 'block';

  try {
    const data = await getDeferred();

    const active   = data.active   || [];
    const archived = data.archived || [];

    if (active.length > 0 && list && empty && countEl) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      // Toggle the waterfall class BEFORE mount so the new DOM nodes pick
      // up the keyframes on first paint. Without waterfall we clear it so
      // a save-after-load doesn't re-fire the stagger.
      list.classList.toggle('animate-in', Boolean(options.waterfall));
      mount(list, active.map(renderDeferredItem));
      list.style.display = 'block';
      empty.style.display = 'none';
    } else if (list && empty && countEl) {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
      restartAnim(empty);
    }

    if (archiveCountEl && archiveList) {
      if (archived.length > 0) {
        archiveCountEl.textContent = `(${archived.length})`;
        mount(archiveList, archived.map(renderArchiveItem));
        if (archiveClearEl) archiveClearEl.style.display = '';
      } else {
        archiveCountEl.textContent = '';
        // Empty state placeholder — shown inside the expandable body so the
        // toggle still works and users see a clear "there's nothing here yet"
        // rather than an invisible void.
        mount(archiveList, el('div', {
          className: 'archive-empty',
          textContent: 'No archived tabs yet.',
        }));
        if (archiveClearEl) archiveClearEl.style.display = 'none';
      }
    }
    // Do NOT restart the archive container animation here. Every save /
    // check / dismiss triggers renderDeferredColumn; replaying the outer
    // fadeUp each time makes the right column flash on every mutation.
    // The page-load entrance is covered by the CSS rule on .deferred-archive.
  } catch (err) {
    console.warn('[tab-out] Could not load deferred tabs:', err);
    // Leave the column visible; swallowing state on storage errors is what
    // the caller already does for getUpdateStatus, and hiding the whole
    // saved-for-later surface would lose the user's affordance to re-try.
  }
}
