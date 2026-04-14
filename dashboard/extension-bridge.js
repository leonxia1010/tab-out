/**
 * Legacy IIFE mirror of dashboard/src/extension-bridge.ts (Phase 2 PR C).
 *
 * The browser loads the ESM build from dist/extension-bridge.js (via
 * dist/index.js). This file exists ONLY so tests/dashboard/render.test.js
 * can inject it into a JSDOM window via <script> string injection. PR G
 * deletes all legacy mirrors in one pass.
 *
 * Contract: keep byte-level parity with src/extension-bridge.ts.
 */
(function () {
  'use strict';

  var MESSAGE_TIMEOUT_MS = 3000;

  function sendToExtension(action, data) {
    data = data || {};
    return new Promise(function (resolve) {
      if (window.parent === window) {
        resolve({ success: false, reason: 'not-in-extension' });
        return;
      }

      var extOrigin = (window.location.ancestorOrigins && window.location.ancestorOrigins[0]) || '*';
      var messageId = 'tmc-' + Math.random().toString(36).slice(2);

      var timer = setTimeout(function () {
        window.removeEventListener('message', handler);
        resolve({ success: false, reason: 'timeout' });
      }, MESSAGE_TIMEOUT_MS);

      function handler(event) {
        if (extOrigin !== '*' && event.origin !== extOrigin) return;
        if (event.data && event.data.messageId === messageId) {
          clearTimeout(timer);
          window.removeEventListener('message', handler);
          resolve(event.data);
        }
      }

      window.addEventListener('message', handler);
      var payload = { action: action, messageId: messageId };
      for (var key in data) {
        if (Object.prototype.hasOwnProperty.call(data, key)) payload[key] = data[key];
      }
      window.parent.postMessage(payload, extOrigin);
    });
  }

  async function fetchOpenTabs() {
    var result = await sendToExtension('getTabs');
    if (result && result.success && Array.isArray(result.tabs)) {
      window.state.setOpenTabs(result.tabs);
      window.state.setExtensionAvailable(true);
    } else {
      window.state.setOpenTabs([]);
      window.state.setExtensionAvailable(false);
    }
  }

  async function closeTabsByUrls(urls) {
    if (!window.state.getExtensionAvailable() || !urls || urls.length === 0) return;
    await sendToExtension('closeTabs', { urls: urls });
    await fetchOpenTabs();
  }

  async function focusTabsByUrls(urls) {
    if (!window.state.getExtensionAvailable() || !urls || urls.length === 0) return;
    await sendToExtension('focusTabs', { urls: urls });
  }

  function checkTabOutDupes() {
    var tabOutTabs = window.state.getOpenTabs().filter(function (t) { return t.isTabOut; });

    var banner = document.getElementById('tabOutDupeBanner');
    var countEl = document.getElementById('tabOutDupeCount');
    if (!banner) return;

    if (tabOutTabs.length > 1) {
      if (countEl) countEl.textContent = String(tabOutTabs.length);
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }

  async function fetchMissionById(missionId) {
    try {
      var res = await fetch('/api/missions');
      if (!res.ok) return null;
      var missions = await res.json();
      return missions.find(function (m) { return String(m.id) === String(missionId); }) || null;
    } catch (e) {
      return null;
    }
  }

  window.extensionBridge = {
    sendToExtension: sendToExtension,
    fetchOpenTabs: fetchOpenTabs,
    closeTabsByUrls: closeTabsByUrls,
    focusTabsByUrls: focusTabsByUrls,
    checkTabOutDupes: checkTabOutDupes,
    fetchMissionById: fetchMissionById,
  };
})();
