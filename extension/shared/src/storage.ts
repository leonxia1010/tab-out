// Shared chrome.storage.local helpers.
//
// `storage()` is the common "throw if the global isn't there" guard every
// consumer (api.ts, settings.ts, future update-status.ts) used to copy.
//
// `createLock()` returns a per-caller serializer for read-modify-write
// sequences. Each consumer owns its own pending chain so a settings write
// doesn't stall a deferred-tab write and vice versa; reads that don't
// mutate stay lock-free. The failure path re-invokes the next fn (so one
// rejected write doesn't poison the chain) while still surfacing this
// call's own error through the returned promise.
//
// Why this lives in shared/ and not dashboard/: settings.ts (shared) and
// api.ts (dashboard) used to keep two byte-identical implementations of
// the same primitive. Merging avoids the "fix in one place, forget the
// other" drift that already bit us once (settings.ts's comment literally
// says "Same race api.ts#withLock solves").

export function storage(): chrome.storage.StorageArea {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new Error('chrome.storage.local unavailable');
  }
  return chrome.storage.local;
}

export type LockFn = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLock(): LockFn {
  let pending: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pending.then(fn, fn);
    pending = next.catch(() => {});
    return next;
  };
}
