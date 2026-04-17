// Shared favicon URL helper. Resolves Chrome's native `_favicon/` API
// (requires the "favicon" manifest permission; Chrome 104+). Zero
// network requests and zero third-party exposure — Chrome serves the
// same cached icon the address bar already has.
//
// Returns `undefined` when the input URL is missing/malformed or when
// chrome.runtime is unavailable (jsdom tests). Callers pass the result
// straight to `el('img', { src })`; dom-utils.el skips undefined attrs,
// and an <img> without a src attribute issues no network request
// (unlike `<img src="">`, which refetches the document per the HTML
// spec history quirk).

export function faviconUrl(rawUrl: string, size: number): string | undefined {
  if (!rawUrl) return undefined;
  try { new URL(rawUrl); } catch { return undefined; }
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return undefined;
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', rawUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}
