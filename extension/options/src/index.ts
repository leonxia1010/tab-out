import {
  getSettings,
  setSettings,
  onSettingsChange,
  type ToutSettings,
  type ThemeMode,
  type ClockFormat,
  type Layout,
  type ShortcutPin,
} from '../../shared/dist/settings.js';
import { el } from '../../shared/dist/dom-utils.js';

function radios(name: string): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`);
}

function setRadioValue(name: string, value: string): void {
  for (const input of radios(name)) {
    input.checked = input.value === value;
  }
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

// Shortcut list rendering routes every user-supplied string through
// shared/dom-utils el() so hostile titles (chrome.topSites → pin action)
// can't inject HTML — same discipline the dashboard widgets use.
function renderPinnedList(pins: ShortcutPin[]): void {
  const list = document.getElementById('pinnedList');
  if (!list) return;
  list.replaceChildren(
    ...pins.map((pin) => {
      const remove = el('button', {
        type: 'button',
        className: 'settings-list-remove',
      }, ['Remove']) as HTMLButtonElement;
      remove.addEventListener('click', () => {
        void setSettings({
          shortcutPins: pins.filter((p) => p.url !== pin.url),
        });
      });
      return el('li', { className: 'settings-list-item' }, [
        el('span', { className: 'settings-list-item-title' }, [pin.title || hostOf(pin.url)]),
        el('span', { className: 'settings-list-item-url' }, [pin.url]),
        remove,
      ]);
    }),
  );
}

function renderHiddenList(hides: string[]): void {
  const list = document.getElementById('hiddenList');
  if (!list) return;
  list.replaceChildren(
    ...hides.map((url) => {
      const restore = el('button', {
        type: 'button',
        className: 'settings-list-remove',
      }, ['Unhide']) as HTMLButtonElement;
      restore.addEventListener('click', () => {
        void setSettings({
          shortcutHides: hides.filter((u) => u !== url),
        });
      });
      return el('li', { className: 'settings-list-item' }, [
        el('span', { className: 'settings-list-item-title' }, [hostOf(url)]),
        el('span', { className: 'settings-list-item-url' }, [url]),
        restore,
      ]);
    }),
  );
}

function applyToForm(settings: ToutSettings): void {
  setRadioValue('theme', settings.theme);
  setRadioValue('clockFormat', settings.clock.format);
  setRadioValue('layout', settings.layout);
  renderPinnedList(settings.shortcutPins);
  renderHiddenList(settings.shortcutHides);
}

function isTheme(v: string): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

function isClockFormat(v: string): v is ClockFormat {
  return v === '12h' || v === '24h';
}

function isLayout(v: string): v is Layout {
  return v === 'masonry' || v === 'grid';
}

function wireRadio(name: string, handler: (value: string) => void): void {
  for (const input of radios(name)) {
    input.addEventListener('change', () => {
      if (input.checked) handler(input.value);
    });
  }
}

async function bootstrap(): Promise<void> {
  const initial = await getSettings();
  applyToForm(initial);

  wireRadio('theme', (value) => {
    if (isTheme(value)) void setSettings({ theme: value });
  });

  wireRadio('clockFormat', (value) => {
    if (isClockFormat(value)) void setSettings({ clock: { format: value } });
  });

  wireRadio('layout', (value) => {
    if (isLayout(value)) void setSettings({ layout: value });
  });

  // Reflect external writes (dashboard toggle, other windows) into the form.
  onSettingsChange(applyToForm);
}

void bootstrap();
