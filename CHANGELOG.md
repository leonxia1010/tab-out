# Changelog

All notable changes to this fork land here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.5.0] — 2026-04-18

Dashboard becomes a current-window control panel: tab lists, close
actions, and the new Organize button all scope to the browser window
the Tab Out tab lives in. The domain-count badge on the extension
icon — global by construction — is retired because it no longer
matches what any single dashboard shows. Two new header buttons
land: one-click global dedup, and reorder-tab-bar-to-match-cards
with a 60-second Undo.

### Added

- **Organize tabs** — new header button reorders the current window's
  tab bar to match the dashboard's domain-card order. Pinned tabs
  stay put (Chrome enforces position-before-unpinned anyway); Tab
  Out tabs land at the end as "tool done, back to work." A 60-second
  action toast carries an `Undo` button backed by an in-memory
  snapshot of each non-pinned tab's original index — click and
  every move is reversed. No new permissions; batch
  `chrome.tabs.move` and a `swallow()` guard on the reverse pass
  cover the "tab was closed during the undo window" edge.
- **Close all duplicates** — second header button sums every
  per-card dedup action's url set and hits `closeDuplicates()` in
  one pass. Toast reports `Closed N duplicates across M domains`;
  per-card dedup controls + badges fade out with the global button
  so the grid visually settles without a full remount.
- `showActionToast(message, action, ttl)` animation primitive —
  action-bearing variant of `showToast`. Returns a `dismiss` handle
  so an action click can retire the toast immediately instead of
  waiting for the TTL.

### Changed

- **Dashboard scope is now per-window.** Every `chrome.tabs.query()`
  call site in `extension-bridge.ts` passes `{ currentWindow: true }`,
  and `refresh.ts` gates each tab event listener on a
  `dashboardWindowId` resolved once via `chrome.tabs.getCurrent()`.
  `onAttached` tracks the dashboard tab itself if the user drags it
  to another window. `closeTabOutDupes` loses its cross-window
  prefer-same-window logic — dead code under per-window scope.
- `ToutSettings` storage shape is unchanged; no migration needed.

### Removed

- **Domain-count badge.** `background.js` no longer computes or
  writes the per-count badge color (`getDomainCount` /
  `colorForCount` / `updateBadge` + their four tab-event
  listeners are gone). The update-check alarm path is untouched.
  The extension icon reverts to Chrome's default no-badge look.

## [2.4.0] — 2026-04-18

Options page gains an explicit Save / Cancel model and a visual
refresh; the dashboard header gets a gear button so opening
Settings no longer requires a trip through `chrome://extensions`.

### Added

- **Settings gear** in the dashboard header — new
  `widgets/settings-link.ts` mounts rightmost in `#headerRight`
  (clock → theme → gear). Heroicons outline cog-6-tooth at 18px
  in a 36px circular button that mirrors the theme toggle. Click
  calls `chrome.runtime.openOptionsPage()` and
  `manifest.json#options_ui.open_in_tab` already resolves it in a
  full tab.
- **Explicit Save model** in the options page — edits mutate a
  local `draft` instead of writing storage on every change.
  `isDirty()` compares `draft` to a `baseline` snapshot of the
  last storage value, and a footer with `Cancel` (muted) + `Save &
  Close` (ink primary) lets the user commit intentionally. Save is
  disabled while clean. `Escape` maps to Cancel; `Cmd/Ctrl+S`
  triggers Save (no-op when disabled).
- **Dirty indicators** (both retained) — an 8-px amber dot next to
  the heading and an italic `Unsaved changes` string in the footer.
  The two reinforce each other: the dot is a top-of-page glance
  cue, the text is button-adjacent so the reader sees the same
  signal when their eye is on Save.
- **beforeunload guard** prompts when leaving the page with
  unsaved changes. Modern browsers show their generic `Leave
  site?` dialog and ignore the custom string; kept anyway as
  self-documenting intent.

### Changed

- **Options form visual language aligns with the dashboard.** Radio
  rows switch from `display: block` + `vertical-align: middle` to
  `display: flex; align-items: center; gap: 8px`. `options/style.css`
  `:root` expands with `--warm-gray`, `--accent-amber`,
  `--accent-sage`, `--shadow` (copied from dashboard values —
  options keeps self-contained tokens, nothing shared).
- **onSettingsChange** gating — external writes (dashboard theme
  toggle, another options tab) always update `baseline` so the
  dirty comparison stays meaningful, but `draft` and the form only
  re-render when the user hadn't started editing. In-flight edits
  win.
- Cancel **navigates** unconditionally: dirty prompts via
  `beforeunload`, clean goes straight to
  `chrome.runtime.getURL('dashboard/index.html')`. Chrome silently
  blocks `chrome-extension://` → `chrome://newtab/` navigation via
  `location.href`, so the dashboard file URL is the only path that
  actually lands the user back home.

### Removed

- `Settings save automatically` tagline — no longer true.

## [2.3.0] — 2026-04-17

The new middle section lands — search widget + shortcut bar — and the
dashboard flips to a masonry layout by default so tall sites pack
next to short lists without the old grid's wasted whitespace.

### Added

