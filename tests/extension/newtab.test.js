// tests/extension/newtab.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Tests for extension/newtab.js — the postMessage bridge between the dashboard
// iframe and Chrome's tabs API.
//
// newtab.js is a plain Chrome MV3 script (not ES module); it depends on globals
// (window, document, chrome, fetch, URL). We use node:vm to run it inside a
// sandbox we control, then drive the message handler directly.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChromeMock } from './helpers/chrome-mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NEWTAB_PATH = path.resolve(__dirname, '../../extension/newtab.js');
const NEWTAB_SRC = fs.readFileSync(NEWTAB_PATH, 'utf8');
// Pre-compile once so V8 sees a single Script with a real filename — this
// lets the V8 coverage provider attribute hits to extension/newtab.js.
const NEWTAB_SCRIPT = new vm.Script(NEWTAB_SRC, { filename: NEWTAB_PATH });

// ─── Sandbox factory ─────────────────────────────────────────────────────────
// Builds a sandbox, evaluates newtab.js in it, returns helpers to drive the
// registered message handler.
function buildSandbox({ tabs = [], extensionId = 'testextid', currentWindowId = 100 } = {}) {
  const { state, chrome } = createChromeMock({ tabs, extensionId, currentWindowId });

  // Fake DOM elements — newtab.js only touches classList + addEventListener +
  // contentWindow.postMessage on these two elements.
  const postedMessages = [];
  const frameContentWindow = {
    postMessage: vi.fn((data, origin) => {
      postedMessages.push({ data, origin });
    }),
  };
  const frame = {
    classList: { add: vi.fn(), remove: vi.fn(), has: vi.fn() },
    addEventListener: vi.fn(),
    contentWindow: frameContentWindow,
  };
  const fallback = {
    classList: { add: vi.fn(), remove: vi.fn(), has: vi.fn() },
  };

  const document = {
    getElementById: vi.fn((id) => {
      if (id === 'dashboard-frame') return frame;
      if (id === 'fallback') return fallback;
      return null;
    }),
  };

  // Record 'message' listeners so we can invoke them from tests.
  const listeners = { message: [] };
  const sandboxWindow = {
    addEventListener: (type, fn) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
  };

  const fetch = vi.fn(() => Promise.resolve({ ok: true }));

  const sandbox = {
    window: sandboxWindow,
    document,
    chrome,
    fetch,
    URL,
    console,
    setTimeout,
    clearTimeout,
  };
  // Make window.X === X accessible as bare globals (like a browser)
  Object.assign(sandbox, sandboxWindow);

  const context = vm.createContext(sandbox);
  NEWTAB_SCRIPT.runInContext(context);

  async function dispatchMessage({ origin = 'http://localhost:3456', data }) {
    const handlers = listeners.message;
    if (!handlers || handlers.length === 0) {
      throw new Error('No message listener registered');
    }
    // newtab.js registers exactly one handler; invoke and await it.
    for (const h of handlers) {
      await h({ origin, data });
    }
  }

  return {
    state,
    chrome,
    frame,
    fallback,
    postedMessages,
    dispatchMessage,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('newtab.js message handler — routing', () => {
  let env;

  beforeEach(() => {
    env = buildSandbox({ tabs: [] });
  });

  it('ignores message with wrong origin', async () => {
    await env.dispatchMessage({
      origin: 'https://evil.com',
      data: { messageId: 'abc', action: 'getTabs' },
    });
    expect(env.postedMessages).toHaveLength(0);
  });

  it('ignores message without messageId', async () => {
    await env.dispatchMessage({
      data: { action: 'getTabs' },
    });
    expect(env.postedMessages).toHaveLength(0);
  });

  it('ignores message without action', async () => {
    await env.dispatchMessage({
      data: { messageId: 'abc' },
    });
    expect(env.postedMessages).toHaveLength(0);
  });

  it('responds with error for unknown action', async () => {
    await env.dispatchMessage({
      data: { messageId: 'abc', action: 'notARealAction' },
    });
    expect(env.postedMessages).toHaveLength(1);
    expect(env.postedMessages[0].data.error).toMatch(/Unknown action/);
  });

  it('posts reply back to dashboard origin', async () => {
    await env.dispatchMessage({
      data: { messageId: 'abc', action: 'getTabs' },
    });
    expect(env.postedMessages[0].origin).toBe('http://localhost:3456');
    expect(env.postedMessages[0].data.messageId).toBe('abc');
  });
});

describe('action: getTabs', () => {
  it('returns trimmed tab fields', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://a.com/foo', title: 'A', windowId: 10, active: true, pinned: false, status: 'complete' },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'getTabs' },
    });
    const reply = env.postedMessages[0].data;
    expect(reply.success).toBe(true);
    expect(reply.tabs).toHaveLength(1);
    expect(reply.tabs[0]).toEqual({
      id: 1,
      url: 'https://a.com/foo',
      title: 'A',
      windowId: 10,
      active: true,
      isTabOut: false,
    });
    // No leaked keys like status/pinned
    expect(reply.tabs[0]).not.toHaveProperty('pinned');
    expect(reply.tabs[0]).not.toHaveProperty('status');
  });

  it('marks isTabOut=true for chrome://newtab/', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'chrome://newtab/', title: 'New Tab', windowId: 10, active: true },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'getTabs' },
    });
    expect(env.postedMessages[0].data.tabs[0].isTabOut).toBe(true);
  });

  it('marks isTabOut=true for extension newtab URL', async () => {
    const env = buildSandbox({
      extensionId: 'ext123',
      tabs: [
        { id: 2, url: 'chrome-extension://ext123/newtab.html', title: 'Tab Out', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'getTabs' },
    });
    expect(env.postedMessages[0].data.tabs[0].isTabOut).toBe(true);
  });
});

