# AGENTS.md — Tab Out: Onboarding

You're installing **Tab Out** for the user. It's a Chrome MV3 extension that replaces the new tab page with a domain-grouped tab dashboard. No server, no AI, all local.

This is the [`leonxia1010/tab-out`](https://github.com/leonxia1010/tab-out) fork. The [upstream](https://github.com/zarazhangrui/tab-out) version runs a local server with AI clustering; this one is just a single extension.

---

## Step 0 — Set expectations

Tell the user:

> **Tab Out** replaces your new tab page with a dashboard that shows everything you have open — grouped by domain. Close tabs with a swoosh + confetti. Save tabs for later. 100% local.

---

## Step 1 — Open the latest Release page

- macOS: `open https://github.com/leonxia1010/tab-out/releases/latest`
- Linux: `xdg-open https://github.com/leonxia1010/tab-out/releases/latest`
- Windows: `start https://github.com/leonxia1010/tab-out/releases/latest`

Tell them: "Download `tab-out-vX.Y.Z.zip` and unzip it."

---

## Step 2 — Load unpacked

1. `open "chrome://extensions"` (or platform equivalent).
2. Tell them: "Toggle **Developer mode** on (top-right corner)."
3. Tell them: "Click **Load unpacked** and pick the unzipped folder."
4. Open a fresh new tab — Tab Out should render.

---

## Step 3 — Walk them through

> 1. **Open a new tab** — tabs grouped by domain.
> 2. **Click any tab title** to jump to it (even across windows).
> 3. **"Close all N tabs"** on a group — swoosh + confetti.
> 4. **Bookmark icon** saves a tab for later before closing.
> 5. **Update banner** appears when a new release lands.

---

## Key facts

- Storage: `chrome.storage.local` (saved-for-later list)
- Network: only `api.github.com` (48h update check)
- No server, no AI, no `~/.mission-control/`
