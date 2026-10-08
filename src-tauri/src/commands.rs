//! Commands invoked from the web UI.
//!
//! Commands that may create windows are `async`: on Windows a synchronous command runs
//! inside a WebView2 callback, and creating a web view there would deadlock.


use serde::Serialize;
use shoter_core::boxapi::BoxUser;
use shoter_core::history::HistoryItem;
use shoter_core::settings::{AppSettings, BoxAuthMode};
use shoter_core::{imaging, links, Rect};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::actions::{self, ActionResult};
use crate::state::{Action, AppState, CaptureMode};
use crate::ui::{self, Toast};
use crate::{flow, hotkeys, overlay};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- app info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    build_date: String,
    commit: String,
    tauri_version: String,
    os: String,
    config_dir: String,
    data_dir: String,
    log_dir: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let state = app.state::<AppState>();
    let pkg = app.package_info();
    AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        build_date: env!("SHOTER_BUILD_DATE").into(),
        commit: env!("SHOTER_COMMIT").into(),
        tauri_version: tauri::VERSION.into(),
        os: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        config_dir: state.paths.config_dir.display().to_string(),
        data_dir: state.paths.data_dir.display().to_string(),
        log_dir: state.paths.log_dir.display().to_string(),
    }
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: AppSettings,
    default_save_folder: String,
    history_folder: String,
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> SettingsView {
    let state = app.state::<AppState>();
    SettingsView {
        settings: state.settings(),
        default_save_folder: state.paths.default_save_dir.display().to_string(),
        history_folder: state.paths.history_dir.display().to_string(),
    }
}

/// Saves the whole settings object. Returns hotkey registration problems (if any).
#[tauri::command]
pub async fn settings_set(app: AppHandle, settings: AppSettings) -> CmdResult<Vec<String>> {
    let state = app.state::<AppState>();
    let before = state.settings();
    let after = state.update_settings(|s| {
        // Keep values that are not edited in the settings window.
        let last_region = s.last_region;
        let welcomed = s.welcomed;
        *s = settings;
        s.last_region = last_region;
        s.welcomed = welcomed;
    });
    let mut problems = Vec::new();
    if before.hotkeys != after.hotkeys {
        // Register on the main thread (the plugin would otherwise block this thread on it).
        let (tx, rx) = tokio::sync::oneshot::channel();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(hotkeys::apply(&handle));
        })
        .map_err(err)?;
        problems = rx.await.unwrap_or_default();
    }
    if before.history_limit != after.history_limit {
        state.history.set_limit(after.history_limit as usize).map_err(err)?;
        actions::notify_history(&app);
    }
    if before.autostart != after.autostart {
        let launcher = app.autolaunch();
        let r = if after.autostart { launcher.enable() } else { launcher.disable() };
        if let Err(e) = r {
            problems.push(format!("Автозапуск: {e}"));
        }
    }
    if before.box_ != after.box_ {
        if before.box_.client_id.trim() != after.box_.client_id.trim() {
            // Tokens belong to the previous Box app – sign in again.
            state.update_secrets(|s| {
                s.box_oauth = None;
                s.box_account = None;
            })?;
        }
        state.reset_box_client();
        let _ = app.emit("box:changed", ());
    }
    let _ = app.emit("settings:changed", &after);
    Ok(problems)
}

/// Quick toggles from the tray panel (e.g. "show cursor").
#[tauri::command]
pub fn settings_patch(app: AppHandle, patch: serde_json::Value) -> CmdResult<AppSettings> {
    let state = app.state::<AppState>();
    let mut value = serde_json::to_value(state.settings()).map_err(err)?;
    merge(&mut value, patch);
    let merged: AppSettings = serde_json::from_value(value).map_err(err)?;
    let after = state.update_settings(|s| *s = merged);
    let _ = app.emit("settings:changed", &after);
    Ok(after)
}

