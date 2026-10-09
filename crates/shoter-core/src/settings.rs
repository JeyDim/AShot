//! Application settings persisted as JSON.
//!
//! Secrets (Box client secret, tokens) are NOT stored here – the application keeps
//! them separately, encrypted with Windows DPAPI.

use std::path::Path;

use serde::{Deserialize, Serialize};

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
pub enum Theme {
    /// Follow the Windows light/dark setting.
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    #[default]
    Png,
    Jpeg,
    /// Lossless WebP: same pixels as PNG, usually a smaller file.
    Webp,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Webp => "webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Webp => "image/webp",
        }
    }

    /// Format by file extension (`jpg`, `JPEG`, `webp`, …).
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(ImageFormat::Png),
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
            "webp" => Some(ImageFormat::Webp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hotkeys {
    pub region: String,
    pub window: String,
    pub fullscreen: String,
}

/// Every capture has a hotkey by default (like Greenshot: Alt — window, Shift — screen).
impl Default for Hotkeys {
    fn default() -> Self {
        Self {
            region: "Control+PrintScreen".into(),
            window: "Alt+PrintScreen".into(),
            fullscreen: "Shift+PrintScreen".into(),
        }
    }
}

impl Hotkeys {
    /// Gives empty hotkeys their defaults, unless the combination is already used.
    fn fill_defaults(&mut self) {
        let d = Hotkeys::default();
        for (value, default) in [(&mut self.region, d.region), (&mut self.window, d.window), (&mut self.fullscreen, d.fullscreen)] {
            if value.trim().is_empty() {
                *value = default;
            }
        }
        // Never two captures on one combination: the later one gives its default up.
        if self.window == self.region {
            self.window.clear();
        }
        if self.fullscreen == self.region || self.fullscreen == self.window {
            self.fullscreen.clear();
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
    /// Redirect URI registered for the Box app (advanced). Empty = detected at sign-in.
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
            redirect_uri: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkSettings {
    /// Replace `https://app.box.com/s/<id>` using the template.
    pub rewrite: bool,
    /// Empty = the build's default: the proxy domain or the Box embed link.
    pub template: String,
    pub copy_after_upload: bool,
    pub open_after_upload: bool,
}

impl Default for LinkSettings {
    fn default() -> Self {
        Self {
            rewrite: true,
            template: String::new(),
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

/// What the watermark in the editor is made of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkKind {
    #[default]
    Text,
    /// The picture chosen by the user (`watermark.png` in the config folder).
    Image,
}

/// How the watermark covers the picture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkLayout {
    /// Repeated over the whole picture in slanted rows.
    #[default]
    Tile,
    /// Once, at `position` (a copyright).
    Corner,
}

/// Where a single (corner) watermark goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum WatermarkPosition {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    #[default]
    BottomRight,
}

/// Watermark / copyright of the editor: one button puts it on the screenshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WatermarkSettings {
    pub kind: WatermarkKind,
    pub layout: WatermarkLayout,
    pub text: String,
    /// Text color.
    pub color: String,
    /// Size preset: 0 – small, 1 – medium, 2 – large.
    pub size: u8,
    /// Opacity, percent.
    pub opacity: u8,
    /// Tile: slope of the rows, degrees (0 – horizontal).
    pub angle: u8,
    /// Tile: gaps between the repeats, 0 – dense, 1 – medium, 2 – sparse.
    pub spacing: u8,
    /// Corner: where it goes.
    pub position: WatermarkPosition,
}

impl Default for WatermarkSettings {
    fn default() -> Self {
        Self {
            kind: WatermarkKind::Text,
            layout: WatermarkLayout::Tile,
            text: "© Advant".into(),
            color: "#FFFFFF".into(),
            size: 1,
            opacity: 25,
            angle: 30,
            spacing: 1,
            position: WatermarkPosition::BottomRight,
        }
    }
}

/// Which side of the picture the "downscale to" limit applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ResizeSide {
    #[default]
    Width,
    Height,
    Longest,
}

/// "Downscale to N px": every picture that leaves the app (copy, save, link) is made
/// smaller, keeping proportions; the history keeps the full size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResizeSettings {
    pub enabled: bool,
    pub side: ResizeSide,
    pub size: u32,
    /// Draw lines and text thicker so they look normal after downscaling (editor, overlay).
    pub thicken: bool,
}

impl Default for ResizeSettings {
    fn default() -> Self {
        Self { enabled: false, side: ResizeSide::Width, size: 740, thicken: true }
    }
}

pub const MIN_RESIZE: u32 = 16;
pub const MAX_RESIZE: u32 = 20_000;

impl ResizeSettings {
    /// Size of a `width × height` picture on output: never upscaled, proportions kept.
    pub fn output_size(&self, width: u32, height: u32) -> (u32, u32) {
        if !self.enabled || width == 0 || height == 0 {
            return (width, height);
        }
        let limited = match self.side {
            ResizeSide::Width => width,
            ResizeSide::Height => height,
            ResizeSide::Longest => width.max(height),
        };
        if limited <= self.size {
            return (width, height);
        }
        let k = self.size as f64 / limited as f64;
        let scale = |v: u32| ((v as f64 * k).round() as u32).max(1);
        (scale(width), scale(height))
    }
}

/// Version of the settings file written by this build (see [`AppSettings::migrate`]).
pub const SETTINGS_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    /// Settings file version; files written before versions existed read as 0.
    #[serde(default)]
    pub version: u32,
    /// Draw the mouse cursor into screenshots. Off by default.
    pub show_cursor: bool,
    pub show_magnifier: bool,
    pub after_capture: AfterCapture,
    pub fullscreen_mode: FullscreenMode,
    pub theme: Theme,
    /// Size of the app's own UI (panel, editor, settings, toolbars), percent.
    pub ui_scale: u32,
    pub autostart: bool,
    /// How many recent screenshots are kept in the temporary history.
    pub history_limit: u32,
    /// Folder for "Save" (empty = `Pictures\AShot`).
    pub save_folder: String,
    pub file_name_pattern: String,
    pub image_format: ImageFormat,
    pub jpeg_quality: u8,
    pub hotkeys: Hotkeys,
    #[serde(rename = "box")]
    pub box_: BoxSettings,
    pub links: LinkSettings,
    pub editor: EditorPrefs,
    pub resize: ResizeSettings,
    pub watermark: WatermarkSettings,
    /// Set after the welcome notification has been shown once.
    pub welcomed: bool,
    /// Install new versions from GitHub Releases automatically (when nothing is open).
    pub auto_update: bool,
    /// Version that ran last time ("updated to …" notification).
    pub last_version: String,
    /// Folder chosen in the last "Save as…" dialog (it opens there next time).
    pub last_save_as_dir: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            show_cursor: false,
            show_magnifier: true,
            after_capture: AfterCapture::Ask,
            fullscreen_mode: FullscreenMode::CurrentMonitor,
            theme: Theme::System,
            ui_scale: 100,
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
            resize: ResizeSettings::default(),
            watermark: WatermarkSettings::default(),
            welcomed: false,
            auto_update: true,
            last_version: String::new(),
            last_save_as_dir: String::new(),
        }
    }
}

