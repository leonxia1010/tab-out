// @vitest-environment jsdom
// tests/dashboard/widgets-clock.test.js
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for extension/dashboard/src/widgets/clock.ts — the header
// clock widget. Covers mount structure, initial paint, tick-on-minute-
// rollover (string-change guard avoids redundant DOM writes), applyFormat
// for options-page format switches, and destroy/teardown semantics.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountClock } from '../../extension/dashboard/src/widgets/clock.ts';

beforeEach(() => {
  document.body.innerHTML = '<div id="slot"></div>';
  // Fake timers + fake Date so tick() produces deterministic output and
  // setInterval advances under our control.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-17T13:30:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mountClock', () => {
  it('appends a .clock-widget node to the slot', () => {
    const slot = document.getElementById('slot');
    mountClock(slot, '24h');
    const node = slot.querySelector('.clock-widget');
    expect(node).not.toBeNull();
    expect(node.getAttribute('role')).toBe('timer');
    expect(node.getAttribute('aria-label')).toBe('Current time');
  });

  it('paints the current time on mount for 24h format', () => {
    const slot = document.getElementById('slot');
    mountClock(slot, '24h');
    const node = slot.querySelector('.clock-widget');
    // 13:30 in 24h format — Intl emits "13:30" in locales we support.
    expect(node.textContent).toMatch(/^13:30$/);
  });

  it('paints the current time on mount for 12h format', () => {
    const slot = document.getElementById('slot');
    mountClock(slot, '12h');
    const node = slot.querySelector('.clock-widget');
    // 1:30 PM — tolerate locale variations in the space before AM/PM and
    // the exact AM/PM string (e.g. narrow no-break space, lowercase).
    expect(node.textContent).toMatch(/1:30\s*\u202f?\s*(PM|pm)/i);
  });
});

describe('tick', () => {
  it('does not rewrite textContent when the minute has not rolled over', () => {
    const slot = document.getElementById('slot');
    mountClock(slot, '24h');
    const node = slot.querySelector('.clock-widget');
    const spy = vi.spyOn(node, 'textContent', 'set');

    // advance 30s — still 13:30 — no DOM write
    vi.advanceTimersByTime(30_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rewrites textContent when the minute rolls over', () => {
    const slot = document.getElementById('slot');
    mountClock(slot, '24h');
    const node = slot.querySelector('.clock-widget');

    // Date starts at 13:30:00. advanceTimersByTime moves fake time
    // forward AND fires any timers whose deadline has passed, so
    // advancing 60s → Date = 13:31:00 and the tick at t=60000 reads
    // the rolled-over minute.
    vi.advanceTimersByTime(60_000);
    expect(node.textContent).toMatch(/^13:31$/);
  });
});

describe('applyFormat', () => {
  it('switches from 24h to 12h on the next tick', () => {
    const slot = document.getElementById('slot');
    const handle = mountClock(slot, '24h');
    const node = slot.querySelector('.clock-widget');
    expect(node.textContent).toMatch(/^13:30$/);

    handle.applyFormat('12h');
    expect(node.textContent).toMatch(/1:30\s*\u202f?\s*(PM|pm)/i);
  });

  it('switches from 12h to 24h on the next tick', () => {
    const slot = document.getElementById('slot');
    const handle = mountClock(slot, '12h');
    const node = slot.querySelector('.clock-widget');
    expect(node.textContent).toMatch(/1:30\s*\u202f?\s*(PM|pm)/i);

    handle.applyFormat('24h');
    expect(node.textContent).toMatch(/^13:30$/);
  });
});

describe('destroy', () => {
  it('removes the node and stops the interval', () => {
    const slot = document.getElementById('slot');
    const handle = mountClock(slot, '24h');
    expect(slot.querySelector('.clock-widget')).not.toBeNull();

    handle.destroy();
    expect(slot.querySelector('.clock-widget')).toBeNull();

    // Advancing time shouldn't try to touch the removed node.
    vi.setSystemTime(new Date('2026-04-17T13:31:00'));
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });

  it('applyFormat after destroy is a no-op', () => {
    const slot = document.getElementById('slot');
    const handle = mountClock(slot, '24h');
    handle.destroy();
    expect(() => handle.applyFormat('12h')).not.toThrow();
  });
});
