/**
 * Legacy IIFE mirror of dashboard/src/state.ts (Phase 2 PR C).
 *
 * The browser loads the ESM build from dist/state.js (via dist/index.js).
 * This file exists ONLY so tests/dashboard/render.test.js can inject it
 * into a JSDOM window via <script> string injection — the same dual-load
 * pattern used for dom-utils.js and utils.js. PR G deletes all legacy
 * mirrors in one pass.
 *
 * Contract: keep byte-level parity with src/state.ts. Any new field
 * must be added to both places.
 */
(function () {
  'use strict';

  var openTabs = [];
  var extensionAvailable = false;
  var domainGroups = [];
  var duplicateTabs = [];

  window.state = {
    getOpenTabs: function () { return openTabs; },
    setOpenTabs: function (tabs) { openTabs = tabs; },
    getExtensionAvailable: function () { return extensionAvailable; },
    setExtensionAvailable: function (value) { extensionAvailable = value; },
    getDomainGroups: function () { return domainGroups; },
    setDomainGroups: function (groups) { domainGroups = groups; },
    getDuplicateTabs: function () { return duplicateTabs; },
    setDuplicateTabs: function (tabs) { duplicateTabs = tabs; },
  };
})();
