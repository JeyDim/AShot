// Types mirrored from the Rust side (serde camelCase).

export type AfterCapture = 'ask' | 'openEditor' | 'copy' | 'save' | 'upload';
export type FullscreenMode = 'currentMonitor' | 'allMonitors';
export type ImageFormat = 'png' | 'jpeg';
export type BoxAuthMode = 'oAuth' | 'clientCredentials' | 'developerToken';
export type CaptureMode = 'region' | 'window' | 'windowPick' | 'fullscreen' | 'lastRegion';
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
  lastRegion: string;
}

export interface BoxSettings {
  authMode: BoxAuthMode;
  clientId: string;
  enterpriseId: string;
  userId: string;
  folderId: string;
  sharedLinkAccess: 'open' | 'company' | 'collaborators';
  redirectPort: number;
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

export interface AppSettings {
  showCursor: boolean;
  showMagnifier: boolean;
  afterCapture: AfterCapture;
  fullscreenMode: FullscreenMode;
  autostart: boolean;
  historyLimit: number;
  saveFolder: string;
  fileNamePattern: string;
  imageFormat: ImageFormat;
  jpegQuality: number;
  hotkeys: Hotkeys;
  box: BoxSettings;
  links: LinkSettings;
  editor: EditorPrefs;
  lastRegion: Rect | null;
  welcomed: boolean;
}

export interface SettingsView {
  settings: AppSettings;
  defaultSaveFolder: string;
  historyFolder: string;
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
  sessionId: number;
  monitor: MonitorInfo;
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
}

export interface BoxStatus {
  mode: BoxAuthMode;
  hasClientSecret: boolean;
  hasDeveloperToken: boolean;
  signedIn: boolean;
  redirectUri: string;
}

export interface BoxUser {
  id: string;
  name: string;
  login: string;
}

export interface ActionResult {
  shareUrl: string | null;
  savedPath: string | null;
}
