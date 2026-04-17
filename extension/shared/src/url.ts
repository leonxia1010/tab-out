// URL canonicalization for cross-source dedup.
//
// The WHATWG URL parser normalizes casing on scheme + host, adds a
// default "/" path when absent, and drops default ports. Two of those
// catch the real-world mismatch: user pins `https://example.com` (came
// from chrome.tabs), chrome.topSites later returns `https://example.com/`
// — byte-compare keeps them separate; canonicalUrl collapses both to
// the same string so buildList dedup works.
//
// Returns the input unchanged on parse failure so callers can still
// fall back to byte-compare instead of losing data.

export function canonicalUrl(u: string): string {
  try { return new URL(u).href; } catch { return u; }
}
