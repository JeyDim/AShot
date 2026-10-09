// Browser preview without Tauri: open any route with `?mock`, e.g.
// http://localhost:1420/?mock#/panel. Used for UI development and screenshots.
import { emit } from '@tauri-apps/api/event';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { AppSettings, CaptureMode, HistoryItem, OverlayPrepare, ToastPayload } from '../lib/types';
import { fakeDesktop, fakeThumb } from './fakeImages';

const query = new URLSearchParams(location.search);

const settings: AppSettings = {
  showCursor: false,
  showMagnifier: true,
  afterCapture: 'ask',
  fullscreenMode: 'currentMonitor',
  // `&theme=light|dark` for screenshots of both themes.
  theme: (query.get('theme') as AppSettings['theme']) ?? 'system',
  uiScale: 100,
  autostart: true,
  historyLimit: 10,
  saveFolder: '',
  fileNamePattern: 'Screenshot {date} {time}',
  imageFormat: 'png',
  jpegQuality: 90,
  hotkeys: { region: 'Control+PrintScreen', window: 'Alt+PrintScreen', fullscreen: 'Shift+PrintScreen', scroll: 'Control+Shift+PrintScreen' },
  box: { authMode: 'oAuth', clientId: 'k2x8v1n0q9example', enterpriseId: '', userId: '', folderId: '', folderName: 'AShot', sharedLinkAccess: 'open', redirectUri: '' },
  links: { rewrite: true, template: '', copyAfterUpload: true, openAfterUpload: false },
  editor: { color: '#FF3B30', size: 1 },
  resize: { enabled: false, side: 'width', size: 740, thicken: true },
  watermark: { kind: 'text', layout: 'tile', text: 'AShot', color: '#FFFFFF', size: 1, opacity: 25, angle: 30, spacing: 1, position: 'bottomRight' },
  // `&experimental` turns the experiments on (the scrolling capture).
  experimental: { scrollCapture: query.has('experimental') },
  welcomed: true,
  autoUpdate: true,
  lastVersion: '0.1.57',
  lastSaveAsDir: '',
};

