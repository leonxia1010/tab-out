// Dashboard entry point (Phase 2 PR A + B + C + D + E + F).
//
// Bridges ESM modules to the legacy window.* globals that app.js reads while
// we drain the god file. Also wires the document-level event listeners via
// handlers.attachListeners() — app.js no longer registers its own listeners
// after PR F. PR G removes app.js and the window.* bridge entirely.

import { el, mount, svg } from './dom-utils.js';
import * as utils from './utils.js';
import * as state from './state.js';
import * as extensionBridge from './extension-bridge.js';
import * as animations from './animations.js';
import * as renderers from './renderers.js';
import * as handlers from './handlers.js';

declare global {
  interface Window {
    domUtils: {
      el: typeof el;
      svg: typeof svg;
      mount: typeof mount;
    };
    utils: typeof utils;
    state: typeof state;
    extensionBridge: typeof extensionBridge;
    animations: typeof animations;
    renderers: typeof renderers;
    handlers: typeof handlers;
  }
}

window.domUtils = { el, svg, mount };
window.utils = utils;
window.state = state;
window.extensionBridge = extensionBridge;
window.animations = animations;
window.renderers = renderers;
window.handlers = handlers;

handlers.attachListeners();
