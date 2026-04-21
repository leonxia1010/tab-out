# Changelog

All notable changes to this fork land here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Popup "Close all N duplicates" now counts and closes duplicate Tab
  Out tabs too.** Before: the displayed count excluded Tab Out but the
  click-through closed them anyway — N lied, and a window with only
  duplicate Tab Out tabs showed a disabled button even though dedup
  was technically possible. After: N includes every duplicate copy
  (Tab Out and regular), the button enables whenever N > 0, and the
  displayed count equals the number of tabs that actually close. The
  dashboard's existing "you have N Tab Out tabs open" banner still
  handles the cross-URL fallback (chrome://newtab/ vs
  chrome-extension://…/dashboard/index.html) — popup dedup matches
  exact URL like the rest of `closeDuplicates`.
- **Dashboard's "You have N Tab Out tabs open" banner now updates in
  real time.** Before: opening or closing a Tab Out tab didn't shift
  the dashboard's displayable-tab signature (Tab Out is filtered out
  of the render diff), so the auto-refresh loop short-circuited before
  the banner check ran — the banner only updated when some unrelated
  tab change happened to kick the cycle. After: `checkTabOutDupes()`
  runs unconditionally after every `fetchOpenTabs()`, so the banner
  reflects the live Tab Out count without piggybacking on a displayable
  tab event.

### Changed

- Popup button type scale: font-size 13 → 14px, button vertical
  padding 10 → 12px. Palette untouched.

## [2.7.0] — 2026-04-21

Fills the wasted toolbar-icon entry point that v2.5.0's badge removal
left behind. Click the extension icon on any page to reach the same
three bulk-tab actions the dashboard exposes — without detouring through
the new tab.

### Added

- **Toolbar popup menu** with three per-window actions reachable from
  any page (not just the new tab): `Close all N tabs (keep Tab Out)`,
  `Close all N duplicates`, `Organize N tabs`. Each button carries a
  live count and disables muted when the count is zero. Popup closes
  automatically when an action runs; no undo toast (undo stays a
  dashboard-only affordance where the toast has time to live). Width
  300px, respects the existing theme toggle, reuses the options-page
  button tokens.
- `closeAllExceptTabout` shared helper: preserves any Tab Out tab in
  the current window and opens a fresh one if none exists, so the
  dashboard entry point never disappears from under the user.

### Fixed

- **Close duplicates no longer closes a pinned tab** when the active
  copy lives elsewhere. Keeper priority is now pinned > active > first,
  and pinned duplicates are never removed regardless of which copy wins
  the "keep" role. Pre-existing gap since closeDuplicates landed;
  uniform across the dashboard action and the new toolbar popup.

### Changed

- Internal: pure tab operations (`closeDuplicates`, `closeTabOutDupes`,
  `organizeTabs`, `undoOrganizeTabs`) + domain grouping
  (`groupTabsByDomain`, `PRIORITY_HOSTNAMES`, `DOMAIN_ALIASES`,
  `effectiveDomain`, `domainIdFor`) + the `Tab` / `DomainGroup` types
  moved from `extension/dashboard/src/` into `extension/shared/src/` so
  the toolbar popup can call byte-identical implementations. No
  user-visible change beyond the pinned-dedup fix above.
- `manifest.json#action` gains `default_popup: "popup/index.html"`. No
  new permissions or host_permissions.

## [2.6.3] — 2026-04-19

Drops the third-party IP-geolocation chain in favor of the browser's
native `navigator.geolocation`. Fewer host_permissions, no external
trackers on the weather path, Chrome Web Store review story gets
noticeably cleaner.

### Changed

- **Weather location now uses `navigator.geolocation` + manual
  entry.** The three-provider IP chain added in v2.6.2 (ipwho.is →
  geojs.io → ipapi.co) is gone. The dashboard widget asks the
  browser on mount when no location is set; on grant, lat/lon goes
  straight into settings and the widget hydrates. On denial,
  timeout, or missing API the widget stays in "Set weather
  location" mode and the Settings form still accepts a manually-
  typed city. Trade-off: first-install users see one Chrome
  permission prompt; in exchange, the extension no longer ships
  the user's IP to three external services, three host_permissions
  disappear from the manifest, and the service worker becomes a
  pure coords-to-weather fetcher.

### Added

- `geolocation` manifest permission.

### Removed

- `ipwho.is`, `get.geojs.io`, `ipapi.co` from `host_permissions`.
- `tryIpGeolocate` / `ensureLocationConfigured` helpers and their
  storage-synthesis side effects in `fetchWeatherNow`.

## [2.6.2] — 2026-04-19

Follow-up patch for v2.6.1 covering four independent bugs: the
IP-geo auto-detect path wasn't actually firing for most users, the
one provider we did hit was returning 403, the v2.6.1 focus sink
tripped Chrome's a11y engine on every new-tab open, and the update
banner compared against a frozen snapshot that left users stuck
with a permanent "update available" hint even after they'd pulled
the update.

### Fixed

- **IP-geo auto-detect actually runs on first install and upgrades.**
  Two storage shapes were skipping the ipapi.co seed:
  (1) fresh installs, where `tabout:settings` isn't written until the
  options page saves something; and (2) pre-v2.6 upgrades, where the
  legacy record has no `weather` key. Both paths now synthesize a
  default-weather object so `ensureLocationConfigured` runs and
  persists a location. The dashboard widget also pings the service
  worker on mount when no location is set, so the "Set weather
  location" prompt flips to a real reading within a second or two.
