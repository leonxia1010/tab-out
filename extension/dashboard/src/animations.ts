// Purely presentational DOM / Web Audio side effects — no state reads.
// `animateCardOut` takes an optional `onComplete` callback so this module
// stays free of `checkAndShowEmptyState`; that helper lives in the
// renderers layer and the coupling would otherwise flow the wrong way.

const CONFETTI_COLORS = [
  '#c8713a', // amber
  '#e8a070', // amber light
  '#5a7a62', // sage
  '#8aaa92', // sage light
  '#5a6b7a', // slate
  '#8a9baa', // slate light
  '#d4b896', // warm paper
  '#b35a5a', // rose
] as const;

const CONFETTI_PARTICLE_COUNT = 17;
const CARD_CLOSE_DURATION_MS = 300;
const TOAST_VISIBLE_MS = 2500;

type AudioContextCtor = typeof AudioContext;

// Pooled across all playCloseSound calls. The previous implementation
// created a fresh AudioContext per invocation and closed it 500ms later,
// which worked but wasted the construct/teardown cycle on every click.
// Chrome's autoplay policy only requires the *first* resume to follow a
// user gesture; every playCloseSound is itself a click-driven side
// effect, so calling ctx.resume() inside each sound is always on a valid
// gesture stack.
let sharedCtx: AudioContext | null = null;

function getSharedAudioCtx(): AudioContext | null {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
  if (!Ctor) return null;
  sharedCtx = new Ctor();
  return sharedCtx;
}

// Three-note rising C-E-G triad for countdown completion. Distinct
// from playCloseSound's noise-band "thunk" — the close sound is a tab
// dropping, this one is a task finishing. Reuses the shared AudioContext
// pool so the first sound of the page still primes the autoplay gate.
export function playCompletionSound(): void {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();

    const t = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5
    const spacing = 0.15;
    const toneDuration = 0.3;

    for (let i = 0; i < notes.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = notes[i];

      const start = t + i * spacing;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + toneDuration);

      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + toneDuration);
    }
  } catch {
    // Audio not supported — fail silently.
  }
}

export function playCloseSound(): void {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    // Click handler = valid user gesture; resume is a no-op if already running.
    if (ctx.state === 'suspended') void ctx.resume();

    const t = ctx.currentTime;
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);
    // Nodes (source/filter/gain) are GC-eligible once .start() finishes;
    // the ctx itself stays alive for the next call.
  } catch {
    // Audio not supported — fail silently.
  }
}

export function shootConfetti(x: number, y: number): void {
  for (let i = 0; i < CONFETTI_PARTICLE_COUNT; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6;
    const color = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 120;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 80;
    const gravity = 200;

    const startTime = performance.now();
    const duration = 700 + Math.random() * 200;

    function frame(now: number) {
      const elapsed = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        el.remove();
        return;
      }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform =
        `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = String(opacity);

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

export function animateCardOut(
  card: HTMLElement | null | undefined,
  onComplete?: () => void,
): void {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  shootConfetti(cx, cy);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    onComplete?.();
  }, CARD_CLOSE_DURATION_MS);
}

export function showToast(message: string): void {
  const toast = document.getElementById('toast');
  const text = document.getElementById('toastText');
  if (!toast || !text) return;
  // Clear any lingering action button from a previous showActionToast.
  toast.querySelectorAll('.toast-action').forEach((el) => el.remove());
  text.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), TOAST_VISIBLE_MS);
}

// v2.5.0 — action-bearing toast for undoable operations. Returns a
// `dismiss` handle so the action click can take the toast down itself
// (e.g. clicking Undo should close the toast immediately, not wait
// for the 60s TTL). The underlying `#toast` DOM lives in index.html
// alongside the existing `#toastText`; this helper appends a
// `.toast-action` button and removes it on dismiss.
export interface ActionToastHandle {
  dismiss: () => void;
}

export function showActionToast(
  message: string,
  action: { label: string; onClick: () => void },
  ttlMs = 60_000,
): ActionToastHandle {
  const toast = document.getElementById('toast');
  const text = document.getElementById('toastText');
  if (!toast || !text) {
    return { dismiss: () => {} };
  }
  // Clean up any prior action button so consecutive toasts don't stack.
  toast.querySelectorAll('.toast-action').forEach((el) => el.remove());
  text.textContent = message;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = action.label;
  toast.appendChild(btn);

  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('visible');
    btn.remove();
  };

  btn.addEventListener('click', () => {
    try {
      action.onClick();
    } finally {
      dismiss();
    }
  });

  toast.classList.add('visible');
  setTimeout(dismiss, ttlMs);

  return { dismiss };
}
