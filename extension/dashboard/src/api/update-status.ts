// Update-banner state — read by the dashboard, written by background.js
// every 48h after a chrome.alarms tick. Split out from api.ts so the
// deferred-tabs flow doesn't have to share a file with this unrelated
// storage key.

export const UPDATE_STATUS_KEY = 'tabout:updateStatus';

// Public shape the dashboard renders.
export interface UpdateStatus {
  updateAvailable: boolean;
  currentTag?: string;
  checkedAt?: string;
}

// On-disk shape written by background.js checkForUpdate(). All fields
// optional because a fresh install may have no key yet. Tags (release
// tag_name) rather than commit shas so non-release pushes don't trigger
// the banner.
interface UpdateStatusStorage {
  updateAvailable?: boolean;
  latestTag?: string;
  currentTag?: string;
  checkedAt?: string;
  dismissedTag?: string | null;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      return { updateAvailable: false };
    }
    const result = await chrome.storage.local.get(UPDATE_STATUS_KEY);
    const s = (result as Record<string, UpdateStatusStorage>)[UPDATE_STATUS_KEY];
    if (!s) return { updateAvailable: false };
    // Banner stays dismissed until a *new* release comes out (dismissedTag
    // tracks the last latestTag the user dismissed against).
    const suppressedByDismiss = s.dismissedTag != null && s.dismissedTag === s.latestTag;
    return {
      updateAvailable: Boolean(s.updateAvailable) && !suppressedByDismiss,
      currentTag: s.currentTag,
      checkedAt: s.checkedAt,
    };
  } catch {
    return { updateAvailable: false };
  }
}

// Persist banner dismissal: read the latest update record and stamp
// dismissedTag = latestTag so the banner stays hidden until a new
// release lands. Silent on failure — the UI already removed the banner
// element; storage persistence is a best-effort concern.
export async function dismissUpdateBanner(): Promise<void> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const result = await chrome.storage.local.get(UPDATE_STATUS_KEY);
    const s = (result as Record<string, UpdateStatusStorage | undefined>)[UPDATE_STATUS_KEY];
    if (!s?.latestTag) return;
    await chrome.storage.local.set({
      [UPDATE_STATUS_KEY]: { ...s, dismissedTag: s.latestTag },
    });
  } catch {
    // noop
  }
}
