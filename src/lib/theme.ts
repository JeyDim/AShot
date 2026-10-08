// Light / dark theme: `<html data-theme>` switches the color tokens in styles.css.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { api } from './ipc';
import type { AppSettings, ThemeSetting } from './types';

const CACHE_KEY = 'theme';

function setTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    /* storage unavailable */
  }
}

const inTauri = () => '__TAURI_INTERNALS__' in window && !new URLSearchParams(location.search).has('mock');

/** Windows light/dark mode. The web view's `prefers-color-scheme` is fixed when the
 * window is created, so inside the app ask the window instead. */
async function systemTheme(): Promise<'light' | 'dark'> {
  if (inTauri()) {
    try {
      return (await getCurrentWindow().theme()) === 'dark' ? 'dark' : 'light';
    } catch {
      /* fall through */
    }
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function apply(setting: ThemeSetting) {
  setTheme(setting === 'system' ? await systemTheme() : setting);
}

/**
 * Applies the theme setting and follows its changes (and Windows' own theme while the
 * setting is "system"). `forced` keeps a fixed theme (the capture overlay is always dark).
 */
export function initTheme(forced?: 'light' | 'dark') {
  if (forced) return setTheme(forced);
  // Last known theme first – no flash while the settings load.
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
  setTheme(cached === 'dark' || cached === 'light' ? cached : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  let setting: ThemeSetting = 'system';
  api
    .settingsGet()
    .then((v) => {
      setting = v.settings.theme ?? 'system';
      return apply(setting);
    })
    .catch(() => {});
  listen<AppSettings>('settings:changed', (e) => {
    setting = e.payload.theme ?? 'system';
    apply(setting);
  }).catch(() => {});
  if (inTauri()) {
    getCurrentWindow()
      .onThemeChanged(({ payload }) => {
        if (setting === 'system') setTheme(payload === 'dark' ? 'dark' : 'light');
      })
      .catch(() => {});
  } else {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (setting === 'system') apply(setting);
    });
  }
}
