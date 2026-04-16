# Tab Out Roadmap

Forward-looking items for this fork. Not commitments — just queue.

## Dashboard

- **Priority hostnames configurable via options page.** Currently the set that pins to the top of the open-tabs grid is hardcoded in `extension/dashboard/src/renderers.ts` (`PRIORITY_HOSTNAMES`). Users have different "ambient" entry points (e.g., one person wants Gmail + GitHub pinned, another wants Notion + Linear). Plan:
  - Add an options page (`extension/options/`) that reads/writes `chrome.storage.local['tabout:priorityHostnames']: string[]`.
  - `groupTabsByDomain` reads the storage value (falls back to current hardcoded default) and uses it in the priority-tier check.
  - Provide a text-field-per-hostname list + an "add from currently-open tab" shortcut.

- **Drag-to-reorder domain cards.** Let the user manually override the sort order of non-priority cards. Plan:
  - `npm i sortablejs` (~35KB gzip, no framework dep)
  - Attach `Sortable.create('#openTabsDomains', { onEnd: saveOrder })` once the list is mounted
  - `saveOrder` writes the DOM `dataset.domainId` sequence into `chrome.storage.local['tabout:cardOrder']: string[]`
  - `groupTabsByDomain` sort adds a new tier between priority and first-seen: read the stored order, sort matched domains by its index, fall back to first-seen for domains not in the list
  - Must coordinate with PR 3 (card-level diff): `Sortable` mutates DOM order, so the diff layer must read DOM-as-source-of-truth for ordering (not rebuild from sortedGroups when SortableJS has the user's hand on a card)

- **Fine-grained chip title updates.** Currently when a tab's URL changes within the same hostname (SPA route, OAuth callback), `refresh.ts` skips render entirely, so the chip label stays stale until the next tab create/close event. A bounded title-watcher could patch just the affected chip's `textContent` without triggering the diff layer. Low priority — users rarely watch the dashboard during in-site navigation.

## Build / distribution

- **CHANGELOG automation** — pull notes from squash-merge commit bodies on release.
- **Auto-release from tag push** — GitHub Action that zips `extension/` and uploads on `v*` tags.

## Deferred tabs

- **Search across active + archive** — current search only hits the archive.
- **Export/import deferred list** — JSON file round-trip so users can back up / migrate across browsers.
