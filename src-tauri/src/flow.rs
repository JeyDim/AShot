//! Capture flow: hotkey/tray → freeze the screen → overlay (or direct action) → result.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use shoter_core::settings::{AfterCapture, FullscreenMode};
use shoter_core::{imaging, Rect};
use tauri::{AppHandle, Manager};

use crate::actions;
use crate::capture::{self, CaptureSession};
use crate::overlay;
use crate::state::{Action, AppState, CaptureMode};
use crate::ui::{self, Toast};

fn action_for(after: AfterCapture) -> Option<Action> {
    match after {
        AfterCapture::Ask => None,
        AfterCapture::OpenEditor => Some(Action::Edit),
        AfterCapture::Copy => Some(Action::Copy),
        AfterCapture::Save => Some(Action::Save),
        AfterCapture::Upload => Some(Action::Upload),
    }
}

/// Starts a capture unless one is already running.
pub fn start(app: &AppHandle, mode: CaptureMode) {
    let state = app.state::<AppState>();
    {
        let mut flow = state.flow.lock().unwrap();
        // A stale "busy" flag (e.g. a crashed overlay) expires after two minutes.
        if flow.busy && flow.started.is_some_and(|t| t.elapsed() < Duration::from_secs(120)) {
            return;
        }
        flow.busy = true;
        flow.shown = false;
        flow.started = Some(Instant::now());
        flow.mode = Some(mode);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(&app, mode).await {
            log::error!("capture failed: {err}");
            cancel(&app);
            ui::toast(&app, Toast::error("Не удалось сделать снимок", err));
        }
    });
}

async fn run(app: &AppHandle, mode: CaptureMode) -> Result<(), String> {
    let state = app.state::<AppState>();
    // Let the tray panel / toast disappear before freezing the screen.
    let panel_was_visible = ui::hide_panel(app);
    let toast_was_visible = ui::hide_toast(app);
    if panel_was_visible {
        tokio::time::sleep(Duration::from_millis(220)).await;
    } else if toast_was_visible {
        tokio::time::sleep(Duration::from_millis(90)).await;
    }

    let settings = state.settings();
    let id = state.session_counter.fetch_add(1, Ordering::SeqCst);
    let include_cursor = settings.show_cursor;
    let session = tauri::async_runtime::spawn_blocking(move || capture::capture_session(id, include_cursor))
        .await
        .map_err(|e| e.to_string())??;
    let session = Arc::new(session);
    *state.session.lock().unwrap() = Some(session.clone());

    #[cfg(windows)]
    state.ui_selector.refresh(overlay::own_hwnds(app));

    let virtual_screen = session.virtual_bounds();
    let monitor_under_cursor = session
        .monitor_at(session.cursor.0, session.cursor.1)
        .or_else(|| session.monitors.first())
        .map(|m| m.bounds);

    let target: Option<Rect> = match mode {
        CaptureMode::Region | CaptureMode::WindowPick => None,
        CaptureMode::Window => session.foreground.or(monitor_under_cursor),
        CaptureMode::Fullscreen => match settings.fullscreen_mode {
            FullscreenMode::CurrentMonitor => monitor_under_cursor,
            FullscreenMode::AllMonitors => Some(virtual_screen),
        },
        CaptureMode::LastRegion => settings.last_region.and_then(|r| r.intersect(&virtual_screen)),
    }
    .and_then(|r| r.intersect(&virtual_screen));

    let auto = action_for(settings.after_capture);
    match target {
        Some(rect) => {
            let fits_one_monitor = session.monitors.iter().any(|m| m.bounds.intersect(&rect) == Some(rect));
            match auto {
                // Show the overlay with a pre-selected area so it can be adjusted.
                None if fits_one_monitor => overlay::open(app, &session, mode, Some(rect), None),
                // The area spans several monitors – the overlay works per monitor, go to the editor.
                None => complete(app, rect, Action::Edit).await,
                Some(action) => complete(app, rect, action).await,
            }
        }
        None => overlay::open(app, &session, mode, None, auto),
    }
}

/// Finishes the capture with a selected rectangle (virtual-screen coordinates).
pub async fn complete(app: &AppHandle, rect: Rect, action: Action) -> Result<(), String> {
    complete_with(app, rect, action, None).await
}

/// Same as [`complete`], with drawings made on the overlay.
pub async fn complete_with(app: &AppHandle, rect: Rect, action: Action, annotated: Option<actions::Annotated>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let session: Option<Arc<CaptureSession>> = state.session.lock().unwrap().take();
    let mode = state.flow.lock().unwrap().mode;
    overlay::hide_all(app);
    release(app);
    let session = session.ok_or("снимок экрана устарел, попробуйте ещё раз")?;
    let shots = session.shots.clone();
    drop(session);
    let image = tauri::async_runtime::spawn_blocking(move || imaging::crop_virtual(&shots, rect).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    state.update_settings(|s| s.last_region = Some(rect));
    let source = mode.map(|m| m.source()).unwrap_or("region");
    actions::process_capture(app, image, source, action, annotated).await
}

/// Aborts the capture (Esc / right click / error).
pub fn cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.session.lock().unwrap().take();
    overlay::hide_all(app);
    release(app);
}

fn release(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut flow = state.flow.lock().unwrap();
    flow.busy = false;
    flow.shown = false;
    flow.mode = None;
    #[cfg(windows)]
    state.ui_selector.release();
}