pub const MAX_HISTORY_LIMIT: u32 = 100;
pub const MIN_UI_SCALE: u32 = 50;
pub const MAX_UI_SCALE: u32 = 200;
pub const DEFAULT_BOX_FOLDER: &str = "AShot";

impl AppSettings {
    /// Clamps values coming from the UI or a hand-edited file.
    pub fn sanitized(mut self) -> Self {
        self.history_limit = self.history_limit.clamp(1, MAX_HISTORY_LIMIT);
        self.jpeg_quality = self.jpeg_quality.clamp(10, 100);
        self.ui_scale = self.ui_scale.clamp(MIN_UI_SCALE, MAX_UI_SCALE);
        self.editor.size = self.editor.size.min(2);
        self.resize.size = self.resize.size.clamp(MIN_RESIZE, MAX_RESIZE);
        self.watermark.size = self.watermark.size.min(2);
        self.watermark.opacity = self.watermark.opacity.clamp(5, 100);
        self.watermark.angle = self.watermark.angle.min(90);
        self.watermark.spacing = self.watermark.spacing.min(2);
        self.watermark.text = self.watermark.text.chars().take(200).collect();
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
        self.links.template = crate::links::normalize_template(&self.links.template);
        self
    }

    /// One-time updates of files written by older versions.
    fn migrate(mut self) -> Self {
        if self.version < 2 {
            // Only the region capture used to have a hotkey; now every capture has one.
            self.hotkeys.fill_defaults();
        }
        self.version = SETTINGS_VERSION;
        self
    }

