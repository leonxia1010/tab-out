// tests/dashboard/parity.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Guards the byte-level parity contract between each src/*.ts module and its
// hand-written legacy IIFE mirror (dashboard/<name>.js). The browser loads the
// ESM build from dist/, but render.test.js injects the legacy IIFEs into a
// JSDOM window — so drift between the two is invisible to the browser but
// silently corrupts the JSDOM-based test surface.
//
// Smoke-level check: for each mirror, JSDOM-inject the legacy IIFE and compare
// its runtime keys (Object.keys(window.X) filtered to functions) against the
// TS module's runtime exports. `tsOnly` captures deliberate TS-only exports
// (e.g. sanitizeHref is an internal helper used by el() and not exposed via
// the window bridge).
//
// PR G deletes all legacy mirrors + this test file in one pass.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as domUtils from '../../dashboard/src/dom-utils.ts';
import * as utils from '../../dashboard/src/utils.ts';
import * as state from '../../dashboard/src/state.ts';
import * as extensionBridge from '../../dashboard/src/extension-bridge.ts';
import * as animations from '../../dashboard/src/animations.ts';
import * as renderers from '../../dashboard/src/renderers.ts';
import * as handlers from '../../dashboard/src/handlers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const legacyPath = (name) => path.resolve(__dirname, `../../dashboard/${name}.js`);

const MIRRORS = [
  { name: 'dom-utils',        windowKey: 'domUtils',        tsModule: domUtils,        tsOnly: ['sanitizeHref'], deps: [] },
  { name: 'utils',            windowKey: 'utils',           tsModule: utils,           tsOnly: [], deps: [] },
  { name: 'state',            windowKey: 'state',           tsModule: state,           tsOnly: [], deps: [] },
  { name: 'extension-bridge', windowKey: 'extensionBridge', tsModule: extensionBridge, tsOnly: [], deps: ['state'] },
  { name: 'animations',       windowKey: 'animations',      tsModule: animations,      tsOnly: [], deps: [] },
  { name: 'renderers',        windowKey: 'renderers',       tsModule: renderers,       tsOnly: [], deps: ['dom-utils', 'utils', 'state', 'extension-bridge'] },
  { name: 'handlers',         windowKey: 'handlers',        tsModule: handlers,        tsOnly: [], deps: ['dom-utils', 'utils', 'state', 'extension-bridge', 'animations', 'renderers'] },
];

function injectLegacy(win, src) {
  const script = win.document.createElement('script');
  script.textContent = src;
  win.document.head.appendChild(script);
}

function injectByName(win, name) {
  injectLegacy(win, fs.readFileSync(legacyPath(name), 'utf8'));
}

function functionKeys(obj) {
  return new Set(Object.keys(obj).filter((k) => typeof obj[k] === 'function'));
}

describe('legacy IIFE ↔ src/*.ts runtime parity', () => {
  for (const m of MIRRORS) {
    it(`${m.name}: window.${m.windowKey} keys match src/${m.name}.ts (minus tsOnly=${JSON.stringify(m.tsOnly)})`, () => {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
        runScripts: 'dangerously',
      });
      const win = dom.window;
      win.fetch = () => Promise.reject(new Error('parity test'));

      // Inject the mirror's dependencies first so its IIFE can read window.X.
      for (const dep of m.deps) {
        injectByName(win, dep);
      }
      injectByName(win, m.name);

      const iifeObj = win[m.windowKey];
      expect(iifeObj, `window.${m.windowKey} must be set by legacy IIFE`).toBeTypeOf('object');

      const iifeKeys = functionKeys(iifeObj);
      const tsKeys = functionKeys(m.tsModule);
      const tsOnly = new Set(m.tsOnly);

      const expectedIifeKeys = new Set([...tsKeys].filter((k) => !tsOnly.has(k)));

      // Assert: IIFE exposes exactly the TS runtime exports, minus declared tsOnly.
      expect(
        iifeKeys,
        `IIFE keys must match TS exports. iife=${JSON.stringify([...iifeKeys].sort())} ` +
          `tsExpected=${JSON.stringify([...expectedIifeKeys].sort())}`,
      ).toEqual(expectedIifeKeys);

      // Sanity: every IIFE value is callable (catches accidental downgrade to plain data).
      for (const k of iifeKeys) {
        expect(typeof iifeObj[k]).toBe('function');
      }
    });
  }
});