fn merge(target: &mut serde_json::Value, patch: serde_json::Value) {
    match (target, patch) {
        (serde_json::Value::Object(t), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                merge(t.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (t, p) => *t = p,
    }
}

#[tauri::command]
pub fn hotkeys_suspend(app: AppHandle, suspended: bool) -> Vec<String> {
    if suspended {
        hotkeys::suspend(&app);
        Vec::new()
    } else {
        hotkeys::apply(&app)
    }
}

// ---------------------------------------------------------------- capture & overlay

#[tauri::command]
pub fn capture(app: AppHandle, mode: CaptureMode) {
    flow::start(&app, mode);
}

#[tauri::command]
pub fn overlay_pending(window: WebviewWindow) -> Option<serde_json::Value> {
    overlay::pending(window.app_handle(), window.label())
}

#[tauri::command]
pub fn overlay_ready(window: WebviewWindow, session_id: u64) {
    overlay::ready(window.app_handle(), window.label(), session_id);
}

#[tauri::command]
pub async fn overlay_finish(app: AppHandle, rect: Rect, action: Action) -> CmdResult<()> {
    if rect.is_empty() {
        return Err("пустая область".into());
    }
    if let Err(e) = flow::complete(&app, rect, action).await {
        ui::toast(&app, Toast::error("Не удалось обработать снимок", e.clone()));
        return Err(e);
    }
    Ok(())
}

/// Finish with drawings. Body: `u32 LE` JSON length, editor document JSON (relative to
/// the selection), rendered PNG. Headers: `x-rect` = "x,y,w,h" (virtual screen), `x-action`.
#[tauri::command]
pub async fn overlay_finish_annotated(app: AppHandle, request: Request<'_>) -> CmdResult<()> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let rect_text = header("x-rect").ok_or("missing x-rect")?;
    let parts: Vec<i64> = rect_text.split(',').filter_map(|p| p.trim().parse().ok()).collect();
    let [x, y, w, h] = parts[..] else { return Err("bad x-rect".into()) };
    if w <= 0 || h <= 0 {
        return Err("пустая область".into());
    }
    let rect = Rect::new(x as i32, y as i32, w as u32, h as u32);
    let action: Action = serde_json::from_value(serde_json::Value::String(header("x-action").unwrap_or_else(|| "edit".into())))
        .map_err(err)?;
    let InvokeBody::Raw(body) = request.body() else { return Err("expected binary body".into()) };
    if body.len() < 4 {
        return Err("bad body".into());
    }
    let json_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + json_len {
        return Err("bad body".into());
    }
    let doc_json = std::str::from_utf8(&body[4..4 + json_len]).map_err(err)?.to_string();
    let png = body[4 + json_len..].to_vec();
    let annotated = actions::Annotated { png, doc_json };
    if let Err(e) = flow::complete_with(&app, rect, action, Some(annotated)).await {
        ui::toast(&app, Toast::error("Не удалось обработать снимок", e.clone()));
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_cancel(app: AppHandle) {
    flow::cancel(&app);
}

/// UI elements under a point (virtual-screen coordinates): deepest first, window last.
#[tauri::command]
pub async fn overlay_hit_test(app: AppHandle, x: i32, y: i32) -> Vec<Rect> {
    #[cfg(windows)]
    {
        app.state::<AppState>().ui_selector.query(x, y).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, x, y);
        Vec::new()
    }
}

// ---------------------------------------------------------------- history

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryView {
    #[serde(flatten)]
    item: HistoryItem,
    /// `advant.one/xxxx` for display.
    short_link: Option<String>,
    /// The image changed after the upload – the link shows an older version.
    link_outdated: bool,
}

impl From<HistoryItem> for HistoryView {
    fn from(item: HistoryItem) -> Self {
        let short_link = item.share_url.as_deref().map(links::display);
        let link_outdated = item.share_url.is_some() && item.uploaded_revision != Some(item.revision);
        Self { item, short_link, link_outdated }
    }
}

#[tauri::command]
pub fn history_list(app: AppHandle) -> Vec<HistoryView> {
    app.state::<AppState>().history.list().into_iter().map(Into::into).collect()
}

#[tauri::command]
pub fn history_get(app: AppHandle, id: String) -> CmdResult<HistoryView> {
    app.state::<AppState>().history.get(&id).map(Into::into).map_err(err)
}

#[tauri::command]
pub fn history_annotations(app: AppHandle, id: String) -> CmdResult<Option<String>> {
    app.state::<AppState>().history.annotations(&id).map_err(err)
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> CmdResult<()> {
    app.state::<AppState>().history.delete(&id).map_err(err)?;
    if let Some(w) = app.get_webview_window(&ui::editor_label(&id)) {
        let _ = w.close();
    }
    actions::notify_history(&app);
    Ok(())
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> CmdResult<()> {
    app.state::<AppState>().history.clear().map_err(err)?;
    actions::notify_history(&app);
    Ok(())
}

#[tauri::command]
pub async fn history_open(app: AppHandle, id: String) {
    ui::open_editor(&app, &id);
}

#[tauri::command]
pub async fn history_copy(app: AppHandle, id: String) -> CmdResult<()> {
    actions::copy_item(&app, &id).await
}

#[tauri::command]
pub async fn history_copy_link(app: AppHandle, id: String) -> CmdResult<()> {
    actions::copy_link(&app, &id).await
}

#[tauri::command]
pub async fn history_save(app: AppHandle, id: String) -> CmdResult<String> {
    actions::save_item(&app, &id, None).await.map(|p| p.display().to_string())
}

#[tauri::command]
pub async fn history_save_as(app: AppHandle, id: String) -> CmdResult<Option<String>> {
    actions::save_item_as(&app, &id).await.map(|p| p.map(|p| p.display().to_string()))
}

#[tauri::command]
pub async fn history_upload(app: AppHandle, id: String) -> CmdResult<String> {
    actions::upload_item(&app, &id).await
}

// ---------------------------------------------------------------- editor

/// Body: `u32 LE` length of the annotations JSON, the JSON, then the PNG bytes.
/// Headers: `x-id` (history id), `x-action` (store|copy|save|saveAs|upload).
#[tauri::command]
pub async fn editor_commit(app: AppHandle, request: Request<'_>) -> CmdResult<ActionResult> {
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).ok_or("missing x-id")?.to_string();
    let action = request.headers().get("x-action").and_then(|v| v.to_str().ok()).unwrap_or("store").to_string();
    let InvokeBody::Raw(body) = request.body() else { return Err("expected binary body".into()) };
    if body.len() < 4 {
        return Err("bad body".into());
    }
    let json_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    if body.len() < 4 + json_len {
        return Err("bad body".into());
    }
    let annotations = std::str::from_utf8(&body[4..4 + json_len]).map_err(err)?.to_string();
    let png = body[4 + json_len..].to_vec();

    let decoded = {
        let png = png.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
            let img = imaging::decode(&png).map_err(err)?;
            let thumb = imaging::encode_png(&imaging::thumbnail(&img, 360, 220)).map_err(err)?;
            Ok((img, thumb))
        })
        .await
        .map_err(err)??
    };
    let (img, thumb) = decoded;
    let state = app.state::<AppState>();
    let annotations = (!annotations.trim().is_empty()).then_some(annotations);
    state
        .history
        .update_image(&id, &png, &thumb, img.width(), img.height(), annotations.as_deref())
        .map_err(err)?;
    actions::notify_history(&app);

    let mut result = ActionResult::default();
    match action.as_str() {
        "copy" => {
            crate::clipboard::set_image(img).await?;
            ui::toast(&app, Toast::success("Скопировано в буфер обмена").item(&id));
        }
        "save" => result.saved_path = Some(actions::save_item(&app, &id, None).await?.display().to_string()),
        "saveAs" => result.saved_path = actions::save_item_as(&app, &id).await?.map(|p| p.display().to_string()),
        "upload" => result.share_url = Some(actions::upload_item(&app, &id).await?),
        _ => {}
    }
    Ok(result)
}

// ---------------------------------------------------------------- windows & misc

#[tauri::command]
pub async fn open_settings(app: AppHandle, section: Option<String>) {
    ui::open_settings(&app, section.as_deref());
}

#[tauri::command]
pub async fn open_about(app: AppHandle) {
    ui::open_about(&app);
}

#[tauri::command]
pub fn panel_hide(app: AppHandle) {
    ui::hide_panel(&app);
}

#[tauri::command]
pub fn toast_current(app: AppHandle) -> Option<ui::Toast> {
    ui::current_toast(&app)
}

#[tauri::command]
pub fn toast_hide(app: AppHandle) {
    let _ = ui::hide_toast(&app);
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub async fn copy_text(text: String) -> CmdResult<()> {
    crate::clipboard::set_text(text).await
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> CmdResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("unsupported url".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

/// Opens Explorer with the file selected (or the folder itself).
#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> CmdResult<()> {
    let p = std::path::PathBuf::from(&path);
    if p.is_file() {
        app.opener().reveal_item_in_dir(p).map_err(err)
    } else {
        std::fs::create_dir_all(&p).map_err(err)?;
        app.opener().open_path(path, None::<&str>).map_err(err)
    }
}

#[tauri::command]
pub fn open_folder(app: AppHandle, which: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let dir = match which.as_str() {
        "save" => state.save_dir(),
        "history" => state.paths.history_dir.clone(),
        "logs" => state.paths.log_dir.clone(),
        "config" => state.paths.config_dir.clone(),
        _ => return Err("unknown folder".into()),
    };
    std::fs::create_dir_all(&dir).map_err(err)?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(err)
}

// ---------------------------------------------------------------- Box

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxStatus {
    mode: BoxAuthMode,
    /// Uploads can work right now (signed in / credentials present).
    ready: bool,
    signed_in: bool,
    account: Option<BoxUser>,
    /// This build has a Box app built in (no Client ID / Secret needed).
    builtin_app: bool,
    /// An own Box app is configured in the advanced settings.
    custom_app: bool,
    has_client_secret: bool,
    has_developer_token: bool,
    redirect_uri: String,
}

#[tauri::command]
pub fn box_status(app: AppHandle) -> BoxStatus {
    let state = app.state::<AppState>();
    let settings = state.settings();
    // oauth_app() locks the secrets itself – call it before taking the lock below.
    let oauth_app = state.oauth_app();
    let oauth_ready = oauth_app.is_some();
    let secrets = state.secrets.lock().unwrap();
    // Redirect URI Box accepted at the last sign-in, else the configured one ("" = detect).
    let learned = secrets.box_redirect.as_ref().filter(|l| oauth_app.as_ref().is_some_and(|a| a.client_id == l.client_id));
    let redirect_uri = match learned {
        Some(l) => l.redirect_uri.clone(),
        None => oauth_app.and_then(|a| a.redirect_uri),
    }
    .unwrap_or_default();
    let signed_in = secrets.box_oauth.as_ref().is_some_and(|t| !t.refresh_token.is_empty());
    let b = &settings.box_;
    let ready = match b.auth_mode {
        BoxAuthMode::OAuth => signed_in && oauth_ready,
        BoxAuthMode::ClientCredentials => {
            !b.client_id.is_empty() && !secrets.box_client_secret.is_empty() && !(b.enterprise_id.is_empty() && b.user_id.is_empty())
        }
        BoxAuthMode::DeveloperToken => !secrets.box_developer_token.is_empty(),
    };
    BoxStatus {
        mode: b.auth_mode,
        ready,
        signed_in,
        account: secrets.box_account.clone(),
        builtin_app: crate::state::builtin_box_app().is_some(),
        custom_app: !b.client_id.trim().is_empty(),
        has_client_secret: !secrets.box_client_secret.is_empty(),
        has_developer_token: !secrets.box_developer_token.is_empty(),
        redirect_uri,
    }
}

/// Stores a secret: `clientSecret` or `developerToken`. Empty value clears it.
#[tauri::command]
pub fn box_set_secret(app: AppHandle, kind: String, value: String) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let value = value.trim().to_string();
    state.update_secrets(|s| match kind.as_str() {
        "clientSecret" => s.box_client_secret = value,
        "developerToken" => s.box_developer_token = value,
        _ => {}
    })?;
    state.reset_box_client();
    let _ = app.emit("box:changed", ());
    Ok(())
}

#[tauri::command]
pub async fn box_test(app: AppHandle) -> CmdResult<BoxUser> {
    let state = app.state::<AppState>();
    state.reset_box_client();
    let client = state.box_client(&app)?;
    client.current_user().await.map_err(err)
}

/// "Sign in with Box": opens the Box site; the user signs in and grants access.
#[tauri::command]
pub async fn box_login(app: AppHandle) -> CmdResult<BoxUser> {
    let user = actions::box_login(&app).await.inspect_err(|e| {
        if e != "вход отменён" {
            ui::toast(&app, Toast::error("Вход в Box не выполнен", e.clone()));
        }
    })?;
    // Bring the settings window back after the browser.
    if let Some(w) = app.get_webview_window(ui::SETTINGS) {
        let _ = w.set_focus();
    }
    Ok(user)
}

#[tauri::command]
pub fn box_logout(app: AppHandle) -> CmdResult<()> {
    actions::box_logout(&app)
}

/// Preview of the link rewriting for the settings page.
#[tauri::command]
pub fn link_preview(template: String) -> String {
    links::rewrite("https://app.box.com/s/3rud4dfakga5r953wt77anhyzo27tm7r", &template, Some("Screenshot.png"))
}
