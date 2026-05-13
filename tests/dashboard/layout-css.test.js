// tests/dashboard/layout-css.test.js
//
// Static CSS contract for the dashboard's wide/narrow layout choices.
// jsdom unit tests cannot compute CSS columns, media queries, or rendered
// widths, so this locks the selectors that decide whether cards are masonry
// columns or a container-bounded full-width list.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../extension/dashboard/style.css'), 'utf8');

function blockFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `Missing CSS block for ${selector}`).not.toBeNull();
  return match[1];
}

describe('dashboard layout CSS contract', () => {
  it('keeps masonry wide but container-bounded', () => {
    const container = blockFor('.container');
    expect(container).toMatch(/max-width:\s*1536px/);
    expect(container).toMatch(/margin:\s*0 auto/);

    const domains = blockFor('.domains');
    expect(domains).toMatch(/column-width:\s*300px/);
    expect(domains).toMatch(/column-gap:\s*12px/);
    expect(domains).not.toMatch(/display:\s*grid/);
  });

  it('keeps grid mode as a single full-width list inside a 960px container', () => {
    const gridContainer = blockFor('html[data-layout="grid"] .container');
    expect(gridContainer).toMatch(/max-width:\s*960px/);

    const gridDomains = blockFor('html[data-layout="grid"] .domains');
    expect(gridDomains).toMatch(/column-width:\s*auto/);
    expect(gridDomains).toMatch(/display:\s*grid/);
    expect(gridDomains).toMatch(/grid-template-columns:\s*1fr/);
  });

  it('stacks open tabs and saved-for-later columns full-width below 1024px', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.dashboard-columns\s*\{[\s\S]*?flex-direction:\s*column/);
    expect(css).toMatch(/@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.dashboard-columns \.active-section\s*\{[\s\S]*?width:\s*100%/);
    expect(css).toMatch(/@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.deferred-column\s*\{[\s\S]*?width:\s*100%/);
  });
});
