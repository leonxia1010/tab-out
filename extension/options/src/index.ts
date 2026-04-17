import {
  getSettings,
  setSettings,
  onSettingsChange,
  type ToutSettings,
  type ThemeMode,
  type ClockFormat,
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
}

function isTheme(v: string): v is ThemeMode {
  return v === 'system' || v === 'light' || v === 'dark';
}

function isClockFormat(v: string): v is ClockFormat {
  return v === '12h' || v === '24h';
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

  // Reflect external writes (dashboard toggle, other windows) into the form.
  onSettingsChange(applyToForm);
}

void bootstrap();
