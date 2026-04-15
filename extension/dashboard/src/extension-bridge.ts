// Tab Out dashboard — postMessage bridge to the Chrome extension (Phase 2 PR C).
//
// The dashboard runs inside an iframe under the extension's new-tab page and
// cannot call chrome.tabs.* directly. Every privileged action round-trips
// through window.postMessage with a 3-second timeout and a graceful fallback
// when the extension is absent (dev mode in a plain browser tab).
//
// Phase 3 deletes the local server and shifts the dashboard to talk to the
// extension directly, which may obsolete fetchMissionById and a few others;
// the public API exported here stays stable so app.js does not care.

import {
  getExtensionAvailable,
  getOpenTabs,
  setExtensionAvailable,
  setOpenTabs,
  type Tab,
} from './state.js';
import { getMissions, type Mission } from './api.js';

export interface BridgeResponse {
  success: boolean;
  reason?: string;
  tabs?: Tab[];
  messageId?: string;
  [key: string]: unknown;
}

const MESSAGE_TIMEOUT_MS = 3000;

export function sendToExtension(
  action: string,
  data: Record<string, unknown> = {},
): Promise<BridgeResponse> {
  return new Promise((resolve) => {
    if (window.parent === window) {
      resolve({ success: false, reason: 'not-in-extension' });
      return;
    }

    const extOrigin = window.location.ancestorOrigins?.[0] || '*';
    const messageId = 'tmc-' + Math.random().toString(36).slice(2);

    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, MESSAGE_TIMEOUT_MS);

    function handler(event: MessageEvent) {
      if (extOrigin !== '*' && event.origin !== extOrigin) return;
      if (event.data && event.data.messageId === messageId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(event.data as BridgeResponse);
      }
    }

    window.addEventListener('message', handler);
    window.parent.postMessage({ action, messageId, ...data }, extOrigin);
  });
}

export async function fetchOpenTabs(): Promise<void> {
  const result = await sendToExtension('getTabs');
  if (result && result.success && Array.isArray(result.tabs)) {
    setOpenTabs(result.tabs);
    setExtensionAvailable(true);
  } else {
    setOpenTabs([]);
    setExtensionAvailable(false);
  }
}

export async function closeTabsByUrls(urls: string[]): Promise<void> {
  if (!getExtensionAvailable() || !urls || urls.length === 0) return;
  await sendToExtension('closeTabs', { urls });
  await fetchOpenTabs();
}

export async function focusTabsByUrls(urls: string[]): Promise<void> {
  if (!getExtensionAvailable() || !urls || urls.length === 0) return;
  await sendToExtension('focusTabs', { urls });
}

export function checkTabOutDupes(): void {
  const tabOutTabs = getOpenTabs().filter((t) => t.isTabOut);

  const banner = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = String(tabOutTabs.length);
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

export async function fetchMissionById(
  missionId: number | string,
): Promise<Mission | null> {
  try {
    const missions = await getMissions();
    return missions.find((m) => String(m.id) === String(missionId)) || null;
  } catch {
    return null;
  }
}
