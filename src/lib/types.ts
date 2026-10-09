// Types mirrored from the Rust side (serde camelCase).

export type AfterCapture = 'ask' | 'openEditor' | 'copy' | 'save' | 'upload';
export type FullscreenMode = 'currentMonitor' | 'allMonitors';
export type ThemeSetting = 'system' | 'light' | 'dark';
export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type BoxAuthMode = 'oAuth' | 'clientCredentials' | 'developerToken';
export type CaptureMode = 'region' | 'windowPick' | 'fullscreen' | 'scroll';
export type Action = 'edit' | 'copy' | 'save' | 'saveAs' | 'upload' | 'store';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Hotkeys {
  region: string;
  window: string;
  fullscreen: string;
  /** Scrolling capture. */
  scroll: string;
}

export interface BoxSettings {
  authMode: BoxAuthMode;
  clientId: string;
  enterpriseId: string;
  userId: string;
  folderId: string;
  folderName: string;
  sharedLinkAccess: 'open' | 'company' | 'collaborators';
  redirectUri: string;
}

/** Where "Get link" uploads screenshots to. */
export type UploadProvider = 'box' | 's3';

/** S3 storage (Yandex Object Storage); empty fields — the build's values. */
export interface S3Settings {
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder in the bucket (`shots/`). */
  prefix: string;
  /** Own key instead of the build's one (its secret is stored encrypted). */
  accessKeyId: string;
}

export interface LinkSettings {
  rewrite: boolean;
  template: string;
  copyAfterUpload: boolean;
  openAfterUpload: boolean;
}

export interface EditorPrefs {
  color: string;
  size: number;
}

export type WatermarkPosition = 'topLeft' | 'top' | 'topRight' | 'left' | 'center' | 'right' | 'bottomLeft' | 'bottom' | 'bottomRight';

/** Watermark / copyright of the editor (its picture is `watermark.png` of the `shot` protocol). */
export interface WatermarkSettings {
  kind: 'text' | 'image';
  /** `tile` — repeated over the whole picture (watermark), `corner` — once (copyright). */
  layout: 'tile' | 'corner';
  text: string;
  color: string;
  /** 0 – small, 1 – medium, 2 – large. */
  size: number;
  /** Percent. */
  opacity: number;
  /** Tile: slope of the rows, degrees. */
  angle: number;
  /** Tile: 0 – dense, 1 – medium, 2 – sparse. */
  spacing: number;
  /** Corner: where it goes. */
  position: WatermarkPosition;
}

export type ResizeSide = 'width' | 'height' | 'longest';

/** "Downscale to N px": applies to everything that leaves the app; history keeps the full size. */
export interface ResizeSettings {
  enabled: boolean;
  side: ResizeSide;
  size: number;
  /** Draw lines and text thicker so they look normal after downscaling. */
  thicken: boolean;
}

/** Features still being tried out: off unless turned on in Settings. */
export interface Experimental {
  /** Scrolling capture: its menu item, panel tile and hotkey. */
  scrollCapture: boolean;
}

export interface AppSettings {
  showCursor: boolean;
  showMagnifier: boolean;
  afterCapture: AfterCapture;
  fullscreenMode: FullscreenMode;
  theme: ThemeSetting;
  /** Size of the app's UI (tray panel, notifications, settings), percent. */
  uiScale: number;
  /** Size of the buttons and panels in the editor and on the selection screen, percent. */
  editorScale: number;
  autostart: boolean;
  historyLimit: number;
  saveFolder: string;
  fileNamePattern: string;
  imageFormat: ImageFormat;
  jpegQuality: number;
  hotkeys: Hotkeys;
  /** `null` — the build's choice (`UploadStatus.defaultProvider`). */
  uploadProvider: UploadProvider | null;
  box: BoxSettings;
  s3: S3Settings;
  links: LinkSettings;
  editor: EditorPrefs;
  resize: ResizeSettings;
  watermark: WatermarkSettings;
  experimental: Experimental;
  welcomed: boolean;
  autoUpdate: boolean;
  lastVersion: string;
  lastSaveAsDir: string;
}

export interface PatchResult {
  settings: AppSettings;
  /** Hotkeys that could not be registered, autostart errors… */
  problems: string[];
}

export interface SettingsView {
  settings: AppSettings;
  defaultSaveFolder: string;
  historyFolder: string;
  /** Link template used while settings.links.template is empty. */
  defaultLinkTemplate: string;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  source: string;
  revision: number;
  edited: boolean;
  boxFileId: string | null;
  boxUrl: string | null;
  shareUrl: string | null;
  uploadedRevision: number | null;
  savedPath: string | null;
  shortLink: string | null;
  linkOutdated: boolean;
}

export interface MonitorInfo {
  index: number;
  name: string;
  bounds: Rect;
  workArea: Rect;
  scale: number;
  primary: boolean;
}

export interface WindowInfo {
  title: string;
  bounds: Rect;
}

export interface OverlayPrepare {
  /** Overlay window the payload is for (`overlay-<monitor>`). */
  label: string;
  sessionId: number;
  monitor: MonitorInfo;
  /** Bounds of all monitors by index (the overlay `overlay-<index>` is over each): a selection
   *  may reach the other monitors and is handed over to the one under its middle. */
  monitors: Rect[];
  image: string;
  windows: WindowInfo[];
  mode: CaptureMode;
  preselect: Rect | null;
  autoAction: Action | null;
  showMagnifier: boolean;
  uiElements: boolean;
  cursor: [number, number];
}

export interface ToastPayload {
  kind: 'success' | 'error' | 'info' | 'progress';
  title: string;
  message: string | null;
  link: string | null;
  path: string | null;
  historyId: string | null;
  /** Offer "Retry" for a failed upload of `historyId`. */
  retryUpload: boolean;
  /** Offer "Stop" for the running scrolling capture. */
  stopScroll?: boolean;
  timeoutMs: number;
}

export interface AppInfo {
  name: string;
  version: string;
  buildDate: string;
  commit: string;
  tauriVersion: string;
  os: string;
  configDir: string;
  dataDir: string;
  logDir: string;
  /** Dev build of a pull request ("PR #12"); empty for releases. */
  channel: string;
}

export interface BoxStatus {
  mode: BoxAuthMode;
  ready: boolean;
  signedIn: boolean;
  account: BoxUser | null;
  builtinApp: boolean;
  customApp: boolean;
  hasClientSecret: boolean;
  hasDeveloperToken: boolean;
  redirectUri: string;
}

export interface BoxUser {
  id: string;
  name: string;
  login: string;
}

export interface UploadStatus {
  /** Where uploads go now. */
  provider: UploadProvider;
  /** The build's choice (while the settings have none). */
  defaultProvider: UploadProvider;
  /** Link template while `links.template` is empty (depends on the storage). */
  defaultLinkTemplate: string;
  s3: S3Status;
}

export interface S3Status {
  ready: boolean;
  /** The build has a storage key built in. */
  builtinKey: boolean;
  /** The secret of the own key is saved. */
  hasSecret: boolean;
  /** Values in effect (the settings', else the build's / defaults). */
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
}

export interface ActionResult {
  shareUrl: string | null;
  savedPath: string | null;
}

/** Self-update from GitHub Releases (`update:state` event, `update_state` command). */
export type UpdateState =
  | { phase: 'disabled' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'upToDate' }
  | { phase: 'available'; version: string; notes: string; url: string }
  | { phase: 'downloading'; version: string; downloaded: number; total: number }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; message: string };
