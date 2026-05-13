import type { AuroraMode, Layout } from '../../shared/dist/settings.js';

export function applyLayout(layout: Layout): void {
  // 'masonry' is the default: clear the attribute so the base .domains
  // stylesheet rule applies. Only grid needs the explicit override selector.
  const root = document.documentElement;
  if (layout === 'grid') {
    root.dataset.layout = 'grid';
  } else {
    delete root.dataset.layout;
  }
}

export function applyAurora(mode: AuroraMode): void {
  // 'medium' is the default: clear the attribute so body::before uses
  // --aurora-multiplier: 1. off/low/high are explicit CSS overrides.
  const root = document.documentElement;
  if (mode === 'medium') {
    delete root.dataset.aurora;
  } else {
    root.dataset.aurora = mode;
  }
}
