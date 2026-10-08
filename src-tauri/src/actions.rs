//! What happens with a screenshot: copy, save, upload to Box, open in the editor.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::Local;
use image::RgbaImage;
use serde::Serialize;
use shoter_core::history::HistoryItem;
use shoter_core::boxapi::{self, BoxError, BoxUser, UploadResult};
use shoter_core::oauth;
use shoter_core::settings::{BoxAuthMode, ImageFormat};
use shoter_core::{filename, imaging, links};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::clipboard;
use crate::state::{Action, AppState};
use crate::ui::{self, Toast};

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub share_url: Option<String>,
    pub saved_path: Option<String>,
}

pub fn notify_history(app: &AppHandle) {
    let _ = app.emit("history:changed", ());
}

const THUMB: (u32, u32) = (360, 220);

/// Stores a fresh capture in the history and performs the requested action.
pub async fn process_capture(app: &AppHandle, image: RgbaImage, source: &str, action: Action) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (w, h) = image.dimensions();
    let encoded = image.clone();
    let (png, thumb) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let png = imaging::encode_png(&encoded).map_err(|e| e.to_string())?;
        let thumb = imaging::encode_png(&imaging::thumbnail(&encoded, THUMB.0, THUMB.1)).map_err(|e| e.to_string())?;
        Ok((png, thumb))
    })
    .await
    .map_err(|e| e.to_string())??;
    let item = state.history.add(&png, &thumb, w, h, source).map_err(|e| e.to_string())?;
    notify_history(app);

    match action {
        Action::Edit => ui::open_editor(app, &item.id),
        Action::Copy => {
            clipboard::set_image(image).await?;
            ui::toast(app, Toast::success("Скопировано в буфер обмена").message(format!("{w} × {h}")).item(&item.id));
        }
        Action::Save => {
            save_item(app, &item.id, None).await?;
        }
        Action::SaveAs => {
            save_item_as(app, &item.id).await?;
        }
        Action::Upload => {
            upload_item(app, &item.id).await?;
        }
        Action::Store => {}
    }
    Ok(())
}

fn read_current(app: &AppHandle, id: &str) -> Result<(HistoryItem, Vec<u8>), String> {
    let state = app.state::<AppState>();
    let item = state.history.get(id).map_err(|e| e.to_string())?;
    let path = state.history.current_image_path(id).map_err(|e| e.to_string())?;
    let bytes = std::fs::read(path).map_err(|e| format!("не удалось прочитать снимок: {e}"))?;
    Ok((item, bytes))
}

/// Encodes the image in the configured format; PNG bytes are reused as-is.
fn encode_as(png: Vec<u8>, format: ImageFormat, quality: u8) -> Result<Vec<u8>, String> {
    match format {
        ImageFormat::Png => Ok(png),
        ImageFormat::Jpeg => {
            let img = imaging::decode(&png).map_err(|e| e.to_string())?;
            imaging::encode_jpeg(&img, quality).map_err(|e| e.to_string())
        }
    }
}

pub async fn copy_item(app: &AppHandle, id: &str) -> Result<(), String> {
    let (item, bytes) = read_current(app, id)?;
    let img = tauri::async_runtime::spawn_blocking(move || imaging::decode(&bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    clipboard::set_image(img).await?;
    ui::toast(app, Toast::success("Скопировано в буфер обмена").message(format!("{} × {}", item.width, item.height)).item(id));
    Ok(())
}

pub async fn copy_link(app: &AppHandle, id: &str) -> Result<(), String> {
    let item = app.state::<AppState>().history.get(id).map_err(|e| e.to_string())?;
    let link = item.share_url.ok_or("снимок ещё не загружен")?;
    clipboard::set_text(link.clone()).await?;
    ui::toast(app, Toast::success("Ссылка скопирована").link(link).item(id));
    Ok(())
}

async fn write_image(app: &AppHandle, id: &str, target: PathBuf, format: ImageFormat) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let quality = state.settings().jpeg_quality;
    let (_, png) = read_current(app, id)?;
    let data = tauri::async_runtime::spawn_blocking(move || encode_as(png, format, quality))
        .await
        .map_err(|e| e.to_string())??;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("не удалось создать папку {}: {e}", dir.display()))?;
    }
    std::fs::write(&target, data).map_err(|e| format!("не удалось сохранить {}: {e}", target.display()))?;
    let saved = target.to_string_lossy().to_string();
    let _ = state.history.modify(id, |i| i.saved_path = Some(saved.clone()));
    notify_history(app);
    ui::toast(app, Toast::success("Сохранено").message(file_label(&target)).path(saved).item(id));
    Ok(target)
}