describe('action: closeTabs', () => {
  it('closes tabs whose hostname matches given URLs', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://twitter.com/foo',  title: 'F', windowId: 10, active: false },
        { id: 2, url: 'https://twitter.com/bar',  title: 'B', windowId: 10, active: false },
        { id: 3, url: 'https://reddit.com/baz',   title: 'R', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'closeTabs', urls: ['https://twitter.com/anything'] },
    });
    const reply = env.postedMessages[0].data;
    expect(reply.success).toBe(true);
    expect(reply.closedCount).toBe(2);
    expect(env.state.closedIds.sort()).toEqual([1, 2]);
  });

  it('handles empty urls array (closes nothing)', async () => {
    const env = buildSandbox({
      tabs: [{ id: 1, url: 'https://a.com', title: 'A', windowId: 10, active: false }],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'closeTabs', urls: [] },
    });
    expect(env.postedMessages[0].data.closedCount).toBe(0);
    expect(env.state.closedIds).toEqual([]);
  });

  it('exact mode closes tabs matching exact URL only', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox', windowId: 10, active: false },
        { id: 2, url: 'https://mail.google.com/mail/u/0/#thread/x', title: 'Thread', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'closeTabs',
        exact: true,
        urls: ['https://mail.google.com/mail/u/0/#inbox'],
      },
    });
    expect(env.state.closedIds).toEqual([1]);
  });

  it('matches file:// URLs exactly (no hostname available)', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'file:///Users/leon/doc.pdf', title: 'Doc', windowId: 10, active: false },
        { id: 2, url: 'file:///Users/leon/other.pdf', title: 'Other', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'closeTabs',
        urls: ['file:///Users/leon/doc.pdf'],
      },
    });
    expect(env.state.closedIds).toEqual([1]);
  });
});

