/* ================================================================
   Tab Out — Dashboard bootstrap (Phase 2 PR F).

   All logic now lives in dashboard/src/*.ts (loaded via dist/index.js).
   This file just kicks off the initial render and the read-only update
   check. PR G folds both calls into index.ts and deletes app.js.
   ================================================================ */

'use strict';

async function checkForUpdates() {
  try {
    const res = await fetch('/api/update-status');
    if (!res.ok) return;
    const { updateAvailable } = await res.json();
    if (!updateAvailable) return;

    const footer = document.querySelector('footer');
    if (!footer) return;
    const notice = document.createElement('div');
    notice.style.cssText = 'text-align:center; padding:8px; font-size:12px; color:var(--muted);';
    // Developer-authored static string, no user data. innerHTML is safe here.
    notice.innerHTML = 'A new version of Tab Out is available. Run <code style="background:var(--warm-gray);padding:2px 6px;border-radius:3px;font-size:11px;user-select:all;cursor:pointer;" title="Click to select">git pull https://github.com/leonxia1010/tab-out</code> to update.';
    footer.after(notice);
  } catch {}
}

window.renderers.renderDashboard();
checkForUpdates();
