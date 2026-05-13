// @vitest-environment jsdom
// tests/dashboard/settings-appliers.test.js

import { describe, it, expect, beforeEach } from 'vitest';

import { applyAurora, applyLayout } from '../../extension/dashboard/src/settings-appliers.ts';

beforeEach(() => {
  delete document.documentElement.dataset.layout;
  delete document.documentElement.dataset.aurora;
});

describe('applyLayout', () => {
  it('sets data-layout="grid" for the single-column grid mode', () => {
    applyLayout('grid');
    expect(document.documentElement.dataset.layout).toBe('grid');
  });

  it('clears data-layout for masonry so the base CSS rule applies', () => {
    document.documentElement.dataset.layout = 'grid';
    applyLayout('masonry');
    expect(document.documentElement.dataset.layout).toBeUndefined();
  });
});

describe('applyAurora', () => {
  it('sets explicit data-aurora values for off/low/high overrides', () => {
    applyAurora('off');
    expect(document.documentElement.dataset.aurora).toBe('off');

    applyAurora('low');
    expect(document.documentElement.dataset.aurora).toBe('low');

    applyAurora('high');
    expect(document.documentElement.dataset.aurora).toBe('high');
  });

  it('clears data-aurora for medium so the default multiplier applies', () => {
    document.documentElement.dataset.aurora = 'high';
    applyAurora('medium');
    expect(document.documentElement.dataset.aurora).toBeUndefined();
  });
});
