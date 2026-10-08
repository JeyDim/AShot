// Browser preview without Tauri: open any route with `?mock`, e.g.
// http://localhost:1420/?mock#/panel. Used for UI development and screenshots.
import { emit } from '@tauri-apps/api/event';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { AppSettings, HistoryItem, OverlayPrepare, ToastPayload } from '../lib/types';
import { fakeDesktop, fakeThumb } from './fakeImages';

const settings: AppSettings = {
  showCursor: false,
  showMagnifier: true,
  afterCapture: 'ask',
  fullscreenMode: 'currentMonitor',
  autostart: true,
  historyLimit: 10,
  saveFolder: '',
  fileNamePattern: 'Screenshot {yyyy}-{MM}-{dd} {HH}-{mm}-{ss}',
  imageFormat: 'png',
  jpegQuality: 90,
  hotkeys: { region: 'PrintScreen', window: 'Alt+PrintScreen', fullscreen: 'Control+PrintScreen', lastRegion: 'Shift+PrintScreen' },
  box: { authMode: 'oAuth', clientId: 'k2x8v1n0q9example', enterpriseId: '', userId: '', folderId: '254711938204', sharedLinkAccess: 'open', redirectPort: 47615 },
  links: { rewrite: true, template: 'https://advant.one/{id}', copyAfterUpload: true, openAfterUpload: false },
  editor: { color: '#FF3B30', size: 1 },
  lastRegion: { x: 200, y: 120, width: 1280, height: 720 },
  welcomed: true,
};

