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

// Shortcut list rendering is done with textContent + createElement so
// hostile site titles (from chrome.topSites via pin action) can't inject
// HTML — same discipline as dashboard/dom-utils.ts.
function renderPinnedList(pins: ShortcutPin[]): void {
  const list = document.getElementById('pinnedList');
  if (!list) return;
  list.replaceChildren(
    ...pins.map((pin) => {
      const title = document.createElement('span');
      title.className = 'settings-list-item-title';
      title.textContent = pin.title || hostOf(pin.url);

      const url = document.createElement('span');
      url.className = 'settings-list-item-url';
      url.textContent = pin.url;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'settings-list-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        void setSettings({
          shortcutPins: pins.filter((p) => p.url !== pin.url),
        });
      });

      const li = document.createElement('li');
      li.className = 'settings-list-item';
      li.append(title, url, remove);
      return li;
    }),
  );
}

function renderHiddenList(hides: string[]): void {
  const list = document.getElementById('hiddenList');
  if (!list) return;
  list.replaceChildren(
    ...hides.map((url) => {
      const title = document.createElement('span');
      title.className = 'settings-list-item-title';
      title.textContent = hostOf(url);

      const urlNode = document.createElement('span');
      urlNode.className = 'settings-list-item-url';
      urlNode.textContent = url;

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'settings-list-remove';
      restore.textContent = 'Unhide';
      restore.addEventListener('click', () => {
        void setSettings({
          shortcutHides: hides.filter((u) => u !== url),
        });
      });

      const li = document.createElement('li');
      li.className = 'settings-list-item';
      li.append(title, urlNode, restore);
      return li;
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