const now = Date.now();
const ago = (m: number) => new Date(now - m * 60_000).toISOString();
const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const history: HistoryItem[] = [
  item('a1', ago(0.2), 1280, 720, 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r', { edited: true }),
  item('a2', ago(12), 864, 512, null, { savedPath: 'C:\\Users\\ivan\\Pictures\\AShot\\Screenshot 2026-10-08 14-21-07.png' }),
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
  // Copyright picture: none until "picked" (`watermark_pick`); `&logo` — one from the start.
  let logo: string | null = query.has('logo') ? fakeLogo() : null;
  (window as unknown as { __SHOT_MOCK__: (p: string) => string }).__SHOT_MOCK__ = (p: string) => {
    if (p.startsWith('session/')) return desktop;
    if (p.startsWith('watermark.png')) return logo ?? 'data:,';
    const m = /^history\/([^/]+)\/(\w+)/.exec(p);
    if (m && m[2] === 'thumb') return thumbs[m[1]] ?? thumbs.a1;
    return desktop;
  };

  // `&mode=windowPick` — the window mode (whole windows only); `&mode=fullscreen` — pick a screen;
  // `&mode=scroll` — scrolling capture.
  const mode = (query.get('mode') as CaptureMode | null) ?? 'region';
  const overlay: OverlayPrepare = {
    label: 'overlay-0',
    sessionId: 1,
    monitor: { index: 0, name: 'DISPLAY1', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scale: 1, primary: true },
    image: 'session/1/0.bmp',
    windows: [
      { title: 'Box', bounds: { x: 560, y: 120, width: 1100, height: 700 } },
      { title: 'Explorer', bounds: { x: 120, y: 80, width: 760, height: 520 } },
      { title: 'Taskbar', bounds: { x: 0, y: 1032, width: 1920, height: 48 } },
    ],
    mode,
    preselect: new URLSearchParams(location.search).has('selected') ? { x: 560, y: 120, width: 1100, height: 700 } : null,
    // The scroll mode starts scrolling right after the area is chosen.
    autoAction: mode === 'scroll' || mode === 'fullscreen' ? 'edit' : null,
    showMagnifier: true,
    uiElements: mode === 'region' || mode === 'scroll',
    cursor: [1250, 560],
  };

  mockIPC(
    async (cmd, args) => {
      const a = args as Record<string, unknown>;
      switch (cmd) {
        case 'app_info':
          return {
            name: 'AShot',
            version: '0.1.0',
            buildDate: '2026-10-08',
            commit: 'a1b2c3d',
            tauriVersion: '2.12.1',
            os: 'windows x86_64',
            configDir: 'C:\\Users\\ivan\\AppData\\Roaming\\one.advant.shoter',
            dataDir: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter',
            logDir: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter\\logs',
            // `&channel=PR%20%2312` — a dev build of a pull request.
            channel: query.get('channel') ?? '',
          };
        case 'settings_get':
          return { settings: structuredClone(settings), defaultSaveFolder: 'C:\\Users\\ivan\\Pictures\\AShot', historyFolder: 'C:\\Users\\ivan\\AppData\\Local\\one.advant.shoter\\history', defaultLinkTemplate: 'https://app.box.com/embed/s/{id}' };
        case 'settings_patch':
          deepAssign(settings as unknown as Record<string, unknown>, a.patch as Record<string, unknown>);
          // Copies, like the real IPC: pages must never share (and mutate) one object.
          emit('settings:changed', structuredClone(settings));
          return { settings: structuredClone(settings), problems: [] };
        case 'pick_folder':
          return 'D:\\Screenshots';
        case 'watermark_pick':
          logo = fakeLogo();
          return true;
        case 'watermark_clear':
          logo = null;
          return null;
        case 'history_list':
          return query.has('empty') ? [] : history;
        case 'history_get':
          return history.find((h) => h.id === a.id) ?? history[0];
        case 'history_annotations':
          return JSON.stringify(sampleDoc);
        case 'box_status':
          return query.has('signedout')
            ? { mode: 'oAuth', ready: false, signedIn: false, account: null, builtinApp: true, customApp: false, hasClientSecret: false, hasDeveloperToken: false, redirectUri: 'https://www.box.com/home/' }
            : {
                mode: 'oAuth',
                ready: true,
                signedIn: true,
                account: { id: '1', name: 'Иван Петров', login: 'ivan.petrov@advant.one' },
                builtinApp: true,
                customApp: false,
                hasClientSecret: false,
                hasDeveloperToken: false,
                redirectUri: 'https://www.box.com/home/',
              };
        case 'history_clear':
          return history.splice(0).length;
        case 'update_state': {
          // ?update=available|downloading|upToDate|error|disabled — states of «О программе».
          const phase = query.get('update') ?? 'idle';
          if (phase === 'available') return { phase, version: '0.1.58', notes: 'Новый дизайн', url: 'https://github.com/' };
          if (phase === 'downloading') return { phase, version: '0.1.58', downloaded: 6_200_000, total: 9_800_000 };
          if (phase === 'error') return { phase, message: 'Не удалось проверить обновления: сеть: connection refused' };
          return { phase };
        }
        case 'update_check':
          await new Promise((r) => setTimeout(r, 400));
          return { phase: 'available', version: '0.1.58', notes: 'Новый дизайн', url: 'https://github.com/' };
        case 'update_install':
          for (let i = 0; i <= 10; i++) {
            await emit('update:state', { phase: 'downloading', version: '0.1.58', downloaded: i * 980_000, total: 9_800_000 });
            await new Promise((r) => setTimeout(r, 80));
          }
          await emit('update:state', { phase: 'installing', version: '0.1.58' });
          return null;
        case 'link_preview':
          return String(a.template || 'https://app.box.com/embed/s/{id}').replace('{id}', '3rud4dfakga5r953wt77anhyzo27tm7r');
        case 'toast_current':
          return null;
        case 'overlay_pending':
          return overlay;
        case 'overlay_hit_test':
          return [];
        case 'overlay_scroll_target': {
          // The page of the "Box" window (under its title and address bars).
          const page = { x: 560, y: 190, width: 1100, height: 630 };
          const { x, y } = a as { x: number; y: number };
          return x >= page.x && y >= page.y && x < page.x + page.width && y < page.y + page.height ? [page] : [];
        }
        case 'overlay_save_path': {
          // Scripts set `window.__savePath`; null — the dialog was cancelled.
          const w = window as unknown as { __savePath?: string; __saveDialogs?: number };
          w.__saveDialogs = (w.__saveDialogs ?? 0) + 1;
          return w.__savePath ?? null;
        }
        case 'overlay_finish_annotated':
        case 'editor_commit': {
          // Exposed for scripts/ui-smoke.mjs: parse [u32 json len][json][png].
          const body = args as unknown as Uint8Array;
          const len = new DataView(body.buffer, body.byteOffset).getUint32(0, true);
          const doc = JSON.parse(new TextDecoder().decode(body.slice(4, 4 + len)));
          const png = body.slice(4 + len);
          const dv = new DataView(png.buffer, png.byteOffset);
          const w = window as unknown as { __commits?: unknown[] };
          // Watermark / copyright: how many, the first one and whether it lies under the drawings.
          const marks = doc.shapes.filter((s: { type: string }) => s.type === 'stamp' || s.type === 'watermark');
          (w.__commits ??= []).push({
            cmd,
            shapes: doc.shapes.length,
            marks: marks.length,
            mark: marks[0] ?? null,
            firstType: doc.shapes[0]?.type ?? null,
            crop: doc.crop,
            width: dv.getUint32(16),
            height: dv.getUint32(20),
            bytes: png.length,
          });
          return { shareUrl: 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r', savedPath: null };
        }
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  if (page === 'toast') {
    const kind = query.get('kind') ?? 'success';
    const base = { message: null, link: null, path: null, historyId: 'a1', retryUpload: false, timeoutMs: 0 };
    const payloads: Record<string, ToastPayload> = {
      success: { ...base, kind: 'success', title: 'Ссылка скопирована', link: 'https://advant.one/3rud4dfakga5r953wt77anhyzo27tm7r' },
      progress: { ...base, kind: 'progress', title: 'Загрузка в Box…', message: 'Ссылка скопируется автоматически' },
      error: { ...base, kind: 'error', title: 'Не удалось загрузить в Box', message: 'Нет соединения с Box. Снимок сохранён в истории.', retryUpload: true },
      info: {
        ...base,
        kind: 'info',
        title: 'AShot работает в трее',
        message: 'Ctrl+PrtSc — область, Alt+PrtSc — окно, Shift+PrtSc — экран. Клик по иконке в трее — меню и последние снимки.',
        historyId: null,
      },
      saved: { ...base, kind: 'success', title: 'Сохранено', message: 'Screenshot 2026-10-08 14-21-07.png', path: 'C:\\x.png' },
      scroll: { ...base, kind: 'progress', title: 'Снимок с прокруткой', message: '7 кадров · 4120 px · Esc — остановить', historyId: null, stopScroll: true },
    };
    setTimeout(() => emit('toast:show', payloads[kind] ?? payloads.success), 1000);
  }
}

/** A wordmark with a transparent background, like a company logo. */
function fakeLogo(): string {
  const c = document.createElement('canvas');
  c.width = 360;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#B5F000';
  ctx.beginPath();
  ctx.roundRect(4, 8, 80, 80, 20);
  ctx.fill();
  ctx.fillStyle = '#1E1E20';
  ctx.font = 'bold 56px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('A', 26, 50);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 54px sans-serif';
  ctx.fillText('ADVANT', 100, 50);
  return c.toDataURL('image/png');
}

function deepAssign(target: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object') deepAssign(cur as Record<string, unknown>, v as Record<string, unknown>);
    else target[k] = v;
  }
}