const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();
const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const history: HistoryItem[] = [
  item('a1', ago(0.2), 1280, 720, 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r', { edited: true }),
  item('a2', ago(12), 864, 512, null, { savedPath: 'C:\\Users\\ivan\\Pictures\\AdvantShoter\\Screenshot 2026-10-08 14-21-07.png' }),
  item('a3', ago(95), 1920, 1080, 'https://advant.one/8kq2mz0x7v1lp4tj9w3r6c5d', { linkOutdated: true, edited: true }),
  item('a4', ago(60 * 20), 420, 300, null),
  item('a5', ago(60 * 26), 1440, 900, 'https://advant.one/p0w7e3n9x2y5k8m1q4r6s3t0'),
  item('a6', ago(60 * 24 * 5), 1024, 640, null),
];

function item(id: string, createdAt: string, width: number, height: number, shareUrl: string | null, extra: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id,
    createdAt,
    width,
    height,
    source: 'region',
    revision: 1,
    edited: false,
    boxFileId: shareUrl ? '1' : null,
    boxUrl: shareUrl ? 'https://app.box.com/s/x' : null,
    shareUrl,
    uploadedRevision: shareUrl ? 1 : null,
    savedPath: null,
    shortLink: shareUrl ? shareUrl.replace(/^https?:\/\//, '') : null,
    linkOutdated: false,
    ...extra,
  };
}

const sampleDoc = {
  version: 1,
  crop: null,
  shapes: [
    { id: 's1', type: 'rect', x: 610, y: 180, w: 520, h: 250, color: '#FF3B30', size: 1 },
    { id: 's2', type: 'arrow', points: [1380, 620, 1150, 420], color: '#FF3B30', size: 1 },
    { id: 's3', type: 'text', x: 1300, y: 640, text: 'Новая кнопка экспорта', color: '#FF3B30', size: 1 },
    { id: 's4', type: 'step', x: 600, y: 180, n: 1, color: '#0A84FF', size: 1 },
    { id: 's5', type: 'step', x: 330, y: 470, n: 2, color: '#0A84FF', size: 1 },
    { id: 's6', type: 'pixelate', x: 120, y: 640, w: 330, h: 90, color: '#000', size: 1 },
    { id: 's7', type: 'marker', points: [700, 520, 1000, 520], color: '#FFCC00', size: 1 },
  ],
};

export async function installMocks() {
  const page = window.location.hash.replace(/^#\/?/, '').split('/')[0] || 'panel';
  const label = page === 'overlay' ? 'overlay-0' : page === 'editor' ? 'editor-a1' : page;
  mockWindows(label);

  const desktop = await fakeDesktop(1920, 1080);
  const thumbs: Record<string, string> = {};
  for (const [i, id] of ids.entries()) thumbs[id] = await fakeThumb(i);
  (window as unknown as { __SHOT_MOCK__: (p: string) => string }).__SHOT_MOCK__ = (p: string) => {
    if (p.startsWith('session/')) return desktop;
    const m = /^history\/([^/]+)\/(\w+)/.exec(p);
    if (m && m[2] === 'thumb') return thumbs[m[1]] ?? thumbs.a1;
    return desktop;
  };

  const overlay: OverlayPrepare = {
    sessionId: 1,
    monitor: { index: 0, name: 'DISPLAY1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1, primary: true },
    image: 'session/1/0.bmp',
    windows: [
      { title: 'Box', bounds: { x: 560, y: 120, width: 1100, height: 700 } },
      { title: 'Explorer', bounds: { x: 120, y: 80, width: 760, height: 520 } },
      { title: 'Taskbar', bounds: { x: 0, y: 1032, width: 1920, height: 48 } },
    ],
    mode: 'region',
    preselect: new URLSearchParams(location.search).has('selected') ? { x: 560, y: 120, width: 1100, height: 700 } : null,
    autoAction: null,
    showMagnifier: true,
    uiElements: true,
    cursor: [1250, 560],
  };

  mockIPC(
    async (cmd, args) => {
      const a = args as Record<string, unknown>;
      switch (cmd) {
        case 'app_info':
          return {
            name: 'AdvantShoter',
            version: '0.1.0',
            buildDate: '2026-10-08',
            commit: 'a1b2c3d',
            tauriVersion: '2.12.1',
            os: 'windows x86_64',
            configDir: 'C:\\Users\\ivan\\AppData\\Roaming\\one.advant.shoter',
            dataDir: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter',
            logDir: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter\\logs',
          };
        case 'settings_get':
          return { settings, defaultSaveFolder: 'C:\\Users\\ivan\\Pictures\\AdvantShoter', historyFolder: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter\\history' };
        case 'settings_patch':
          Object.assign(settings, a.patch as object);
          return settings;
        case 'settings_set':
          return [];
        case 'history_list':
          return new URLSearchParams(location.search).has('empty') ? [] : history;
        case 'history_get':
          return history.find((h) => h.id === a.id) ?? history[0];
        case 'history_annotations':
          return JSON.stringify(sampleDoc);
        case 'box_status':
          return { mode: 'oAuth', hasClientSecret: true, hasDeveloperToken: false, signedIn: true, redirectUri: 'http://localhost:47615/callback' };
        case 'link_preview':
          return String(a.template).replace('{id}', '3rud4dfakga5r953wt77anhyzo27tm7r');
        case 'overlay_pending':
          return overlay;
        case 'overlay_hit_test':
          return [];
        case 'editor_commit':
          return { shareUrl: 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r', savedPath: null };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  if (page === 'toast') {
    const kind = (new URLSearchParams(location.search).get('kind') ?? 'success') as ToastPayload['kind'];
    const payloads: Record<string, ToastPayload> = {
      success: { kind: 'success', title: 'Ссылка скопирована', message: null, link: 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r', path: null, historyId: 'a1', timeoutMs: 0 },
      error: { kind: 'error', title: 'Не удалось загрузить в Box', message: 'Box API вернул ошибку 403: Access denied', link: null, path: null, historyId: 'a1', timeoutMs: 0 },
      info: { kind: 'info', title: 'AdvantShoter работает в трее', message: 'PrtSc — снимок области. Клик по иконке в трее — меню и последние снимки.', link: null, path: null, historyId: null, timeoutMs: 0 },
      saved: { kind: 'success', title: 'Сохранено', message: 'Screenshot 2026-10-08 14-21-07.png', link: null, path: 'C:\\x.png', historyId: 'a1', timeoutMs: 0 },
    };
    setTimeout(() => emit('toast:show', payloads[kind] ?? payloads.success), 300);
  }
}
