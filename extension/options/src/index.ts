import {
  getSettings,
  setSettings,
  onSettingsChange,
  type ToutSettings,
  type ThemeMode,
  type ClockFormat,
  type Layout,
} from '../../shared/dist/settings.js';

function radios(name: string): NodeListOf<HTMLInputElement> {
  return document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`);
}

function setRadioValue(name: string, value: string): void {
  for (const input of radios(name)) {
    input.checked = input.value === value;
  }
}

function applyToForm(settings: ToutSettings): void {
  setRadioValue('theme', settings.theme);
  setRadioValue('clockFormat', settings.clock.format);
  setRadioValue('layout', settings.layout);
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
