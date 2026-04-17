// Clock widget — live local time in the dashboard header.
//
// Ticks once per second, but DOM writes only fire on string change
// (minute rollover). setInterval runs in the dashboard tab; when the
// tab is hidden Chromium throttles it to ≥ 1Hz which is fine — HH:MM
// is all we show.
//
// Format comes from shared/settings.ts (`clock.format`). applyFormat()
// rebuilds the Intl formatter and forces an immediate tick so an
// options-page toggle reflects before the next second elapses.

import { el } from '../dom-utils.js';
import type { ClockFormat } from '../../../shared/dist/settings.js';

export interface ClockHandle {
  destroy(): void;
  applyFormat(format: ClockFormat): void;
}

function makeFormatter(format: ClockFormat): Intl.DateTimeFormat {
  if (format === '24h') {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function mountClock(container: HTMLElement, format: ClockFormat): ClockHandle {
  const node = el('div', {
    className: 'clock-widget',
    'aria-label': 'Current time',
    role: 'timer',
  });
  container.appendChild(node);

  let formatter = makeFormatter(format);
  let last = '';
  let destroyed = false;

  function tick(): void {
    if (destroyed) return;
    const next = formatter.format(new Date());
    if (next !== last) {
      node.textContent = next;
      last = next;
    }
  }

  tick();
  const interval = setInterval(tick, 1000);

  return {
    destroy(): void {
      destroyed = true;
      clearInterval(interval);
      node.remove();
    },
    applyFormat(newFormat: ClockFormat): void {
      if (destroyed) return;
      formatter = makeFormatter(newFormat);
      last = '';
      tick();
    },
  };
}
