// tests/extension/helpers/chrome-mock.js
// ─────────────────────────────────────────────────────────────────────────────
// Hand-rolled mock for the subset of the chrome.* API that newtab.js uses.
// Keeps an in-memory tab list plus a log of closed/updated/focused ids so
// tests can assert post-conditions.
// ─────────────────────────────────────────────────────────────────────────────

import { vi } from 'vitest';

export function createChromeMock({ tabs = [], extensionId = 'testextid', currentWindowId = 100 } = {}) {
  const state = {
    tabs: tabs.map(t => ({ ...t })),
    closedIds: [],
    updatedIds: [],
    focusedWindowIds: [],
  };

  const chrome = {
    runtime: { id: extensionId },
    tabs: {
      query: vi.fn(async () => state.tabs.map(t => ({ ...t }))),
      remove: vi.fn(async (ids) => {
        const arr = Array.isArray(ids) ? ids : [ids];
        state.closedIds.push(...arr);
        state.tabs = state.tabs.filter(t => !arr.includes(t.id));
      }),
      update: vi.fn(async (id, props) => {
        state.updatedIds.push({ id, props });
        const idx = state.tabs.findIndex(t => t.id === id);
        if (idx >= 0) {
          state.tabs[idx] = { ...state.tabs[idx], ...props };
        }
        return { id, ...props };
      }),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: currentWindowId })),
      update: vi.fn(async (id, props) => {
        state.focusedWindowIds.push({ id, props });
        return { id, ...props };
      }),
    },
  };

  return { state, chrome };
}
