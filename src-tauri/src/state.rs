//! Shared application state.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use shoter_core::boxapi::{self, BoxClient, Credentials, OAuthTokens, TokenSink};
use shoter_core::history::HistoryStore;
use shoter_core::settings::{AppSettings, BoxAuthMode};
use tauri::{AppHandle, Manager};

use crate::capture::CaptureSession;
use crate::secrets::Secrets;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    /// Interactive selection (drag or click a window / UI element).
    Region,
    /// Active (foreground) window.
    Window,
    /// Interactive selection with the "click a window" hint (tray button).
    WindowPick,
    Fullscreen,
    LastRegion,
}

impl CaptureMode {
    pub fn source(self) -> &'static str {
        match self {
            CaptureMode::Region => "region",
            CaptureMode::Window | CaptureMode::WindowPick => "window",
            CaptureMode::Fullscreen => "fullscreen",
            CaptureMode::LastRegion => "lastRegion",
        }
    }
}

/// What to do with a finished capture / edited image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Edit,
    Copy,
    Save,
    SaveAs,
    Upload,
    /// Only keep it in the history (editor closed with changes).
    Store,
}

pub struct Paths {
    pub settings_file: PathBuf,
    pub secrets_file: PathBuf,
    pub history_dir: PathBuf,
    pub default_save_dir: PathBuf,
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
}

#[derive(Default)]
pub struct CaptureFlow {
    pub busy: bool,
    pub started: Option<Instant>,
    pub mode: Option<CaptureMode>,
    pub shown: bool,
}

