//! Capture flow: hotkey/tray → freeze the screen → overlay (or direct action) → result.

use std::path::PathBuf;
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

    let virtual_screen = session.virtual_bounds();
    let monitor_under_cursor = session
        .monitor_at(session.cursor.0, session.cursor.1)
        .or_else(|| session.monitors.first())
        .map(|m| m.bounds);
    let auto = action_for(settings.after_capture);

    match mode {
        // Nothing to choose on a whole screen: straight to the editor (or the action chosen
        // in the settings), for one monitor as for all of them.
        CaptureMode::Fullscreen => {
            let rect = match settings.fullscreen_mode {
                FullscreenMode::CurrentMonitor => monitor_under_cursor,
                FullscreenMode::AllMonitors => Some(virtual_screen),
            }
            .and_then(|r| r.intersect(&virtual_screen))
            .ok_or("не найден монитор")?;
            complete(app, rect, auto.unwrap_or(Action::Edit)).await
        }
        // The active window, pre-selected on the overlay so it can be adjusted.
        CaptureMode::Window => match session.foreground.or(monitor_under_cursor).and_then(|r| r.intersect(&virtual_screen)) {
            Some(rect) => {
                let fits_one_monitor = session.monitors.iter().any(|m| m.bounds.intersect(&rect) == Some(rect));
                match auto {
                    None if fits_one_monitor => overlay::open(app, &session, mode, Some(rect), None),
                    // The window spans several monitors – the overlay works per monitor, go to the editor.
                    None => complete(app, rect, Action::Edit).await,
                    Some(action) => complete(app, rect, action).await,
                }
            }
            None => overlay::open(app, &session, mode, None, auto),
        },
        CaptureMode::Region | CaptureMode::WindowPick => {
            // UI elements (buttons, panels…) are highlighted only in the region mode; the window
            // mode highlights whole windows.
            #[cfg(windows)]
            if mode == CaptureMode::Region {
                state.ui_selector.refresh(overlay::own_hwnds(app));
            }
            overlay::open(app, &session, mode, None, auto)
        }
    }
}

/// Finishes the capture with a selected rectangle (virtual-screen coordinates).
pub async fn complete(app: &AppHandle, rect: Rect, action: Action) -> Result<(), String> {
    complete_with(app, rect, action, None, None).await
}

/// Same as [`complete`], with drawings made on the overlay and / or the file already
/// chosen for "Save as…".
pub async fn complete_with(
    app: &AppHandle,
    rect: Rect,
    action: Action,
    annotated: Option<actions::Annotated>,
    save_to: Option<PathBuf>,
) -> Result<(), String> {
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
    let source = mode.map(|m| m.source()).unwrap_or("region");
    actions::process_capture(app, image, source, action, annotated, save_to).await
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
