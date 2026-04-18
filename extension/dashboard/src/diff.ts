// Card-level diff for the open-tabs grid. Applied on event-driven
// refreshes (chrome.tabs.on{Created,Removed,Updated}); page-load still
// renders the whole grid so the initial waterfall plays cleanly.
//
// Rules:
//   1. Don't re-render the whole grid on every tab change.
//   2. Adding a card → local fadeUp only.
//   3. Removing a card → animateCardOut only.
//   4. Card ORDER actually changed → fall back to full re-render.
//   5. Chip moves from card A → card B → both A and B rebuild (rewiring
//      URL-keyed handlers to tab ids was judged not worth the blast radius).
//
// Stable sort (first-seen by chrome tab.index) is the precondition that
// makes rule 4 fire only on REAL reshuffles (user drags a chrome tab).
// Without it, tab-count-descending sort would flip card order on every
// add/close and rule 4 would swallow rule 1.
//
// Animation coordination:
//   - Added card: renderDomainCard(group, 0) → inline animationDelay 0.25s,
//     same beat as header/column entrance. The CSS fadeUp rule runs.
//   - Rebuilt card: style.animationName = 'none' on the new node — a
//     silent DOM swap with no flash. Old node has been materialized and
//     visible, so any fade would visibly jank.
//   - Removed card: animateCardOut() (animations.ts) handles .closing
//     class + 300ms timeout + node.remove() + empty-state check.

import { animateCardOut } from './animations.js';
import { checkTabOutDupes } from './extension-bridge.js';
import {
  checkAndShowEmptyState,
  domainIdFor,
  groupTabsByDomain,
  renderDomainCard,
  renderOpenTabsHeader,
  renderOpenTabsOnly,
  signatureForDomainCard,
} from './renderers.js';
import { getOpenTabs, setDomainGroups } from './state.js';
import { getDisplayableTabs } from './utils.js';

function sameSequence(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// For a group at `pivotIndex` in the new sorted order, find the nearest
// later-positioned group whose card already exists in the DOM. The
// returned id is the insertBefore anchor. null => append to the end.
function findAnchorAfter(
  domainIds: string[],
  pivotIndex: number,
  existing: Map<string, HTMLElement>,
): string | null {
  for (let i = pivotIndex + 1; i < domainIds.length; i++) {
    if (existing.has(domainIds[i])) return domainIds[i];
  }
  return null;
}

export async function applyOpenTabsDiff(): Promise<void> {
  const realTabs = getDisplayableTabs(getOpenTabs());
  const sortedGroups = groupTabsByDomain(realTabs);
  setDomainGroups(sortedGroups);

  const container = document.getElementById('openTabsDomains');
  if (!container) return;

  // Skip-to-full-render conditions:
  //   a) no groups → renderOpenTabsOnly paints the inbox-zero empty state
  //      (renderOpenTabsSection already handles this edge — don't
  //      duplicate that logic here).
  //   b) no live cards in DOM → either first render or we're coming out
  //      of an empty state; either way we want the staggered waterfall
  //      that renderOpenTabsOnly gives us.
  //
  // `:not(.closing)` filters out cards mid-animateCardOut so they don't
  // pollute the Map lookups. The 500ms debounce in refresh.ts > 300ms
  // animation means they're usually gone by the next diff anyway, but
  // rapid-fire events can still race.
  const liveCards = Array.from(
    container.querySelectorAll<HTMLElement>('.domain-card:not(.closing)'),
  );
  if (sortedGroups.length === 0 || liveCards.length === 0) {
    await renderOpenTabsOnly();
    return;
  }

  const existing = new Map<string, HTMLElement>();
  for (const card of liveCards) {
    const id = card.dataset.domainId;
    if (id) existing.set(id, card);
  }

  // Phase 1: reshuffle check. Compare relative order of ids that appear
  // in BOTH new and old sets. If it differs, rule 4 kicks in.
  const newIds = sortedGroups.map((g) => domainIdFor(g.domain));
  const liveSharedInOrder = liveCards
    .map((c) => c.dataset.domainId || '')
    .filter((id) => id && existing.has(id) && newIds.includes(id));
  const newSharedInOrder = newIds.filter((id) => existing.has(id));
  if (!sameSequence(liveSharedInOrder, newSharedInOrder)) {
    await renderOpenTabsOnly();
    return;
  }

  // Phase 2: set diff.
  //
  // Order matters: rebuild BEFORE add. A freshly inserted card could
  // otherwise be used as the insertBefore anchor for a neighbor, and we'd
  // rebuild that anchor the next iteration — wasted work and a flicker
  // risk. Rebuilding kept cards first locks the layout, then add fits
  // into a stable skeleton.

  // --- Rebuild-or-skip pass (kept ids).
  sortedGroups.forEach((group, idx) => {
    const id = domainIdFor(group.domain);
    const oldCard = existing.get(id);
    if (!oldCard) return;

    const sig = signatureForDomainCard(group);
    if (oldCard.dataset.signature === sig) return; // unchanged — rule 1 hold

    const newCard = renderDomainCard(group, idx);
    // Silent DOM swap: suppress fadeUp so the user doesn't see an opacity
    // blink on a card that was already visible.
    newCard.style.animation = 'none';
    oldCard.replaceWith(newCard);
    // replaceWith detached oldCard; the Map must now point at the live
    // node in case the add pass needs it as an insertBefore anchor.
    existing.set(id, newCard);
  });

  // --- Add pass (ids new to the DOM).
  sortedGroups.forEach((group, idx) => {
    const id = domainIdFor(group.domain);
    if (existing.has(id)) return;

    // Pass groupIndex=0 so a late-arriving solo card appears at 0.25s,
    // not 0.25 + (its final sorted-index) * 0.05. Otherwise a single
    // card added 6th would wait 0.55s and feel laggy.
    const newCard = renderDomainCard(group, 0);

    const anchorId = findAnchorAfter(newIds, idx, existing);
    const anchor = anchorId ? existing.get(anchorId) ?? null : null;
    if (anchor) container.insertBefore(newCard, anchor);
    else container.appendChild(newCard);
    existing.set(id, newCard);
  });

  // --- Remove pass (ids that disappeared).
  const newIdSet = new Set(newIds);
  for (const [id, card] of existing) {
    if (!newIdSet.has(id)) animateCardOut(card, checkAndShowEmptyState);
  }

  // Phase 3: match renderOpenTabsOnly()'s side-effect contract so whichever
  // path refresh.ts took, the rest of the page ends up consistent.
  renderOpenTabsHeader(sortedGroups, realTabs.length);
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = String(getOpenTabs().length);
  checkTabOutDupes();
}