- **Update banner compares against the installed version, not a
  first-check snapshot.** `checkForUpdate` used to seed `currentTag`
  to whatever GitHub's `tag_name` was on the very first poll and
  never touch it again, which meant any user who first ran at an
  older release saw a persistent "new version available" banner
  forever — even after they pulled the new version, because the
  comparison still referenced the frozen old tag. `currentTag` now
  reads from `chrome.runtime.getManifest().version` on every tick,
  and `updateAvailable` uses a real numeric-segment version compare
  so a dev/pre-release build running ahead of the public release
  doesn't falsely flag an update either.
- **Focus sink no longer trips Chrome's a11y engine.** The v2.6.1
  sink used `aria-hidden="true"` to stay out of screen readers, but
  Chrome's a11y rule forbids `aria-hidden` on a focused element or
  its ancestor. The sink now carries `aria-label="Tab Out dashboard"`
  instead, so AT users hear a brief, meaningful landmark
  announcement on new-tab open instead of a WAI-ARIA violation.
  `inert` isn't usable here because it would block the very focus
  absorption that stops the omnibox caret.
- **IP-geo no longer single-sourced on ipapi.co.** Field reports
  showed ipapi.co returning HTTP 403 (bot-detection / regional
  block) for extension-issued requests, leaving the widget stuck
  in setup mode. The SW now tries three providers in order —
  ipwho.is → geojs.io → ipapi.co — and stops at the first that
  returns usable coordinates. Failure paths log per-provider
  reasons to the service worker console (`chrome://extensions` →
  Tab Out → inspect service worker) so users can diagnose why IP
  detection didn't resolve.

## [2.6.1] — 2026-04-18

UX polish pass after shipping v2.6.0.

### Fixed

- **No caret on new tab open.** Chrome forces omnibox focus on
  every new-tab open, leaving a blinking cursor in the URL bar even
  though Tab Out isn't asking for a URL. A visually-hidden,
  autofocus-ed sink now absorbs the initial focus so the dashboard
  opens "quiet" — no omnibox caret, no search-box caret, Tab cycle
  still works. First real click/keypress hands focus to the control
  the user touched.
- **Weather hover stopped flaking.** The 8px physical gap between
  trigger and popover was catching slow cursors and flickering the
  popover closed mid-movement. Gap tightened to 2px, the popover's
  own top padding bumped so the visible whitespace is preserved,
  and the hover-close grace period doubled from 150ms to 300ms.
- **Clearing the weather location in Settings now sticks.** The
  input already let you type into it freely; emptying it out now
  clears lat/lon/label from the draft and Save lands a null
  location. The dashboard widget returns to the "Set weather
  location" prompt the same way a fresh install looks.

## [2.6.0] — 2026-04-18

Header widgets round 2: the dashboard picks up two new opt-in readouts
that share the widget contract introduced in v2.1.0. A Weather pill
shows current temperature + condition (Open-Meteo, no account
required) next to the clock; a Countdown timer lets you start a
Pomodoro-style run from the header that keeps going across tabs and
reloads, posts a desktop notification on completion, and chimes a
three-note triad when the dashboard is focused. Both widgets are
disabled-by-default / off-by-default respectively so the header stays
quiet until you configure them in Settings.

### Added

- **Weather widget** — temperature + 8-bucket WMO condition icon
  (clear / partly-cloudy / cloud / fog / rain / snow / shower /
  storm) in the dashboard header. Disabled by default. Enable from
  Settings → Weather, enter a city (Open-Meteo geocoding returns
  lat/lon), and pick Celsius or Fahrenheit. The service worker polls
  Open-Meteo every 30 minutes and on demand when the dashboard
  notices cached data older than 30 min. Unit switches are
  display-only — no re-fetch for a C↔F flip.
- **Countdown timer widget** — single-timer MVP with a 2×3 preset
  grid (5/10/15/25/45/60 min) plus a 1–600 minute custom input.
  State persists in `chrome.storage.local['tabout:countdownState']`
  so reloading the dashboard mid-countdown resumes the running
  timer, and two dashboard tabs stay in lockstep via
  `chrome.storage.onChanged`. Completion fans out via
  `chrome.notifications` (seen from any tab) plus an in-page toast
  and a C5-E5-G5 triad when the dashboard is focused; multi-tab
  users don't get stacked effects. Reset/pause/resume wire into
  `chrome.alarms.{create,clear}` so the SW can fire the completion
  alarm even if every Tab Out tab is suspended.
- `playCompletionSound()` in `animations.ts` — three-note triad
  reusing the shared `AudioContext` pool already behind
  `playCloseSound()`.
- Weather + Countdown sections on the Options page, complete with
  dirty-state tracking + Save.

### Changed

- `tabout:settings` picks up two new top-level keys: `weather`
  (`enabled`, `locationLabel`, `latitude`, `longitude`, `unit`) and
  `countdown` (`enabled`, `soundEnabled`). `setSettings(patch)`
  extends the spread-merge pattern so a partial patch like
  `{ weather: { unit: 'F' } }` doesn't clobber siblings;
  `normalizeSettings()` clamps lat/lon to ±90 / ±180 and rejects
  non-finite values.
- `manifest.json` picks up the `"notifications"` permission and two
  Open-Meteo `host_permissions` (`api.open-meteo.com`,
  `geocoding-api.open-meteo.com`). Chrome will prompt for
  notifications on extension reload (standard MV3 flow).
- `background.js` gains `fetchWeatherNow()` (Open-Meteo poller with
  SW-side 30-min alarm + on-demand `chrome.runtime.sendMessage`
  trigger on location/enabled edges) and `handleCountdownComplete()`
  (alarm-driven notification + 24h stale guard so a browser restart
  doesn't fire "your timer is done" for a timer that ended yesterday).

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
