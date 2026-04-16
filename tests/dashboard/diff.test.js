// @vitest-environment jsdom
// tests/dashboard/diff.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 PR 3 — card-level diff.
//
// applyOpenTabsDiff() drives event-driven refreshes without the full mount.
// These tests exercise the five rules spelled out in
// plan/glistening-splashing-taco.md:
//
//   1. No full re-render on every tab change (unchanged signature → no-op)
//   2. Added card → only that card gets appended with fadeUp
//   3. Removed card → only that card calls animateCardOut
//   4. Order reshuffle → fall back to full mount (renderOpenTabsOnly)
//   5. Chip moves from A → B → both A and B rebuild, others untouched
//
// We mock:
//   - renderers.renderOpenTabsOnly (spy — detect full-mount fallback path)
//   - animations.animateCardOut (spy — detect remove path + avoid 300ms timer)
//   - extension-bridge.checkTabOutDupes (spy — phase-3 side effect)
//
// Everything else (renderDomainCard, groupTabsByDomain, signatureForDomainCard,
// renderOpenTabsHeader) runs for real against jsdom. This lets us assert on
// actual .domain-card nodes.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

function makeTab(url, index, extra = {}) {
  return { url, title: extra.title ?? url, index, id: extra.id ?? index + 1, ...extra };
}

function setupDashboardDOM() {
  document.body.innerHTML = `
    <div class="active-section" id="openTabsSection" style="display:none">
      <header>
        <h2 id="openTabsSectionTitle"></h2>
        <div class="section-count" id="openTabsSectionCount"></div>
      </header>
      <div class="domains" id="openTabsDomains"></div>
    </div>
    <div id="statTabs"></div>
    <div id="tabOutDupeBanner" style="display:none"><span id="tabOutDupeCount"></span></div>
  `;
}

async function loadDiff({ renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy }) {
  vi.doMock('../../extension/dashboard/src/animations.ts', () => ({
    animateCardOut: animateCardOutSpy,
    // playCloseSound / showToast / shootConfetti not used by diff.ts but
    // leaving them exported keeps other modules happy if jsdom resolves them.
    playCloseSound: vi.fn(),
    shootConfetti: vi.fn(),
    showToast: vi.fn(),
  }));
  vi.doMock('../../extension/dashboard/src/renderers.ts', async () => {
    const actual = await vi.importActual('../../extension/dashboard/src/renderers.ts');
    return { ...actual, renderOpenTabsOnly: renderOpenTabsOnlySpy };
  });
  vi.doMock('../../extension/dashboard/src/extension-bridge.ts', async () => {
    const actual = await vi.importActual('../../extension/dashboard/src/extension-bridge.ts');
    return { ...actual, checkTabOutDupes: checkTabOutDupesSpy };
  });

  const state = await import('../../extension/dashboard/src/state.ts');
  const renderers = await import('../../extension/dashboard/src/renderers.ts');
  const diff = await import('../../extension/dashboard/src/diff.ts');

  return { state, renderers, diff };
}

// Seed the DOM with cards for the given tab-set via renderDomainCard
// (unmocked, real DOM output) so subsequent diff calls have a realistic
// starting point. Mirrors what renderOpenTabsSection does on page load.
function seedCards(renderers, state, tabs) {
  state.setOpenTabs(tabs);
  const groups = renderers.groupTabsByDomain(tabs);
  state.setDomainGroups(groups);
  const container = document.getElementById('openTabsDomains');
  container.innerHTML = '';
  groups.forEach((g, i) => container.appendChild(renderers.renderDomainCard(g, i)));
}

function domainIds() {
  return Array.from(
    document.querySelectorAll('#openTabsDomains .domain-card'),
  ).map((c) => c.dataset.domainId);
}

beforeEach(() => {
  vi.resetModules();
  setupDashboardDOM();
});

afterEach(() => {
  vi.doUnmock('../../extension/dashboard/src/animations.ts');
  vi.doUnmock('../../extension/dashboard/src/renderers.ts');
  vi.doUnmock('../../extension/dashboard/src/extension-bridge.ts');
  vi.restoreAllMocks();
});

