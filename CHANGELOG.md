# Changelog

All notable changes to this fork land here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [2.1.0] — 2026-04-17

Options page + first two header widgets. Introduces the
`tabout:settings` storage layer every future widget reads and writes
through.

### Added

- Options page — opens via the extension icon's right-click → Options
  (or `chrome://extensions` → Details → Extension options). Sections
  for Appearance and Clock format; radio changes save immediately and
  reflect external writes via `chrome.storage.onChanged`.
- Dark mode — header moon button opens a native HTML Popover menu
  (Follow system / Light / Dark). Full dark palette: paper goes
  near-black with warm amber tint, card-bg one step lighter so cards
  elevate without shadows, accents desaturated ~15% to read calm on
  dark backgrounds. `theme-bootstrap.js` (external, MV3 CSP-safe)
  reads a `localStorage` cache before the stylesheet parses so
  explicit light/dark choices have zero FOUC on reload.
- Clock widget — local time in the header. 12h / 24h format configurable
  from the options page; default inferred from `navigator.language`.
  Updates on minute rollover; live-syncs when the format is changed
  from the options page.
- Shared code module `extension/shared/src/settings.ts` —
  `getSettings` / `setSettings` / `onSettingsChange` /
  `normalizeSettings` / `syncThemeCache` / `defaultSettings`.
  Dashboard and options both import it. Defensive normalizer matches
  `api.ts#isDeferredRow` discipline (unknown fields fall back to
  defaults instead of throwing).

### Changed

- Build: TypeScript project references. Root `tsconfig.json` is now a
  solution file; per-page configs under `tsconfig.{shared,dashboard,
  options}.json`, each `composite: true` with its own `rootDir`/
  `outDir`. `npm run build` and `npm run typecheck` both run `tsc -b`.
- Release pipeline — zip excludes extend to `extension/options/src/*`
  and `*.d.ts` so options-page source and declaration files don't leak
  into the release artifact.
- `prefers-color-scheme: dark` is now honored when the user's theme
  preference is "Follow system" (default).

### Security

- FOUC bootstrap script (`theme-bootstrap.js`) is external so MV3's
  CSP `script-src 'self'` can stay unmodified; no `unsafe-inline`
  grant, no script hash allowlist.

---

## [2.0.0] — 2026-04-16

First release of the single-extension fork
(`leonxia1010/tab-out`). Upstream `zarazhangrui/tab-out` ran as a Chrome
extension + local Node/Express/SQLite server with DeepSeek-powered
"mission" clustering. This version ships as a single Chrome MV3
extension — no server, no AI — with all state in `chrome.storage.local`.

### Added

- Save for later — per-tab checklist, 30-day auto-archive, 500-row /
  90-day archive prune.
- Auto-refresh on tab events via signature-based debounce + card-level
  DOM diff against `chrome.tabs.on{Created,Removed,Updated,Moved}`
  (#34, #42, #44, #45).
- Update banner — service worker polls
  `api.github.com/repos/leonxia1010/tab-out/releases/latest` every 48h;
  dashboard shows a dismissable banner when a new release lands
  (#25, #27).
- Badge counter — toolbar icon shows the number of unique open
  hostnames, colored green / amber / red by bucket (#18).
- First-seen stable domain ordering; priority hostnames
  (`mail.google.com`, `x.com`, `www.linkedin.com`, `github.com`,
  `twitter.com`) pin first (#44).
- Duplicate detection per domain with one-click "Close N duplicates".
- Swoosh sound + confetti on close; waterfall fade-in on dashboard open
  (#36, #37).

### Changed

- Architecture: removed Node/Express/SQLite server; dashboard is a
  Chrome MV3 new-tab override with direct `chrome.tabs` +
  `chrome.storage.local` access (#16, #17, #18).
- Install: download the release zip + load unpacked. No `npm install`,
  no launch agent, no service to start.
- Storage: `~/.mission-control/missions.db` SQLite replaced by
  `chrome.storage.local['deferredTabs']`.
- Codebase: rewritten in TypeScript and split into focused modules
  (`state.ts`, `api.ts`, `extension-bridge.ts`, `renderers.ts`,
  `handlers.ts`, `animations.ts`, `dom-utils.ts`, `utils.ts`, `diff.ts`,
  `refresh.ts`); the 1.5k-line `app.js` god-file is gone (#3–#11).
- Domain grouping: every hostname gets its own card. The old
  "Homepages" merged card was removed (#43).
- Saved `chrome://` / `chrome-extension://` / `file://` entries open
  via `chrome.tabs.create` instead of anchor navigation (#46).
- Refresh signature is hostname-based and order-sensitive, so i18n and
  SPA route changes don't waterfall but real drag reshuffles do
  (#42, #45).

### Fixed

- XSS hardening: removed every `innerHTML` path on user data; sanitized
  every derived string (#2).
- `newId()` birthday collisions in rapid `saveDefer` bursts (#19).
- `chrome://` tabs use exact-URL matching so "Close domain" can't nuke
  unrelated system pages (#29).
- "Close all tabs" preserves the active Tab Out dashboard
  (#28, #35).
- "Inbox zero" empty state stays visible even when Tab Out is the only
  open tab (#31).
- Deferred column + Archive section stay visible across empty states
  (#32).
- Duplicate saves renew the timestamp instead of creating a second
  row (#40).
- Dismiss (✕) deletes directly instead of leaving an archive trail
  (#38).
- Now-empty domain card flies out after a defer (#39).
- Waterfall fade-in applies to every card, not just the first four
  (#36, #37).
- Auto-refresh ignores title/status/favicon churn so slow loads don't
  re-waterfall (#41).
- Post-release code review: `api.ts` RMW serialized by a module-level
  `withLock` chain; `chrome.tabs.remove/update` rejections swallowed at
  the bridge; state getters typed `ReadonlyArray`; three document-level
  `click` listeners merged; `AudioContext` pooled; deferred reads
  shape-guarded; +25 tests (#47).

### Removed

- Node / Express / SQLite server and its install scripts.
- DeepSeek-powered "mission" clustering. All `mission` identifiers
  renamed to `domain`; the `source_mission` field on stored rows is
  preserved for v1 read-back compat (#24, #26).
- Iframe wrapper — the dashboard now runs directly as the MV3 new-tab
  extension page (#16).

### Security

- CSP: `script-src 'self'; object-src 'self'`.
- MV3 permissions: `tabs`, `storage`, `alarms`. Host permissions
  narrowed to `https://api.github.com/*` (no wildcard host access).
- `href` scheme allowlist: http(s) / mailto / tel / chrome /
  chrome-extension / file. Anything else (`javascript:`, `data:`,
  `vbscript:`, etc.) downgrades to `#`.
- Storage reads shape-guard corrupted rows — a single bad row can no
  longer crash the archive search or block the deferred column (#47).

---

[2.1.0]: https://github.com/leonxia1010/tab-out/releases/tag/v2.1.0
[2.0.0]: https://github.com/leonxia1010/tab-out/releases/tag/v2.0.0