pub struct AppState {
    pub paths: Paths,
    pub settings: RwLock<AppSettings>,
    pub history: HistoryStore,
    pub secrets: Mutex<Secrets>,
    pub session: Mutex<Option<Arc<CaptureSession>>>,
    pub session_counter: AtomicU64,
    pub flow: Mutex<CaptureFlow>,
    /// Pending `overlay:prepare` payloads by window label (pulled by freshly created overlays).
    pub overlay_pending: Mutex<HashMap<String, serde_json::Value>>,
    pub box_client: Mutex<Option<Arc<BoxClient>>>,
    /// Global shortcut id → capture mode.
    pub hotkeys: Mutex<HashMap<u32, CaptureMode>>,
    pub panel_hidden_at: Mutex<Option<Instant>>,
    /// Serialises Box sign-in flows; `box_login_cancel` aborts a pending one when the
    /// user starts a new sign-in (e.g. closed the browser tab and clicked again).
    pub box_login: tokio::sync::Mutex<()>,
    pub box_login_cancel: tokio::sync::Notify,
    /// Last toast, pulled by the toast page when it loads after the event was sent.
    pub last_toast: Mutex<Option<(crate::ui::Toast, Instant)>>,
    #[cfg(windows)]
    pub ui_selector: crate::uiselect::UiSelector,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let path = app.path();
        let config_dir = path.app_config_dir().map_err(|e| e.to_string())?;
        let data_dir = path.app_local_data_dir().map_err(|e| e.to_string())?;
        let log_dir = path.app_log_dir().unwrap_or_else(|_| data_dir.join("logs"));
        let pictures = path.picture_dir().or_else(|_| path.home_dir()).unwrap_or_else(|_| data_dir.clone());
        // Before the rename to AShot screenshots went to `Pictures\AdvantShoter`: keep using
        // that folder for existing users so their files stay in one place.
        let legacy_save_dir = pictures.join("AdvantShoter");
        let default_save_dir = if legacy_save_dir.is_dir() && !pictures.join("AShot").exists() {
            legacy_save_dir
        } else {
            pictures.join("AShot")
        };
        std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let paths = Paths {
            settings_file: config_dir.join("settings.json"),
            secrets_file: config_dir.join("secrets.dat"),
            history_dir: data_dir.join("history"),
            default_save_dir,
            config_dir,
            data_dir,
            log_dir,
        };
        let settings = AppSettings::load(&paths.settings_file);
        let history = HistoryStore::new(&paths.history_dir, settings.history_limit as usize).map_err(|e| e.to_string())?;
        let secrets = Secrets::load(&paths.secrets_file);
        Ok(Self {
            paths,
            settings: RwLock::new(settings),
            history,
            secrets: Mutex::new(secrets),
            session: Mutex::new(None),
            session_counter: AtomicU64::new(1),
            flow: Mutex::new(CaptureFlow::default()),
            overlay_pending: Mutex::new(HashMap::new()),
            box_client: Mutex::new(None),
            hotkeys: Mutex::new(HashMap::new()),
            panel_hidden_at: Mutex::new(None),
            last_toast: Mutex::new(None),
            box_login: tokio::sync::Mutex::new(()),
            box_login_cancel: tokio::sync::Notify::new(),
            #[cfg(windows)]
            ui_selector: crate::uiselect::UiSelector::spawn(),
        })
    }

    pub fn settings(&self) -> AppSettings {
        self.settings.read().unwrap().clone()
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut AppSettings)) -> AppSettings {
        let mut guard = self.settings.write().unwrap();
        f(&mut guard);
        let s = guard.clone().sanitized();
        *guard = s.clone();
        if let Err(e) = s.save(&self.paths.settings_file) {
            log::error!("cannot save settings: {e}");
        }
        s
    }

    pub fn save_dir(&self) -> PathBuf {
        let s = self.settings.read().unwrap();
        if s.save_folder.trim().is_empty() {
            self.paths.default_save_dir.clone()
        } else {
            PathBuf::from(s.save_folder.trim())
        }
    }

    pub fn update_secrets(&self, f: impl FnOnce(&mut Secrets)) -> Result<(), String> {
        let mut guard = self.secrets.lock().unwrap();
        f(&mut guard);
        guard.save(&self.paths.secrets_file)
    }

    /// OAuth client of the Box app: the user's own app (advanced settings) or the app
    /// built into this build (`SHOTER_BOX_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`).
    pub fn oauth_app(&self) -> Option<OAuthApp> {
        let b = self.settings.read().unwrap().box_.clone();
        let configured = Some(b.redirect_uri.trim().to_string()).filter(|r| !r.is_empty());
        let custom_id = b.client_id.trim().to_string();
        if !custom_id.is_empty() {
            let secret = self.secrets.lock().unwrap().box_client_secret.clone();
            return (!secret.is_empty()).then_some(OAuthApp { client_id: custom_id, client_secret: secret, redirect_uri: configured });
        }
        let (client_id, client_secret) = builtin_box_app()?;
        // A redirect URI typed in the settings wins over the one compiled into the build.
        let redirect_uri = configured.or_else(|| {
            option_env!("SHOTER_BOX_REDIRECT_URI").map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
        });
        Some(OAuthApp { client_id, client_secret, redirect_uri })
    }

    /// Box client built from the current settings and secrets (cached until reset).
    pub fn box_client(&self, app: &AppHandle) -> Result<Arc<BoxClient>, String> {
        if let Some(c) = self.box_client.lock().unwrap().as_ref() {
            return Ok(c.clone());
        }
        let settings = self.settings();
        let secrets = self.secrets.lock().unwrap().clone();
        let b = &settings.box_;
        let credentials = match b.auth_mode {
            BoxAuthMode::DeveloperToken => Credentials::DeveloperToken(secrets.box_developer_token.clone()),
            BoxAuthMode::ClientCredentials => {
                let (subject_type, subject_id) = if b.user_id.trim().is_empty() {
                    ("enterprise", b.enterprise_id.trim().to_string())
                } else {
                    ("user", b.user_id.trim().to_string())
                };
                Credentials::ClientCredentials {
                    client_id: b.client_id.trim().to_string(),
                    client_secret: secrets.box_client_secret.clone(),
                    subject_type: subject_type.into(),
                    subject_id,
                }
            }
            BoxAuthMode::OAuth => {
                let app = self.oauth_app().unwrap_or_default();
                Credentials::OAuth {
                    client_id: app.client_id,
                    client_secret: app.client_secret,
                    tokens: secrets.box_oauth.clone().unwrap_or_default(),
                }
            }
        };
        let sink: Arc<dyn TokenSink> = Arc::new(SecretsSink(app.clone()));
        let client = Arc::new(BoxClient::new(boxapi::http_client(), boxapi::Endpoints::default(), credentials, Some(sink)));
        *self.box_client.lock().unwrap() = Some(client.clone());
        Ok(client)
    }

    pub fn reset_box_client(&self) {
        *self.box_client.lock().unwrap() = None;
    }
}

#[derive(Debug, Clone, Default)]
pub struct OAuthApp {
    pub client_id: String,
    pub client_secret: String,
    /// Redirect URI registered for the app, if known (otherwise it is detected at sign-in).
    pub redirect_uri: Option<String>,
}

/// The Box app compiled into this build, if any.
pub fn builtin_box_app() -> Option<(String, String)> {
    match (option_env!("SHOTER_BOX_CLIENT_ID"), option_env!("SHOTER_BOX_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.trim().is_empty() && !secret.trim().is_empty() => {
            Some((id.trim().to_string(), secret.trim().to_string()))
        }
        _ => None,
    }
}

/// Persists rotated OAuth tokens immediately (Box refresh tokens are single-use).
struct SecretsSink(AppHandle);

impl TokenSink for SecretsSink {
    fn save(&self, tokens: &OAuthTokens) {
        let state = self.0.state::<AppState>();
        if let Err(e) = state.update_secrets(|s| s.box_oauth = Some(tokens.clone())) {
            log::error!("cannot persist Box tokens: {e}");
        }
    }
}
