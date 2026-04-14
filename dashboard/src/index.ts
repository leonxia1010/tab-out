// Dashboard entry point (Phase 2 PR A).
//
// Right now this only bridges the ESM dom-utils module to the legacy
// window.domUtils global that app.js reads. As PR B–G move functionality
// into TS modules under dashboard/src/, this file will grow to replace
// app.js entirely (then the legacy dashboard/dom-utils.js IIFE also dies).

import { el, mount, svg } from './dom-utils.js';

declare global {
  interface Window {
    domUtils: {
      el: typeof el;
      svg: typeof svg;
      mount: typeof mount;
    };
  }
}

window.domUtils = { el, svg, mount };
