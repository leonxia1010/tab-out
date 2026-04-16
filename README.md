# Tab Out

**Keep tabs on your tabs.** New tab page that groups your open tabs by domain and lets you close them with style.

> **Note**: This is a personal-use fork of [zarazhangrui/tab-out](https://github.com/zarazhangrui/tab-out) (built by [Zara](https://x.com/zarazhangrui)). The upstream version runs a local Node/Express/SQLite server with AI-powered "mission" clustering. This fork strips all of that out: **single Chrome MV3 extension, no server, no AI, local-only via `chrome.storage.local`**. If you want the original feature set, use upstream.

---

## Install

1. Download `tab-out-vX.Y.Z.zip` from the [latest Release](https://github.com/leonxia1010/tab-out/releases/latest).
2. Unzip it.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode** (top-right toggle).
5. Click **Load unpacked** and pick the unzipped folder.

Open a new tab — you'll see Tab Out.

---

## Features

- **Tabs grouped by domain** — each hostname gets its own card. Pinned hostnames (Gmail, X, LinkedIn, GitHub, YouTube) always appear first; the rest order by when each domain was first opened.
- **Close with style** — swoosh sound + confetti when you clean up a group.
- **Duplicate detection** — flagged with one-click cleanup.
- **Click any tab to jump to it** — even across windows.
- **Save for later** — bookmark individual tabs to a checklist before closing; auto-archives after 30 days.
- **Update banner** — appears when a new release lands; checks GitHub every 48h.
- **Local-first storage** — all saved-tab data lives in `chrome.storage.local`; no cloud sync. Three network calls for presentation/updates: Google Fonts (first load), `www.google.com/s2/favicons` (per chip), and `api.github.com/repos/leonxia1010/tab-out/releases/latest` (every 48h).

---

## What's different from upstream

| | upstream (`zarazhangrui/tab-out`) | this fork |
|---|---|---|
| Architecture | Localhost Node/Express server + SQLite + Chrome extension iframe | Single Chrome MV3 extension |
| Storage | `~/.mission-control/missions.db` | `chrome.storage.local` |
| AI clustering | DeepSeek-powered "missions" | None — plain domain grouping |
| Install | `npm install` + `npm run install-service` + `npm start` + load unpacked | Download zip → load unpacked |
| Auto-start | Launch Agent / systemd / Windows Startup | Browser handles it |

---

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsc → extension/dashboard/dist/
```

After `npm run build`, reload the extension at `chrome://extensions`.

---

## License

MIT (inherited from upstream).
