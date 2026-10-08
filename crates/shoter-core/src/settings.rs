//! Application settings persisted as JSON.
//!
//! Secrets (Box client secret, tokens) are NOT stored here – the application keeps
//! them separately, encrypted with Windows DPAPI.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::geometry::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AfterCapture {
    /// Show the action bar next to the selection (edit / copy / save / upload).
    #[default]
    Ask,
    OpenEditor,
    Copy,
    Save,
    Upload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FullscreenMode {
    /// Monitor under the mouse cursor.
    #[default]
    CurrentMonitor,
    AllMonitors,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    #[default]
    Png,
    Jpeg,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub region: String,
    pub window: String,
    pub fullscreen: String,
    pub last_region: String,
}

impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            region: "PrintScreen".into(),
            window: "Alt+PrintScreen".into(),
            fullscreen: "Control+PrintScreen".into(),
            last_region: "Shift+PrintScreen".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum BoxAuthMode {
    /// OAuth 2.0: user signs in in the browser, refresh token is kept.
    #[default]
    OAuth,
    /// Client Credentials Grant (server authentication, service account or user).
    ClientCredentials,
    /// Developer token from the Box developer console (valid 60 minutes, for testing).
    DeveloperToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BoxSettings {
    pub auth_mode: BoxAuthMode,
    /// Own Box app (advanced). Empty = the Box app built into this build, so users
    /// only press "Sign in with Box".
    pub client_id: String,
    /// For Client Credentials: enterprise id (or empty when `user_id` is used).
    pub enterprise_id: String,
    /// For Client Credentials: act as this user instead of the service account.
    pub user_id: String,
    /// Destination folder id ("0" is the root "All files" folder).
    /// Empty = folder `folder_name` in the root, created automatically.
    pub folder_id: String,
    pub folder_name: String,
    /// Shared link access level: "open" (anyone with the link – needed for phones
    /// without a Box login), "company" or "collaborators".
    pub shared_link_access: String,
    /// Port of the default local OAuth redirect: `http://localhost:{port}/callback`.
    pub redirect_port: u16,
    /// Redirect URI of the own Box app (advanced). Empty = the default local redirect.
    /// A non-local URI (as in Greenshot) makes the app show the Box sign-in in its own window.
    pub redirect_uri: String,
}

impl Default for BoxSettings {
    fn default() -> Self {
        Self {
            auth_mode: BoxAuthMode::OAuth,
            client_id: String::new(),
            enterprise_id: String::new(),
            user_id: String::new(),
            folder_id: String::new(),
            folder_name: DEFAULT_BOX_FOLDER.into(),
            shared_link_access: "open".into(),
            redirect_port: 47615,
            redirect_uri: String::new(),
        }
    }
}

impl BoxSettings {
    pub fn default_redirect_uri(&self) -> String {
        format!("http://localhost:{}/callback", self.redirect_port)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkSettings {
    /// Replace `https://app.box.com/s/<id>` with the custom proxy domain.
    pub rewrite: bool,
    pub template: String,
    pub copy_after_upload: bool,
    pub open_after_upload: bool,
}

impl Default for LinkSettings {
    fn default() -> Self {
        Self {
            rewrite: true,
            template: crate::links::DEFAULT_TEMPLATE.into(),
            copy_after_upload: true,
            open_after_upload: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EditorPrefs {
    pub color: String,
    /// Size preset: 0 – small, 1 – medium, 2 – large.
    pub size: u8,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self { color: "#FF3B30".into(), size: 1 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Draw the mouse cursor into screenshots. Off by default.
    pub show_cursor: bool,
    pub show_magnifier: bool,
    pub after_capture: AfterCapture,
    pub fullscreen_mode: FullscreenMode,
    pub autostart: bool,
    /// How many recent screenshots are kept in the temporary history.
    pub history_limit: u32,
    /// Folder for "Save" (empty = `Pictures\AdvantShoter`).
    pub save_folder: String,
    pub file_name_pattern: String,
    pub image_format: ImageFormat,
    pub jpeg_quality: u8,
    pub hotkeys: Hotkeys,
    #[serde(rename = "box")]
    pub box_: BoxSettings,
    pub links: LinkSettings,
    pub editor: EditorPrefs,
    pub last_region: Option<Rect>,
    /// Set after the welcome notification has been shown once.
    pub welcomed: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            show_cursor: false,
            show_magnifier: true,
            after_capture: AfterCapture::Ask,
            fullscreen_mode: FullscreenMode::CurrentMonitor,
            autostart: false,
            history_limit: 10,
            save_folder: String::new(),
            file_name_pattern: crate::filename::DEFAULT_PATTERN.into(),
            image_format: ImageFormat::Png,
            jpeg_quality: 90,
            hotkeys: Hotkeys::default(),
            box_: BoxSettings::default(),
            links: LinkSettings::default(),
            editor: EditorPrefs::default(),
            last_region: None,
            welcomed: false,
        }
    }
}

pub const MAX_HISTORY_LIMIT: u32 = 100;
pub const DEFAULT_BOX_FOLDER: &str = "AdvantShoter";

impl AppSettings {
    /// Clamps values coming from the UI or a hand-edited file.
    pub fn sanitized(mut self) -> Self {
        self.history_limit = self.history_limit.clamp(1, MAX_HISTORY_LIMIT);
        self.jpeg_quality = self.jpeg_quality.clamp(10, 100);
        self.editor.size = self.editor.size.min(2);
        self.box_.folder_id = self.box_.folder_id.trim().to_string();
        self.box_.redirect_uri = self.box_.redirect_uri.trim().to_string();
        self.box_.folder_name = if self.box_.folder_name.trim().is_empty() {
            DEFAULT_BOX_FOLDER.into()
        } else {
            crate::filename::sanitize(&self.box_.folder_name)
        };
        if !matches!(self.box_.shared_link_access.as_str(), "open" | "company" | "collaborators") {
            self.box_.shared_link_access = "open".into();
        }
        if self.box_.redirect_port < 1024 {
            self.box_.redirect_port = BoxSettings::default().redirect_port;
        }
        self.links.template = crate::links::normalize_template(&self.links.template);
        self
    }

    /// Loads settings, falling back to defaults when the file is missing or corrupt
    /// (a corrupt file is kept next to it as `.bak` for diagnostics).
    pub fn load(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
                Ok(s) => s.sanitized(),
                Err(err) => {
                    log::warn!("settings file is corrupt ({err}), using defaults");
                    let _ = std::fs::copy(path, path.with_extension("json.bak"));
                    AppSettings::default()
                }
            },
            Err(_) => AppSettings::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_atomic(path, &json)
    }
}

/// Writes a file via a temporary sibling + rename so a crash never leaves a half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", crate::random_string(4)));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_requirements() {
        let s = AppSettings::default();
        assert!(!s.show_cursor, "cursor must be hidden by default");
        assert_eq!(s.history_limit, 10);
        assert_eq!(s.links.template, "https://advant.one/{id}");
        assert!(s.links.rewrite);
        assert_eq!(s.box_.shared_link_access, "open");
        // No folder id needed: the "AdvantShoter" folder is created automatically.
        assert!(s.box_.folder_id.is_empty());
        assert_eq!(s.box_.folder_name, "AdvantShoter");
        assert!(s.box_.client_id.is_empty(), "built-in Box app by default");
    }

    #[test]
    fn roundtrip_and_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut s = AppSettings::default();
        s.show_cursor = true;
        s.box_.client_id = "abc".into();
        s.save(&path).unwrap();
        assert_eq!(AppSettings::load(&path), s);

        // Older/partial files get defaults for missing keys.
        std::fs::write(&path, br#"{"showCursor":true,"box":{"folderId":"42"}}"#).unwrap();
        let loaded = AppSettings::load(&path);
        assert!(loaded.show_cursor);
        assert_eq!(loaded.box_.folder_id, "42");
        assert_eq!(loaded.history_limit, 10);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(AppSettings::load(&path), AppSettings::default());
        assert!(dir.path().join("settings.json.bak").exists());
    }

    #[test]
    fn sanitizes_values() {
        let mut s = AppSettings::default();
        s.history_limit = 0;
        s.box_.shared_link_access = "public".into();
        s.links.template = "advant.one".into();
        s.box_.folder_name = "  ".into();
        let s = s.sanitized();
        assert_eq!(s.box_.folder_name, "AdvantShoter");
        assert_eq!(s.history_limit, 1);
        assert_eq!(s.box_.shared_link_access, "open");
        assert_eq!(s.links.template, "https://advant.one/{id}");
    }
}
