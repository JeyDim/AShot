// Typed wrappers around the Rust commands.
import { invoke } from '@tauri-apps/api/core';
import type { Action, ActionResult, AppInfo, AppSettings, BoxStatus, BoxUser, CaptureMode, HistoryItem, OverlayPrepare, PatchResult, Rect, SettingsView, ToastPayload, UpdateState } from './types';

/** Sections of the settings window (`links` is an alias of `box`). */
export type SettingsSection = 'general' | 'hotkeys' | 'saving' | 'box' | 'links' | 'about';

export const api = {
  appInfo: () => invoke<AppInfo>('app_info'),

  settingsGet: () => invoke<SettingsView>('settings_get'),
  /** Changes only the given keys; side effects (hotkeys, autostart, theme…) apply at once. */
  settingsPatch: (patch: Partial<AppSettings> | Record<string, unknown>) => invoke<PatchResult>('settings_patch', { patch }),
  hotkeysSuspend: (suspended: boolean) => invoke<string[]>('hotkeys_suspend', { suspended }),

  capture: (mode: CaptureMode) => invoke<void>('capture', { mode }),
  overlayPending: () => invoke<OverlayPrepare | null>('overlay_pending'),
  overlayReady: (sessionId: number) => invoke<void>('overlay_ready', { sessionId }),
  /** "Save as…" dialog over the overlay (it stays open when cancelled); `null` — cancelled. */
  overlaySavePath: (width: number, height: number) => invoke<string | null>('overlay_save_path', { width, height }),
  /** `savePath` — the file chosen with `overlaySavePath` (action `saveAs`). */
  overlayFinish: (rect: Rect, action: Action, savePath?: string) => invoke<void>('overlay_finish', { rect, action, savePath: savePath ?? null }),
  /** Finish with drawings: the rendered PNG + the editor document (relative to the selection). */
  overlayFinishAnnotated: (rect: Rect, action: Action, png: Uint8Array, docJson: string, savePath?: string) => {
    const json = new TextEncoder().encode(docJson);
    const body = new Uint8Array(4 + json.length + png.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(png, 4 + json.length);
    return invoke<void>('overlay_finish_annotated', body, {
      headers: {
        'x-rect': `${rect.x},${rect.y},${rect.width},${rect.height}`,
        'x-action': action,
        // Header values must be ASCII; paths may contain Cyrillic letters.
        ...(savePath ? { 'x-save-path': encodeURIComponent(savePath) } : {}),
      },
    });
  },
  overlayCancel: () => invoke<void>('overlay_cancel'),
  overlayHitTest: (x: number, y: number) => invoke<Rect[]>('overlay_hit_test', { x, y }),

  historyList: () => invoke<HistoryItem[]>('history_list'),
  historyGet: (id: string) => invoke<HistoryItem>('history_get', { id }),
  historyAnnotations: (id: string) => invoke<string | null>('history_annotations', { id }),
  historyDelete: (id: string) => invoke<void>('history_delete', { id }),
  historyClear: () => invoke<number>('history_clear'),
  historyOpen: (id: string) => invoke<void>('history_open', { id }),
  historyCopy: (id: string) => invoke<void>('history_copy', { id }),
  historyCopyLink: (id: string) => invoke<void>('history_copy_link', { id }),
  historySave: (id: string) => invoke<string>('history_save', { id }),
  historySaveAs: (id: string) => invoke<string | null>('history_save_as', { id }),
  historyUpload: (id: string) => invoke<string>('history_upload', { id }),

  /** Copyright picture: file dialog, stored as `watermark.png`; `false` — cancelled. */
  watermarkPick: () => invoke<boolean>('watermark_pick'),
  watermarkClear: () => invoke<void>('watermark_clear'),

  /** Sends the rendered PNG + editor document; `action` decides what happens next. */
  editorCommit: (id: string, action: Action, png: Uint8Array, docJson: string) => {
    const json = new TextEncoder().encode(docJson);
    const body = new Uint8Array(4 + json.length + png.length);
    new DataView(body.buffer).setUint32(0, json.length, true);
    body.set(json, 4);
    body.set(png, 4 + json.length);
    return invoke<ActionResult>('editor_commit', body, { headers: { 'x-id': id, 'x-action': action } });
  },

  openSettings: (section?: SettingsSection) => invoke<void>('open_settings', { section: section ?? null }),
  /** Applies the "UI scale" setting to this window (web view zoom). */
  uiZoom: () => invoke<void>('ui_zoom'),
  panelHide: () => invoke<void>('panel_hide'),
  toastCurrent: () => invoke<ToastPayload | null>('toast_current'),
  toastHide: () => invoke<void>('toast_hide'),
  quit: () => invoke<void>('quit'),
  copyText: (text: string) => invoke<void>('copy_text', { text }),
  openUrl: (url: string) => invoke<void>('open_url', { url }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  openFolder: (which: 'save' | 'history' | 'logs' | 'config') => invoke<void>('open_folder', { which }),
  /** Folder picker; `null` when cancelled. */
  pickFolder: (current: string) => invoke<string | null>('pick_folder', { current }),

  boxStatus: () => invoke<BoxStatus>('box_status'),
  boxSetSecret: (kind: 'clientSecret' | 'developerToken', value: string) => invoke<void>('box_set_secret', { kind, value }),
  boxTest: () => invoke<BoxUser>('box_test'),
  boxLogin: () => invoke<BoxUser>('box_login'),
  boxLogout: () => invoke<void>('box_logout'),
  linkPreview: (template: string) => invoke<string>('link_preview', { template }),

  updateState: () => invoke<UpdateState>('update_state'),
  updateCheck: () => invoke<UpdateState>('update_check'),
  updateInstall: () => invoke<void>('update_install'),
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

/** The copyright picture as a data URL (it goes into the editor document), `null` — none. */
export async function loadWatermarkLogo(): Promise<string | null> {
  try {
    const res = await fetch(shotUrl(`watermark.png?r=${Date.now()}`));
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size) return null;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
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
