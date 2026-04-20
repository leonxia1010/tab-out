// Unified tab shape shared across dashboard + popup.
//
// Dashboard previously defined this as utils.Tab (url/title/index only) +
// state.Tab (adds id/isTabOut/windowId/active/pinned). Merged here so both
// surfaces consume one symbol; dashboard `state.ts` + `utils.ts` re-export
// it from this module for import-path compat.

export interface Tab {
  url?: string;
  title?: string;
  // chrome.tabs position (0-based index within its window). Preserved through
  // fetchOpenTabs so groupTabsByDomain can sort cards by first-seen order.
  // Optional because mock/test tabs may omit it.
  index?: number;
  id?: number;
  isTabOut?: boolean;
  windowId?: number;
  active?: boolean;
  pinned?: boolean;
  [key: string]: unknown;
}

export interface DomainGroup {
  domain: string;
  tabs: Tab[];
}