- **Masonry layout** is now the default dashboard arrangement — domain
  cards pack as CSS columns instead of a grid that matches the tallest
  card. Grid (single-column list) is kept as an opt-in toggle under
  Options → Layout; the choice persists via `tabout:settings.layout`
  and hydrates pre-paint through a new `tabout:layout-cache` localStorage
  key so switches never flash.
- **Search widget** sits under the header in a new middle section —
  rounded card-token field with a leading Heroicons magnifying-glass
  glyph. Enter fires `chrome.search.query` against the user's
  Chrome-configured default engine (no per-engine picker, by design).
  Adds the `search` permission.
- **Shortcut bar** — up to 10 circular favicon tiles below the search
  widget, mirroring Chrome's NTP "Most visited" row. Sources merge as
  `[...pins, ...topSites.filter(!pin && !hide)].slice(0, 10)`. Hover
  any tile to pin (persist across reloads) or hide (filter out of the
  topSites feed). Options → Shortcuts manages both lists with remove
  / unhide controls. Adds the `topSites` permission.
- **Theme popover** now marks the active mode with `aria-checked` and
  a trailing Heroicons check glyph, and dismisses on window scroll /
  resize to match native `<select>` behavior.
- **Page-load waterfall** steps have been compressed from 50ms to 30ms
  per level so the fade-up cascade reads snappier on refresh. Middle
  section participates in the waterfall at 0.03s delay.

### Changed

- Stacked-layout breakpoint raised from 800px to 1024px (Tailwind `lg`)
  so the side-by-side active/deferred columns don't cramp before the
  threshold where dual columns actually improve density.
- Grid layout explicitly collapses to a single column (`1fr`) at every
  viewport, restoring the pre-v2.3.0 visual for users who opt out of
  masonry.
- Update banner relocated from the dashboard footer to a top strip
  above the header; dismiss control switched from a text × to a
  Heroicons x-mark SVG; clicking "See on GitHub" now counts as
  acknowledgement and auto-dismisses the banner (convention match with
  VSCode / Slack / GitHub).
- Shortcut bar filters loopback hosts out of the `chrome.topSites`
  feed — `localhost`, `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, and
  IPv6 `::1` no longer occupy tile slots so a week of `npm run dev`
  doesn't take over the shortcut row. Pinning a loopback URL
  explicitly still works (pins bypass the filter).

## [2.2.0] — 2026-04-17

Archive gets a way out. The ✕ button next to an archived saved-for-later
row used to be the only action; now a restore button sits beside it and
moves the row back to the active list.

### Added

- Restore button on every archive row — Heroicons `arrow-uturn-left`
  outline glyph, placed left of the delete ✕. Click resets the row's
  archive/check flags, refreshes `deferred_at` to now (so the 30-day
  age-out doesn't immediately re-archive it), and the row reappears at
  the top of the active saved-for-later column. Toast confirms with
  "Restored".
- URL-collision merge semantics — if the restored row's URL already
  exists in the active list, the active row's `deferred_at` refreshes
  instead of creating a duplicate; the archived entry is dropped and
  the toast reads "Already in saved for later". Preserves the
  `activeByUrl` invariant `saveDefer` relies on.

### Changed

- Theme toggle widget icons now render as Heroicons v2 outline SVG
  (sun / moon / computer) instead of the previous emoji (☀️ / 🌙 / 🖥️).
  Matches the icon family already used by the cleanup banner and fixes
  OS-dependent emoji glyph rendering on dark backgrounds.
- Archive semantics widened — archive now means "completed, reviewed,
  or paused" instead of strictly "completed/reviewed". The explanatory
  comment above `dismissDeferred` in `api.ts` reflects the new round-trip.

### Security

- No CSP, permission, or host-permission changes.

## [2.1.1] — 2026-04-17

Options page + first two header widgets (dark mode, clock) land,
together with three header UI hotfixes caught in the same-day
verification pass. Originally drafted as separate 2.1.0 / 2.1.1
releases; only the 2.1.1 tag was published, so the combined scope
lives under this single entry.

Introduces the `tabout:settings` storage layer every future widget
reads and writes through.

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

### Fixed

- Clock and theme toggle no longer drift out of vertical alignment —
  `.clock-widget` gets an explicit 36px height + `line-height: 1` so the
  22px serif number and the 36px round button share the same optical
  center.
- Theme-toggle icon now reflects the *effective* theme instead of a
  fixed moon glyph. Explicit light → ☀️, explicit dark → 🌙, and
  `system` folds through `prefers-color-scheme` (with a matchMedia
  listener so OS-level flips repaint the icon while on system mode).
- Theme popover now anchors under the trigger button instead of landing
  at the viewport's top-left corner. A `toggle`-event listener computes
  the trigger's bounding rect on each open and writes `position: fixed`
  coordinates; the popover stylesheet switches from `absolute`/`inset:
  unset` to `fixed`/`inset: auto` so the JS-set coords take effect.

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

[2.2.0]: https://github.com/leonxia1010/tab-out/releases/tag/v2.2.0
[2.1.1]: https://github.com/leonxia1010/tab-out/releases/tag/v2.1.1
[2.0.0]: https://github.com/leonxia1010/tab-out/releases/tag/v2.0.0