describe('applyOpenTabsDiff — rule 1: signature unchanged', () => {
  it('no DOM mutation, no renderOpenTabsOnly fallback', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const animateCardOutSpy = vi.fn();
    const checkTabOutDupesSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy,
    });

    const tabs = [
      makeTab('https://github.com/a', 0),
      makeTab('https://github.com/b', 1),
    ];
    seedCards(renderers, state, tabs);
    const before = document.getElementById('openTabsDomains').innerHTML;

    // Identical state — no change.
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).not.toHaveBeenCalled();
    expect(animateCardOutSpy).not.toHaveBeenCalled();
    expect(document.getElementById('openTabsDomains').innerHTML).toBe(before);
  });
});

describe('applyOpenTabsDiff — rule 2: card added', () => {
  it('appends one new card without touching existing ones', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const animateCardOutSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy: vi.fn(),
    });

    const initial = [makeTab('https://github.com/a', 0)];
    seedCards(renderers, state, initial);
    const ghCardBefore = document.querySelector('[data-domain-id="domain-github-com"]');

    const updated = [
      ...initial,
      makeTab('https://stackoverflow.com/q/1', 1),
    ];
    state.setOpenTabs(updated);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).not.toHaveBeenCalled();
    expect(animateCardOutSpy).not.toHaveBeenCalled();

    const ids = domainIds();
    expect(ids).toEqual(['domain-github-com', 'domain-stackoverflow-com']);

    const ghCardAfter = document.querySelector('[data-domain-id="domain-github-com"]');
    expect(ghCardAfter).toBe(ghCardBefore); // same node → not rebuilt
  });

  it('inserts new card at sorted position, not just at the end', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const animateCardOutSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy: vi.fn(),
    });

    // Seed with github (index 0) and stackoverflow (index 2). Leaves a gap
    // so a later index=1 tab for a new domain sorts BETWEEN them.
    const initial = [
      makeTab('https://github.com/a', 0),
      makeTab('https://stackoverflow.com/q/1', 2),
    ];
    seedCards(renderers, state, initial);

    const updated = [
      ...initial,
      makeTab('https://news.ycombinator.com/item', 1),
    ];
    state.setOpenTabs(updated);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).not.toHaveBeenCalled();
    // First-seen sort places Hacker News between github and stackoverflow.
    expect(domainIds()).toEqual([
      'domain-github-com',
      'domain-news-ycombinator-com',
      'domain-stackoverflow-com',
    ]);
  });
});

describe('applyOpenTabsDiff — rule 3: card removed', () => {
  it('calls animateCardOut only on the vanished domain', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const animateCardOutSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy: vi.fn(),
    });

    const initial = [
      makeTab('https://github.com/a', 0),
      makeTab('https://stackoverflow.com/q/1', 1),
    ];
    seedCards(renderers, state, initial);

    // User closed the only stackoverflow tab externally.
    state.setOpenTabs([initial[0]]);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).not.toHaveBeenCalled();
    expect(animateCardOutSpy).toHaveBeenCalledTimes(1);
    const [cardArg] = animateCardOutSpy.mock.calls[0];
    expect(cardArg.dataset.domainId).toBe('domain-stackoverflow-com');
  });
});

describe('applyOpenTabsDiff — rule 4: order reshuffle', () => {
  it('falls back to renderOpenTabsOnly when shared ids reorder', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy,
      animateCardOutSpy: vi.fn(),
      checkTabOutDupesSpy: vi.fn(),
    });

    // Both domains are outside PRIORITY_HOSTNAMES, so the sort is purely
    // first-seen. Initial order: reddit (0), stackoverflow (1).
    seedCards(renderers, state, [
      makeTab('https://reddit.com/r/x', 0),
      makeTab('https://stackoverflow.com/q/1', 1),
    ]);

    // User dragged stackoverflow's tab to position 0, pushing reddit to 1.
    // First-seen sort reverses the order → rule 4.
    state.setOpenTabs([
      makeTab('https://stackoverflow.com/q/1', 0),
      makeTab('https://reddit.com/r/x', 1),
    ]);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).toHaveBeenCalledTimes(1);
  });
});

