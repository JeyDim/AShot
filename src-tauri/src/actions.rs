//! What happens with a screenshot: copy, save, upload to Box, open in the editor.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use image::RgbaImage;
use serde::Serialize;
use shoter_core::history::HistoryItem;
use shoter_core::boxapi::{self, BoxError, BoxUser, UploadResult};
use shoter_core::oauth;
use shoter_core::settings::{BoxAuthMode, ImageFormat, ResizeSettings};
use shoter_core::{filename, imaging, links};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::clipboard;
use crate::secrets::LearnedRedirect;
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
/// Drawings made on the capture overlay: the rendered PNG and the editor document.
pub struct Annotated {
    pub png: Vec<u8>,
    pub doc_json: String,
}

/// Stores a fresh capture in the history and performs the requested action.
/// With `annotated`, the original stays re-editable and the rendered image is used.
/// `save_to`: the file already chosen in the "Save as…" dialog (the overlay asks first).
pub async fn process_capture(
    app: &AppHandle,
    image: RgbaImage,
    source: &str,
    action: Action,
    annotated: Option<Annotated>,
    save_to: Option<PathBuf>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (w, h) = image.dimensions();
    let original = image.clone();
    let rendered_png = annotated.as_ref().map(|a| a.png.clone());
    let (png, thumb, final_image) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let png = imaging::encode_png(&original).map_err(|e| e.to_string())?;
        let final_image = match rendered_png {
            Some(bytes) => imaging::decode(&bytes).map_err(|e| e.to_string())?,
            None => original,
        };
        let thumb = imaging::encode_png(&imaging::thumbnail(&final_image, THUMB.0, THUMB.1)).map_err(|e| e.to_string())?;
        Ok((png, thumb, final_image))
    })
    .await
    .map_err(|e| e.to_string())??;
    let item = state.history.add(&png, &thumb, w, h, source).map_err(|e| e.to_string())?;
    if let Some(a) = &annotated {
        state
            .history
            .update_image(&item.id, &a.png, &thumb, final_image.width(), final_image.height(), Some(&a.doc_json))
            .map_err(|e| e.to_string())?;
    }
    notify_history(app);

    match action {
        Action::Edit => ui::open_editor(app, &item.id),
        Action::Copy => {
            let out = output_image(app, final_image).await?;
            let (fw, fh) = out.dimensions();
            clipboard::set_image(out).await?;
            ui::toast(app, Toast::success("Скопировано в буфер обмена").message(format!("{fw} × {fh}")).item(&item.id));
        }
        Action::Save => {
            save_item(app, &item.id, None).await?;
        }
        Action::SaveAs => match save_to {
            Some(path) => {
                save_item_to(app, &item.id, path).await?;
            }
            None => {
                save_item_as(app, &item.id).await?;
            }
        },
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

/// "Downscale to N px" (when on) for a picture that leaves the app.
fn downscaled(img: RgbaImage, resize: &ResizeSettings) -> RgbaImage {
    let (w, h) = img.dimensions();
    let (tw, th) = resize.output_size(w, h);
    if (tw, th) == (w, h) { img } else { imaging::resize(&img, tw, th) }
}

/// The picture as it is copied: downscaled when "Downscale to" is on.
async fn output_image(app: &AppHandle, img: RgbaImage) -> Result<RgbaImage, String> {
    let resize = app.state::<AppState>().settings().resize;
    tauri::async_runtime::spawn_blocking(move || downscaled(img, &resize)).await.map_err(|e| e.to_string())
}

/// Size of a history picture on output (copy, save, link).
fn output_size(app: &AppHandle, width: u32, height: u32) -> (u32, u32) {
    app.state::<AppState>().settings().resize.output_size(width, height)
}

/// Encodes the image in the configured format, downscaled when "Downscale to" is on;
/// PNG bytes of the original size are reused as-is.
fn encode_as(png: Vec<u8>, format: ImageFormat, quality: u8, resize: &ResizeSettings) -> Result<Vec<u8>, String> {
    if format == ImageFormat::Png && !resize.enabled {
        return Ok(png);
    }
    let img = imaging::decode(&png).map_err(|e| e.to_string())?;
    let original = img.dimensions();
    let img = downscaled(img, resize);
    match format {
        ImageFormat::Png if img.dimensions() == original => Ok(png),
        ImageFormat::Png => imaging::encode_png(&img),
        ImageFormat::Jpeg => imaging::encode_jpeg(&img, quality),
        ImageFormat::Webp => imaging::encode_webp(&img),
    }
    .map_err(|e| e.to_string())
}

pub async fn copy_item(app: &AppHandle, id: &str) -> Result<(), String> {
    let (_, bytes) = read_current(app, id)?;
    let img = tauri::async_runtime::spawn_blocking(move || imaging::decode(&bytes).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    let img = output_image(app, img).await?;
    let (w, h) = img.dimensions();
    clipboard::set_image(img).await?;
    ui::toast(app, Toast::success("Скопировано в буфер обмена").message(format!("{w} × {h}")).item(id));
    Ok(())
}

pub async fn copy_link(app: &AppHandle, id: &str) -> Result<(), String> {
    let item = app.state::<AppState>().history.get(id).map_err(|e| e.to_string())?;
    let link = item.share_url.ok_or("снимок ещё не загружен")?;
    clipboard::set_text(link.clone()).await?;
    ui::toast(app, Toast::success("Ссылка скопирована").link(link).item(id));
    Ok(())
}

/// The current image of a history item in the given format (and output size).
async fn encode_current(app: &AppHandle, id: &str, format: ImageFormat) -> Result<Vec<u8>, String> {
    let settings = app.state::<AppState>().settings();
    let (quality, resize) = (settings.jpeg_quality, settings.resize);
    let (_, png) = read_current(app, id)?;
    tauri::async_runtime::spawn_blocking(move || encode_as(png, format, quality, &resize))
        .await
        .map_err(|e| e.to_string())?
}

fn write_file(target: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("не удалось создать папку {}: {e}", dir.display()))?;
    }
    std::fs::write(target, data).map_err(|e| format!("не удалось сохранить {}: {e}", target.display()))
}