describe('action: focusTab', () => {
  it('calls chrome.tabs.update and windows.update for exact URL match', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 5, url: 'https://a.com/target', title: 'T', windowId: 200, active: false },
      ],
      currentWindowId: 100,
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'focusTab', url: 'https://a.com/target' },
    });
    const reply = env.postedMessages[0].data;
    expect(reply.success).toBe(true);
    expect(reply.focusedTabId).toBe(5);
    expect(env.chrome.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(env.chrome.windows.update).toHaveBeenCalledWith(200, { focused: true });
  });

  it('returns error if no matching tab found', async () => {
    const env = buildSandbox({
      tabs: [{ id: 1, url: 'https://a.com', title: 'A', windowId: 10, active: false }],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'focusTab', url: 'https://nowhere.com' },
    });
    expect(env.postedMessages[0].data.error).toMatch(/not found/i);
  });
});

describe('action: closeDuplicates', () => {
  it('closes N-1 tabs per group of duplicates (keepOne=true)', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
        { id: 2, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
        { id: 3, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'closeDuplicates',
        urls: ['https://a.com/p'],
        keepOne: true,
      },
    });
    expect(env.postedMessages[0].data.closedCount).toBe(2);
    // Should keep exactly one (the first since none are active)
    expect(env.state.closedIds).toHaveLength(2);
    expect(env.state.closedIds).not.toContain(1);
  });

  it('keeps the active tab when duplicates include active', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
        { id: 2, url: 'https://a.com/p', title: 'A', windowId: 10, active: true },
        { id: 3, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'closeDuplicates',
        urls: ['https://a.com/p'],
        keepOne: true,
      },
    });
    expect(env.state.closedIds.sort()).toEqual([1, 3]);
  });

  it('keepOne=false closes all copies', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://a.com/p', title: 'A', windowId: 10, active: false },
        { id: 2, url: 'https://a.com/p', title: 'A', windowId: 10, active: true },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'closeDuplicates',
        urls: ['https://a.com/p'],
        keepOne: false,
      },
    });
    expect(env.state.closedIds.sort()).toEqual([1, 2]);
  });
});

describe('action: closeTabOutDupes', () => {
  it('closes all but one Tab Out tab', async () => {
    const env = buildSandbox({
      extensionId: 'ext123',
      tabs: [
        { id: 1, url: 'chrome-extension://ext123/newtab.html', title: 'Tab Out', windowId: 10, active: true },
        { id: 2, url: 'chrome-extension://ext123/newtab.html', title: 'Tab Out', windowId: 10, active: false },
        { id: 3, url: 'chrome://newtab/',                      title: 'New',     windowId: 10, active: false },
        { id: 4, url: 'https://a.com',                         title: 'A',       windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'closeTabOutDupes' },
    });
    expect(env.postedMessages[0].data.closedCount).toBe(2);
    expect(env.state.closedIds.sort()).toEqual([2, 3]);
  });

  it('returns closedCount=0 when only one Tab Out tab exists', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'chrome://newtab/', title: 'New', windowId: 10, active: true },
        { id: 2, url: 'https://a.com',    title: 'A',   windowId: 10, active: false },
      ],
    });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'closeTabOutDupes' },
    });
    expect(env.postedMessages[0].data.closedCount).toBe(0);
    expect(env.state.closedIds).toEqual([]);
  });
});

describe('action: focusTabs', () => {
  it('focuses first tab matching any URL hostname', async () => {
    const env = buildSandbox({
      tabs: [
        { id: 1, url: 'https://other.com',        title: 'O',  windowId: 10, active: false },
        { id: 2, url: 'https://target.com/page',  title: 'T',  windowId: 20, active: false },
      ],
    });
    await env.dispatchMessage({
      data: {
        messageId: 'm1',
        action: 'focusTabs',
        urls: ['https://target.com/anything'],
      },
    });
    expect(env.postedMessages[0].data.focusedTabId).toBe(2);
    expect(env.chrome.windows.update).toHaveBeenCalledWith(20, { focused: true });
  });

  it('returns error when urls array is empty', async () => {
    const env = buildSandbox({ tabs: [] });
    await env.dispatchMessage({
      data: { messageId: 'm1', action: 'focusTabs', urls: [] },
    });
    expect(env.postedMessages[0].data.error).toMatch(/no urls provided/i);
  });
});