describe('applyOpenTabsDiff — rule 5: chip moves between cards', () => {
  it('rebuilds both source and target cards, leaves others untouched', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const animateCardOutSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy, animateCardOutSpy, checkTabOutDupesSpy: vi.fn(),
    });

    const initial = [
      makeTab('https://github.com/a', 0, { id: 10 }),
      makeTab('https://github.com/b', 1, { id: 11 }),
      makeTab('https://stackoverflow.com/q/1', 2, { id: 12 }),
      makeTab('https://news.ycombinator.com/item', 3, { id: 13 }),
    ];
    seedCards(renderers, state, initial);
    const beforeNodes = {
      github: document.querySelector('[data-domain-id="domain-github-com"]'),
      so:     document.querySelector('[data-domain-id="domain-stackoverflow-com"]'),
      hn:     document.querySelector('[data-domain-id="domain-news-ycombinator-com"]'),
    };

    // Tab id=11 navigated from github.com/b to stackoverflow.com/q/2.
    // github loses a tab, stackoverflow gains one, hn untouched.
    state.setOpenTabs([
      initial[0],
      makeTab('https://stackoverflow.com/q/2', 1, { id: 11 }),
      initial[2],
      initial[3],
    ]);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).not.toHaveBeenCalled();
    expect(animateCardOutSpy).not.toHaveBeenCalled();

    const afterNodes = {
      github: document.querySelector('[data-domain-id="domain-github-com"]'),
      so:     document.querySelector('[data-domain-id="domain-stackoverflow-com"]'),
      hn:     document.querySelector('[data-domain-id="domain-news-ycombinator-com"]'),
    };
    expect(afterNodes.github).not.toBe(beforeNodes.github); // rebuilt
    expect(afterNodes.so).not.toBe(beforeNodes.so);         // rebuilt
    expect(afterNodes.hn).toBe(beforeNodes.hn);             // untouched
  });

  it('suppresses fadeUp animation on rebuilt cards (no opacity blink)', async () => {
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy: vi.fn(async () => {}),
      animateCardOutSpy: vi.fn(),
      checkTabOutDupesSpy: vi.fn(),
    });

    seedCards(renderers, state, [makeTab('https://github.com/a', 0)]);
    state.setOpenTabs([
      makeTab('https://github.com/a', 0),
      makeTab('https://github.com/b', 1),
    ]);
    await diff.applyOpenTabsDiff();

    const gh = document.querySelector('[data-domain-id="domain-github-com"]');
    // style.animation should explicitly suppress fadeUp on rebuild.
    // (Added cards DO animate; this case is a same-id rebuild.)
    expect(gh.style.animation).toBe('none');
  });
});

describe('applyOpenTabsDiff — fallback paths', () => {
  it('initial empty DOM → fallback to renderOpenTabsOnly (kick off waterfall)', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const { state, diff } = await loadDiff({
      renderOpenTabsOnlySpy,
      animateCardOutSpy: vi.fn(),
      checkTabOutDupesSpy: vi.fn(),
    });

    state.setOpenTabs([makeTab('https://github.com/a', 0)]);
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).toHaveBeenCalledTimes(1);
  });

  it('sortedGroups empty → fallback so renderers paints inbox-zero state', async () => {
    const renderOpenTabsOnlySpy = vi.fn(async () => {});
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy,
      animateCardOutSpy: vi.fn(),
      checkTabOutDupesSpy: vi.fn(),
    });

    seedCards(renderers, state, [makeTab('https://github.com/a', 0)]);
    state.setOpenTabs([]); // every tab was closed
    await diff.applyOpenTabsDiff();

    expect(renderOpenTabsOnlySpy).toHaveBeenCalledTimes(1);
  });
});

describe('applyOpenTabsDiff — phase 3 side effects', () => {
  it('updates statTabs count and calls checkTabOutDupes on the fast path', async () => {
    const checkTabOutDupesSpy = vi.fn();
    const { state, renderers, diff } = await loadDiff({
      renderOpenTabsOnlySpy: vi.fn(async () => {}),
      animateCardOutSpy: vi.fn(),
      checkTabOutDupesSpy,
    });

    seedCards(renderers, state, [makeTab('https://github.com/a', 0)]);
    state.setOpenTabs([
      makeTab('https://github.com/a', 0),
      makeTab('https://stackoverflow.com/q/1', 1),
    ]);
    await diff.applyOpenTabsDiff();

    expect(document.getElementById('statTabs').textContent).toBe('2');
    expect(checkTabOutDupesSpy).toHaveBeenCalledTimes(1);
  });
});
