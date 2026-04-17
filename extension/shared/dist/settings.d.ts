export type ThemeMode = 'system' | 'light' | 'dark';
export type ClockFormat = '12h' | '24h';
export interface ToutSettings {
    theme: ThemeMode;
    clock: {
        format: ClockFormat;
    };
}
export declare const SETTINGS_KEY = "tabout:settings";
export declare const THEME_CACHE_KEY = "tabout:theme-cache";
export declare function defaultSettings(): ToutSettings;
export declare function normalizeSettings(raw: unknown): ToutSettings;
export declare function getSettings(): Promise<ToutSettings>;
export declare function setSettings(patch: Partial<ToutSettings>): Promise<ToutSettings>;
export declare function syncThemeCache(theme: ThemeMode): void;
export declare function onSettingsChange(cb: (next: ToutSettings) => void): () => void;