    /// Loads settings, falling back to defaults when the file is missing or corrupt
    /// (a corrupt file is kept next to it as `.bak` for diagnostics).
    pub fn load(path: &Path) -> Self {
        match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<AppSettings>(&bytes) {
                Ok(mut s) => {
                    // The old built-in default becomes "the build's default".
                    if s.links.template == crate::links::LEGACY_DEFAULT_TEMPLATE {
                        s.links.template.clear();
                    }
                    s.migrate().sanitized()
                }
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

/// Human-readable hotkey: "Control+Shift+KeyZ" → "Ctrl+Shift+Z" (same as the UI shows).
pub fn hotkey_label(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|key| match key {
            "PrintScreen" => "PrtSc".to_string(),
            "Control" | "CommandOrControl" | "CmdOrCtrl" | "Ctrl" => "Ctrl".to_string(),
            "Super" | "Meta" => "Win".to_string(),
            "Escape" => "Esc".to_string(),
            "Delete" => "Del".to_string(),
            k if k.len() == 4 && k.starts_with("Key") => k[3..].to_string(),
            k if k.len() == 6 && k.starts_with("Digit") => k[5..].to_string(),
            k => k.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_formats() {
        assert_eq!(ImageFormat::from_extension("JPEG"), Some(ImageFormat::Jpeg));
        assert_eq!(ImageFormat::from_extension("webp"), Some(ImageFormat::Webp));
        assert_eq!(ImageFormat::from_extension("gif"), None);
        assert_eq!(ImageFormat::Webp.extension(), "webp");
        assert_eq!(serde_json::to_string(&ImageFormat::Webp).unwrap(), "\"webp\"");
    }

    #[test]
    fn hotkey_labels() {
        assert_eq!(hotkey_label("Control+Shift+KeyZ"), "Ctrl+Shift+Z");
        assert_eq!(hotkey_label("PrintScreen"), "PrtSc");
        assert_eq!(hotkey_label("Alt+PrintScreen"), "Alt+PrtSc");
        assert_eq!(hotkey_label("Super+Digit5"), "Win+5");
        assert_eq!(hotkey_label("Control+F12"), "Ctrl+F12");
        assert_eq!(hotkey_label(""), "");
    }

    #[test]
    fn defaults_match_requirements() {
        let s = AppSettings::default();
        assert!(!s.show_cursor, "cursor must be hidden by default");
        assert_eq!(s.history_limit, 10);
        assert!(s.links.template.is_empty(), "link template comes from the build");
        assert!(s.auto_update);
        assert!(s.links.rewrite);
        assert_eq!(s.hotkeys.region, "Control+PrintScreen");
        assert_eq!(s.hotkeys.window, "Alt+PrintScreen");
        assert_eq!(s.hotkeys.fullscreen, "Shift+PrintScreen");
        assert_eq!(s.version, SETTINGS_VERSION);
        assert_eq!(s.box_.shared_link_access, "open");
        // No folder id needed: the "AShot" folder is created automatically.
        assert!(s.box_.folder_id.is_empty());
        assert_eq!(s.box_.folder_name, "AShot");
        assert!(s.box_.client_id.is_empty(), "built-in Box app by default");
        assert_eq!(s.theme, Theme::System);
        assert_eq!(s.ui_scale, 100);
        assert_eq!((s.watermark.kind, s.watermark.layout, s.watermark.opacity), (WatermarkKind::Text, WatermarkLayout::Tile, 25));
        assert_eq!(serde_json::to_value(WatermarkKind::Image).unwrap(), "image");
        assert_eq!(serde_json::to_value(WatermarkPosition::BottomRight).unwrap(), "bottomRight");
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
        assert_eq!(loaded.theme, Theme::System);

        std::fs::write(&path, br#"{"theme":"dark"}"#).unwrap();
        assert_eq!(AppSettings::load(&path).theme, Theme::Dark);

        // Keys of removed features ("repeat last region") are ignored, not an error.
        std::fs::write(&path, br#"{"showCursor":true,"lastRegion":{"x":1,"y":2,"width":3,"height":4},"hotkeys":{"region":"F9","lastRegion":"F10"}}"#).unwrap();
        let loaded = AppSettings::load(&path);
        assert!(loaded.show_cursor);
        assert_eq!(loaded.hotkeys.region, "F9");
        assert!(!dir.path().join("settings.json.bak").exists());
    }

    #[test]
    fn old_files_get_the_new_default_hotkeys_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Written before versions: only the region hotkey was set by default.
        std::fs::write(&path, br#"{"hotkeys":{"region":"Control+PrintScreen","window":"","fullscreen":""}}"#).unwrap();
        let s = AppSettings::load(&path);
        assert_eq!((s.hotkeys.window.as_str(), s.hotkeys.fullscreen.as_str()), ("Alt+PrintScreen", "Shift+PrintScreen"));
        assert_eq!(s.version, SETTINGS_VERSION);
        // A combination the user already gave to the region capture is not taken twice.
        std::fs::write(&path, br#"{"hotkeys":{"region":"Alt+PrintScreen","window":"","fullscreen":"F8"}}"#).unwrap();
        let s = AppSettings::load(&path);
        assert_eq!((s.hotkeys.region.as_str(), s.hotkeys.window.as_str(), s.hotkeys.fullscreen.as_str()), ("Alt+PrintScreen", "", "F8"));
        // After the migration a cleared hotkey stays cleared.
        let mut s = AppSettings::default();
        s.hotkeys.window.clear();
        s.save(&path).unwrap();
        assert!(AppSettings::load(&path).hotkeys.window.is_empty());
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
        s.ui_scale = 10;
        s.watermark.opacity = 0;
        s.watermark.size = 7;
        s.watermark.angle = 200;
        let s = s.sanitized();
        assert_eq!(s.ui_scale, MIN_UI_SCALE);
        assert_eq!((s.watermark.opacity, s.watermark.size, s.watermark.angle), (5, 2, 90));
        assert_eq!(s.box_.folder_name, "AShot");
        assert_eq!(s.history_limit, 1);
        assert_eq!(s.box_.shared_link_access, "open");
        assert_eq!(s.links.template, "https://advant.one/{id}");
    }

    #[test]
    fn resize_output_size() {
        let mut r = ResizeSettings::default();
        assert_eq!(r.output_size(1920, 1080), (1920, 1080), "off by default");
        r.enabled = true;
        assert_eq!(r.size, 740);
        assert_eq!(r.output_size(1920, 1080), (740, 416));
        assert_eq!(r.output_size(500, 900), (500, 900), "never upscales");
        r.side = ResizeSide::Height;
        assert_eq!(r.output_size(500, 900), (411, 740));
        assert_eq!(r.output_size(1920, 700), (1920, 700));
        r.side = ResizeSide::Longest;
        assert_eq!(r.output_size(1080, 1920), (416, 740));
        assert_eq!(r.output_size(3000, 2), (740, 1), "at least one pixel");
        let s = AppSettings { resize: ResizeSettings { size: 0, ..r }, ..AppSettings::default() }.sanitized();
        assert_eq!(s.resize.size, MIN_RESIZE);
    }

    #[test]
    fn legacy_link_template_becomes_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, br#"{"links":{"rewrite":true,"template":"https://advant.one/{id}"}}"#).unwrap();
        assert_eq!(AppSettings::load(&path).links.template, "");
        std::fs::write(&path, br#"{"links":{"template":"https://i.example.com/{id}"}}"#).unwrap();
        assert_eq!(AppSettings::load(&path).links.template, "https://i.example.com/{id}");
    }
}