fn mark_saved(app: &AppHandle, id: &str, path: &Path) -> String {
    let saved = path.to_string_lossy().to_string();
    let _ = app.state::<AppState>().history.modify(id, |i| i.saved_path = Some(saved.clone()));
    notify_history(app);
    saved
}

async fn write_image(app: &AppHandle, id: &str, target: PathBuf, format: ImageFormat) -> Result<PathBuf, String> {
    write_file(&target, &encode_current(app, id, format).await?)?;
    let saved = mark_saved(app, id, &target);
    ui::toast(app, Toast::success("Сохранено").message(file_label(&target)).path(saved).item(id));
    Ok(target)
}

fn file_label(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

/// "Save": the configured folder (default `Pictures\AShot`) with the file name pattern.
pub async fn save_item(app: &AppHandle, id: &str, dir: Option<PathBuf>) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let item = state.history.get(id).map_err(|e| e.to_string())?;
    let dir = dir.unwrap_or_else(|| state.save_dir());
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку {}: {e}", dir.display()))?;
    let (w, h) = settings.resize.output_size(item.width, item.height);
    let name = filename::format(&settings.file_name_pattern, item.created_at, w, h);
    let target = filename::numbered_path(&dir, &name, settings.image_format.extension());
    write_image(app, id, target, settings.image_format).await
}

/// "Save as…" (also "Save" in the overlay and the editor): any folder and name in the
/// system dialog, the format follows the extension. A copy with the same name also goes
/// to the screenshots folder, unless the file was saved right there.
pub async fn save_item_as(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
    let item = app.state::<AppState>().history.get(id).map_err(|e| e.to_string())?;
    let Some(path) = pick_save_path(app, item.created_at, item.width, item.height, None).await? else {
        return Ok(None);
    };
    save_item_to(app, id, path).await.map(Some)
}

/// The "Save as…" dialog, opened in the last chosen folder with a name from the pattern
/// (`width × height` — the picture before "Downscale to"). `parent` keeps it above that
/// window (the capture overlay is always on top). `None` — cancelled.
pub async fn pick_save_path(
    app: &AppHandle,
    created_at: DateTime<Local>,
    width: u32,
    height: u32,
    parent: Option<&WebviewWindow>,
) -> Result<Option<PathBuf>, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let save_dir = state.save_dir();
    let start_dir = Some(PathBuf::from(&settings.last_save_as_dir)).filter(|d| d.is_dir()).unwrap_or(save_dir);
    let (width, height) = output_size(app, width, height);
    let name = filename::format(&settings.file_name_pattern, created_at, width, height);
    let format = settings.image_format;
    let suggested = filename::numbered_path(&start_dir, &name, format.extension());
    let file_name = suggested.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
    // The configured format comes first: the dialog starts with its filter.
    let mut filters = vec![(ImageFormat::Png, "PNG", &["png"][..]), (ImageFormat::Jpeg, "JPEG", &["jpg", "jpeg"][..]), (ImageFormat::Webp, "WebP", &["webp"][..])];
    filters.sort_by_key(|(f, _, _)| *f != format);
    let mut dialog = app.dialog().file().set_title("Сохранить снимок").set_directory(&start_dir).set_file_name(file_name);
    if let Some(window) = parent {
        dialog = dialog.set_parent(window);
    }
    for (_, label, exts) in filters {
        dialog = dialog.add_filter(label, exts);
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx.await.ok().flatten() else { return Ok(None) };
    path.into_path().map(Some).map_err(|e| e.to_string())
}

