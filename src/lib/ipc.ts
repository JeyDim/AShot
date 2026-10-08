// Typed wrappers around the Rust commands.
import { invoke } from '@tauri-apps/api/core';
import type {
  Action,
  ActionResult,
  AppInfo,
  AppSettings,
  BoxStatus,
  BoxUser,
  CaptureMode,
  HistoryItem,
  OverlayPrepare,
  Rect,
  SettingsView,
  ToastPayload,
} from './types';

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),

  settingsGet: () => invoke<SettingsView>('settings_get'),
  settingsSet: (settings: AppSettings) => invoke<string[]>('settings_set', { settings }),
  settingsPatch: (patch: Partial<AppSettings> | Record<string, unknown>) => invoke<AppSettings>('settings_patch', { patch }),
  hotkeysSuspend: (suspended: boolean) => invoke<string[]>('hotkeys_suspend', { suspended }),

  capture: (mode: CaptureMode) => invoke<void>('capture', { mode }),
  overlayPending: () => invoke<OverlayPrepare | null>('overlay_pending'),
  overlayReady: (sessionId: number) => invoke<void>('overlay_ready', { sessionId }),
  overlayFinish: (rect: Rect, action: Action) => invoke<void>('overlay_finish', { rect, action }),
  overlayCancel: () => invoke<void>('overlay_cancel'),
  overlayHitTest: (x: number, y: number) => invoke<Rect[]>('overlay_hit_test', { x, y }),

  historyList: () => invoke<HistoryItem[]>('history_list'),
  historyGet: (id: string) => invoke<HistoryItem>('history_get', { id }),
  historyAnnotations: (id: string) => invoke<string | null>('history_annotations', { id }),
  historyDelete: (id: string) => invoke<void>('history_delete', { id }),
  historyClear: () => invoke<void>('history_clear'),
  historyOpen: (id: string) => invoke<void>('history_open', { id }),
  historyCopy: (id: string) => invoke<void>('history_copy', { id }),
  historyCopyLink: (id: string) => invoke<void>('history_copy_link', { id }),
  historySave: (id: string) => invoke<string>('history_save', { id }),
  historySaveAs: (id: string) => invoke<string | null>('history_save_as', { id }),
  historyUpload: (id: string) => invoke<string>('history_upload', { id }),

  /** Sends the rendered PNG + editor document; `action` decides what happens next. */
  editorCommit: (id: string, action: Action, png: Uint8Array, docJson: string) => {
    const json = new TextEncoder().encode(docJson);
    const body = new Uint8Array(4 + json.length + png.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(png, 4 + json.length);
    return invoke<ActionResult>('editor_commit', body, { headers: { 'x-id': id, 'x-action': action } });
  },

  openSettings: (section?: 'general' | 'hotkeys' | 'saving' | 'box' | 'links') => invoke<void>('open_settings', { section: section ?? null }),
  openAbout: () => invoke<void>('open_about'),
  panelHide: () => invoke<void>('panel_hide'),
  toastCurrent: () => invoke<ToastPayload | null>('toast_current'),
  toastHide: () => invoke<void>('toast_hide'),
  quit: () => invoke<void>('quit'),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  openFolder: (which: 'save' | 'history' | 'logs' | 'config') => invoke<void>('open_folder', { which }),

  boxStatus: () => invoke<BoxStatus>('box_status'),
  boxSetSecret: (kind: 'clientSecret' | 'developerToken', value: string) => invoke<void>('box_set_secret', { kind, value }),
  boxTest: () => invoke<BoxUser>('box_test'),
  boxLogin: () => invoke<BoxUser>('box_login'),
  boxLogout: () => invoke<void>('box_logout'),
  linkPreview: (template: string) => invoke<string>('link_preview', { template }),
};

/** URL of a resource served by the Rust `shot` protocol. */
export function shotUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  if (typeof window !== 'undefined' && (window as unknown as { __SHOT_MOCK__?: (p: string) => string }).__SHOT_MOCK__) {
    return (window as unknown as { __SHOT_MOCK__: (p: string) => string }).__SHOT_MOCK__(clean);
  }
  // WebView2 (Windows) exposes custom protocols as http://<scheme>.localhost
  return navigator.userAgent.includes('Windows') ? `http://shot.localhost/${clean}` : `shot://localhost/${clean}`;
}

export function errorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