fn file_label(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

/// "Save": the configured folder (default `Pictures\AdvantShoter`) with the file name pattern.
pub async fn save_item(app: &AppHandle, id: &str, dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let item = state.history.get(id).map_err(|e| e.to_string())?;
    let dir = dir.unwrap_or_else(|| state.save_dir());
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку {}: {e}", dir.display()))?;
    let name = filename::format(&settings.file_name_pattern, item.created_at, item.width, item.height);
    let target = filename::unique_path(&dir, &name, settings.image_format.extension());
    write_image(app, id, target, settings.image_format).await
}

/// "Save as…": native dialog; the format follows the chosen extension.
pub async fn save_item_as(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let item = state.history.get(id).map_err(|e| e.to_string())?;
    let name = filename::format(&settings.file_name_pattern, item.created_at, item.width, item.height);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Сохранить снимок")
        .set_directory(state.save_dir())
        .set_file_name(format!("{name}.{}", settings.image_format.extension()))
        .add_filter("PNG", &["png"])
        .add_filter("JPEG", &["jpg", "jpeg"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (format, path) = match ext.as_str() {
        "jpg" | "jpeg" => (ImageFormat::Jpeg, path),
        "png" => (ImageFormat::Png, path),
        _ => (ImageFormat::Png, path.with_extension("png")),
    };
    write_image(app, id, path, format).await.map(Some)
}

/// Uploads the current image of a history item to Box, creates the shared link,
/// rewrites it to the proxy domain and copies it to the clipboard.
pub async fn upload_item(app: &AppHandle, id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let (item, png) = read_current(app, id)?;
    ui::toast(app, Toast::progress("Загрузка в Box…").message(format!("{} × {}", item.width, item.height)).item(id));

    let format = settings.image_format;
    let quality = settings.jpeg_quality;
    let data = tauri::async_runtime::spawn_blocking(move || encode_as(png, format, quality))
        .await
        .map_err(|e| e.to_string())??;
    let name = format!(
        "{}.{}",
        filename::format(&settings.file_name_pattern, Local::now(), item.width, item.height),
        format.extension()
    );
    let mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
    };

    let mut result = upload_once(app, &name, data.clone(), mime).await;
    // Not signed in yet / token expired or revoked: open the Box sign-in page right away
    // and continue the upload after the user grants access — like Greenshot.
    if settings.box_.auth_mode == BoxAuthMode::OAuth && matches!(result, Err(BoxError::NotConfigured(_) | BoxError::Auth(_))) {
        result = match box_login(app).await {
            Ok(_) => {
                ui::toast(app, Toast::progress("Загрузка в Box…").message(format!("{} × {}", item.width, item.height)).item(id));
                upload_once(app, &name, data, mime).await
            }
            Err(e) => {
                ui::toast(app, Toast::error("Вход в Box не выполнен", e.clone()).item(id));
                return Err(e);
            }
        };
    }
    let result = result.map_err(|e| e.to_string());

    let uploaded = match result {
        Ok(r) => r,
        Err(e) => {
            ui::toast(app, Toast::error("Не удалось загрузить в Box", e.clone()).item(id));
            return Err(e);
        }
    };
    let box_url = uploaded.shared_link.url.clone();
    let share = if settings.links.rewrite {
        links::rewrite(&box_url, &settings.links.template, Some(&uploaded.file_name))
    } else {
        box_url.clone()
    };
    let _ = state.history.modify(id, |i| {
        i.box_file_id = Some(uploaded.file_id.clone());
        i.box_url = Some(box_url.clone());
        i.share_url = Some(share.clone());
        i.uploaded_revision = Some(i.revision);
    });
    notify_history(app);

    let mut copied = false;
    if settings.links.copy_after_upload {
        copied = clipboard::set_text(share.clone()).await.is_ok();
    }
    if settings.links.open_after_upload {
        let _ = app.opener().open_url(share.clone(), None::<&str>);
    }
    let restricted = uploaded
        .shared_link
        .effective_access
        .as_deref()
        .is_some_and(|a| a != "open" && settings.box_.shared_link_access == "open");
    let mut toast = Toast::success(if copied { "Ссылка скопирована" } else { "Загружено в Box" }).link(share.clone()).item(id).timeout(7000);
    if restricted {
        toast = toast.message("Администратор Box запретил публичные ссылки — без входа в Box (например, с телефона) ссылка может не открыться.");
        toast.kind = "info".into();
        toast.timeout_ms = 12000;
    }
    ui::toast(app, toast);
    Ok(share)
}

async fn upload_once(app: &AppHandle, name: &str, data: Vec<u8>, mime: &str) -> Result<UploadResult, BoxError> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let client = state.box_client(app).map_err(BoxError::NotConfigured)?;
    let folder = if settings.box_.folder_id.is_empty() {
        client.ensure_folder("0", &settings.box_.folder_name).await?
    } else {
        settings.box_.folder_id.clone()
    };
    client.upload_and_share(&folder, name, data, mime, &settings.box_.shared_link_access).await
}

/// "Sign in with Box": opens the Box authorization page in the browser and waits for
/// the redirect to the local port. Used by the button in the UI and automatically
/// before the first upload. Starting a new sign-in cancels a pending one.
pub async fn box_login(app: &AppHandle) -> Result<BoxUser, String> {
    let state = app.state::<AppState>();
    state.box_login_cancel.notify_waiters();
    let _guard = state.box_login.lock().await;

    let oauth_app = state.oauth_app().ok_or(
        "в этой сборке нет встроенного приложения Box — укажите Client ID и Client Secret в «Настройки → Box.com → Дополнительно»",
    )?;
    let endpoints = boxapi::Endpoints::default();
    let csrf = shoter_core::random_string(24);
    let authorize = boxapi::authorize_url(&endpoints, &oauth_app.client_id, &oauth_app.redirect_uri, &csrf);

    let code = if let Some(port) = oauth::loopback_port(&oauth_app.redirect_uri) {
        // Local redirect: sign in in the system browser (existing Box / SSO session).
        let path = url_path(&oauth_app.redirect_uri);
        let listener = oauth::bind(port).await.map_err(|e| e.to_string())?;
        app.opener().open_url(authorize, None::<&str>).map_err(|e| e.to_string())?;
        ui::toast(
            app,
            Toast::progress("Вход в Box").message("В браузере открылся сайт Box: войдите и нажмите «Предоставить доступ»."),
        );
        tokio::select! {
            r = oauth::wait_for_code(listener, &csrf, &path, Duration::from_secs(300)) => r.map_err(|e| e.to_string())?,
            _ = state.box_login_cancel.notified() => return Err("вход отменён".into()),
        }
    } else {
        // Any other redirect URI (e.g. the one of an existing Greenshot Box app):
        // Box opens in our own window and the redirect is intercepted there.
        tokio::select! {
            r = ui::box_login_window(app, &authorize, &oauth_app.redirect_uri, &csrf) => r?,
            _ = state.box_login_cancel.notified() => {
                ui::close_box_login_window(app);
                return Err("вход отменён".into());
            }
        }
    };
    let (client_id, client_secret, redirect_uri) = (oauth_app.client_id, oauth_app.client_secret, oauth_app.redirect_uri);
    let tokens = boxapi::exchange_code(&boxapi::http_client(), &endpoints, &client_id, &client_secret, &code, &redirect_uri)
        .await
        .map_err(|e| e.to_string())?;
    state.update_secrets(|s| s.box_oauth = Some(tokens))?;
    state.reset_box_client();
    let user = state.box_client(app)?.current_user().await.map_err(|e| e.to_string())?;
    state.update_secrets(|s| s.box_account = Some(user.clone()))?;
    let _ = app.emit("box:changed", ());
    let who = if user.name.is_empty() { user.login.clone() } else { format!("{} · {}", user.name, user.login) };
    ui::toast(app, Toast::success("Box подключён").message(who));
    Ok(user)
}

pub fn box_logout(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.box_login_cancel.notify_waiters();
    state.update_secrets(|s| {
        s.box_oauth = None;
        s.box_account = None;
    })?;
    state.reset_box_client();
    let _ = app.emit("box:changed", ());
    Ok(())
}

fn url_path(uri: &str) -> String {
    uri.split_once("://")
        .and_then(|(_, rest)| rest.find('/').map(|i| rest[i..].to_string()))
        .map(|p| p.split(['?', '#']).next().unwrap_or("/").to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "/".into())
}