/// Writes the current image of a history item to a file chosen in the "Save as…" dialog.
pub async fn save_item_to(app: &AppHandle, id: &str, path: PathBuf) -> Result<PathBuf, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let save_dir = state.save_dir();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (format, path) = match ImageFormat::from_extension(&ext) {
        Some(format) => (format, path),
        None => (settings.image_format, path.with_extension(settings.image_format.extension())),
    };

    let data = encode_current(app, id, format).await?;
    write_file(&path, &data)?;
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    state.update_settings(|s| s.last_save_as_dir = dir.display().to_string());
    let mut message = file_label(&path);
    if !same_dir(&dir, &save_dir) {
        let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Screenshot".into());
        let copy = filename::numbered_path(&save_dir, &stem, format.extension());
        match write_file(&copy, &data) {
            Ok(()) => message.push_str(" · копия — в папке снимков"),
            Err(e) => log::warn!("copy to the screenshots folder failed: {e}"),
        }
    }
    let saved = mark_saved(app, id, &path);
    ui::toast(app, Toast::success("Сохранено").message(message).path(saved).item(id));
    Ok(path)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Uploads the current image of a history item to Box, creates the shared link,
/// rewrites it to the proxy domain and copies it to the clipboard.
pub async fn upload_item(app: &AppHandle, id: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let (item, png) = read_current(app, id)?;
    let (out_w, out_h) = settings.resize.output_size(item.width, item.height);
    let progress = || {
        let hint = if settings.links.copy_after_upload {
            "Ссылка скопируется автоматически".to_string()
        } else {
            format!("{out_w} × {out_h}")
        };
        Toast::progress("Загрузка в Box…").message(hint).item(id)
    };
    ui::toast(app, progress());

    let format = settings.image_format;
    let quality = settings.jpeg_quality;
    let resize = settings.resize;
    let data = tauri::async_runtime::spawn_blocking(move || encode_as(png, format, quality, &resize))
        .await
        .map_err(|e| e.to_string())??;
    let name = format!(
        "{}.{}",
        filename::first_number(&filename::format(&settings.file_name_pattern, Local::now(), out_w, out_h)),
        format.extension()
    );
    let mime = format.mime();

    let mut result = upload_once(app, &name, data.clone(), mime).await;
    // Not signed in yet / token expired or revoked: open the Box sign-in page right away
    // and continue the upload after the user grants access — like Greenshot.
    if settings.box_.auth_mode == BoxAuthMode::OAuth && matches!(result, Err(BoxError::NotConfigured(_) | BoxError::Auth(_))) {
        result = match box_login(app).await {
            Ok(_) => {
                ui::toast(app, progress());
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
            ui::toast(app, Toast::error("Не удалось загрузить в Box", e.clone()).item(id).retry_upload());
            return Err(e);
        }
    };
    let box_url = uploaded.shared_link.url.clone();
    let share = if settings.links.rewrite {
        links::rewrite(&box_url, &crate::state::link_template(&settings.links), Some(&uploaded.file_name))
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

/// Signs in to Box: the Box page opens in an app window, the user grants access and the
/// redirect back is intercepted there. Used by the button in the UI and automatically
/// before the first upload. Starting a new sign-in cancels a pending one.
pub async fn box_login(app: &AppHandle) -> Result<BoxUser, String> {
    let state = app.state::<AppState>();
    state.box_login_cancel.notify_waiters();
    let _guard = state.box_login.lock().await;

    let oauth_app = state.oauth_app().ok_or(
        "в этой сборке нет встроенного приложения Box — укажите Client ID и Client Secret в «Настройки → Box.com → Дополнительно»",
    )?;
    // A wrong redirect URI fails with redirect_uri_mismatch, and the one registered for the
    // Box app is not always known: try the one that worked last time, the configured one,
    // none at all (Box then uses the app's own), then the usual ones.
    let learned = state.secrets.lock().unwrap().box_redirect.clone().filter(|l| l.client_id == oauth_app.client_id);
    let mut preferred = Vec::new();
    if let Some(l) = &learned {
        preferred.push(l.redirect_uri.as_deref());
    }
    if let Some(r) = &oauth_app.redirect_uri {
        preferred.push(Some(r.as_str()));
    }
    let candidates = oauth::redirect_candidates(preferred);
    let endpoints = boxapi::Endpoints::default();
    let csrf = shoter_core::random_string(24);
    let attempts: Vec<String> = candidates
        .iter()
        .map(|r| boxapi::authorize_url(&endpoints, &oauth_app.client_id, r.as_deref(), &csrf))
        .collect();

    let (code, used) = tokio::select! {
        r = ui::box_login_window(app, &attempts, &csrf) => r?,
        _ = state.box_login_cancel.notified() => {
            ui::close_box_login_window(app);
            return Err("вход отменён".into());
        }
    };
    let redirect_uri = candidates[used].clone();
    log::info!("Box sign-in: redirect URI {}", redirect_uri.as_deref().unwrap_or("(app default)"));
    let tokens = boxapi::exchange_code(
        &boxapi::http_client(),
        &endpoints,
        &oauth_app.client_id,
        &oauth_app.client_secret,
        &code,
        redirect_uri.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    state.update_secrets(|s| {
        s.box_oauth = Some(tokens);
        s.box_redirect = Some(LearnedRedirect { client_id: oauth_app.client_id.clone(), redirect_uri });
    })?;
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
