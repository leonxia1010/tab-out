// Dashboard entry point (Phase 2 PR A + B).
//
// Bridges ESM modules to the legacy window.* globals that app.js reads while
// we drain the god file. PR G removes app.js and the window.* bridge entirely.

import { el, mount, svg } from './dom-utils.js';
import * as utils from './utils.js';

declare global {
  interface Window {
    domUtils: {
      el: typeof el;
      svg: typeof svg;
      mount: typeof mount;
    };
    utils: typeof utils;
  }
}

window.domUtils = { el, svg, mount };
window.utils = utils;
