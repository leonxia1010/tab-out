// Dashboard entry point (Phase 2 PR G — final).
//
// Single ESM module the browser loads via `<script type="module">`. Owns:
//   - module wiring (each src/*.ts file is imported here)
//   - bootstrap: renderDashboard() + checkForUpdates() on load
//   - event listener attach (handlers.attachListeners is idempotent)
//
// The window.* bridge that PR A-F maintained for the legacy app.js is gone.
// All consumers are pure ESM modules now.

import * as handlers from './handlers.js';
import { renderDashboard } from './renderers.js';
import { getUpdateStatus } from './api.js';

async function checkForUpdates(): Promise<void> {
  try {
    const body = await getUpdateStatus();
    if (!body.updateAvailable) return;

    const footer = document.querySelector('footer');
    if (!footer) return;
    const notice = document.createElement('div');
    notice.style.cssText = 'text-align:center; padding:8px; font-size:12px; color:var(--muted);';
    // Developer-authored static string, no user data — innerHTML is safe.
    notice.innerHTML =
      'A new version of Tab Out is available. Run ' +
      '<code style="background:var(--warm-gray);padding:2px 6px;border-radius:3px;font-size:11px;user-select:all;cursor:pointer;" title="Click to select">' +
      'git pull https://github.com/leonxia1010/tab-out</code> to update.';
    footer.after(notice);
  } catch {
    // Network failure or parse error — silently no-op (no notice shown).
  }
}

handlers.attachListeners();
void renderDashboard();
void checkForUpdates();
