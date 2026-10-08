//! `shot://` protocol serving images to the web views:
//! * `session/<session id>/<monitor>.bmp` – frozen monitor picture for the overlay
//! * `history/<id>/<file>` – history files (`current.png` = edited image or original)
//!
//! On Windows the web view sees it as `http://shot.localhost/...`.

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use shoter_core::history::HistoryFile;

use crate::state::AppState;

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let app = ctx.app_handle().clone();
    let path = shoter_core::percent_decode(request.uri().path());
    tauri::async_runtime::spawn_blocking(move || {
        let response = serve(&app, &path).unwrap_or_else(|status| {
            Response::builder()
                .status(status)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(Vec::new())
                .unwrap()
        });
        responder.respond(response);
    });
}

fn ok(bytes: Vec<u8>, mime: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        // Images are drawn into canvases (editor export, overlay magnifier) – allow CORS
        // so the canvas is not tainted.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .unwrap()
}

fn serve<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<Response<Vec<u8>>, StatusCode> {
    let state = app.state::<AppState>();
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match parts.as_slice() {
        ["session", sid, file] => {
            let index: usize = file.strip_suffix(".bmp").and_then(|s| s.parse().ok()).ok_or(StatusCode::NOT_FOUND)?;
            let session = state.session.lock().unwrap().clone().ok_or(StatusCode::NOT_FOUND)?;
            if session.id.to_string() != *sid {
                return Err(StatusCode::GONE);
            }
            let bytes = session.monitor_bmp(index).ok_or(StatusCode::NOT_FOUND)?;
            Ok(ok(bytes.as_ref().clone(), "image/bmp"))
        }
        ["history", id, file] => {
            let file_path = if *file == "current.png" {
                state.history.current_image_path(id)
            } else {
                let kind = HistoryFile::from_file_name(file).ok_or(StatusCode::NOT_FOUND)?;
                state.history.path(id, kind)
            }
            .map_err(|_| StatusCode::BAD_REQUEST)?;
            let bytes = std::fs::read(&file_path).map_err(|_| StatusCode::NOT_FOUND)?;
            let mime = if file.ends_with(".json") { "application/json" } else { "image/png" };
            Ok(ok(bytes, mime))
        }
        _ => Err(StatusCode::NOT_FOUND),
    }
}
