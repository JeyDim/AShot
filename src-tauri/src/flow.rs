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
use crate::scroll::{self, Ending};
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
        // The whole screen goes straight to the editor (or the action chosen in the settings):
        // all monitors, or the only one. With several monitors the user clicks the one to take
        // (the overlay of each monitor knows its own, no matter where the cursor was).
        CaptureMode::Fullscreen if settings.fullscreen_mode == FullscreenMode::AllMonitors || session.monitors.len() == 1 => {
            let rect = match settings.fullscreen_mode {
                FullscreenMode::CurrentMonitor => monitor_under_cursor,
                FullscreenMode::AllMonitors => Some(virtual_screen),
            }
            .and_then(|r| r.intersect(&virtual_screen))
            .ok_or("не найден монитор")?;
            complete(app, rect, auto.unwrap_or(Action::Edit)).await
        }
        CaptureMode::Fullscreen => overlay::open(app, &session, mode, None, Some(auto.unwrap_or(Action::Edit))),
        CaptureMode::Region | CaptureMode::WindowPick | CaptureMode::Scroll => {
            // UI elements (buttons, panels…) are highlighted in the region mode, scrolling areas
            // in the scroll mode; the window mode highlights whole windows.
            #[cfg(windows)]
            if matches!(mode, CaptureMode::Region | CaptureMode::Scroll) {
                state.ui_selector.refresh(overlay::own_hwnds(app));
            }
            // Scrolling starts as soon as the area is chosen: no drawing bar.
            let auto = if mode == CaptureMode::Scroll { Some(auto.unwrap_or(Action::Edit)) } else { auto };
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
    let mode = state.flow.lock().unwrap().mode;
    if mode == Some(CaptureMode::Scroll) {
        return complete_scrolling(app, rect, action).await;
    }
    let session: Option<Arc<CaptureSession>> = state.session.lock().unwrap().take();
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

/// Scroll mode: the live screen of `rect` is scrolled and glued (the frozen picture is not
/// needed any more); the capture stays busy until it ends.
async fn complete_scrolling(app: &AppHandle, rect: Rect, action: Action) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.session.lock().unwrap().take();
    state.flow.lock().unwrap().started = Some(Instant::now());
    overlay::hide_all(app);
    #[cfg(windows)]
    state.ui_selector.release();
    let outcome = scroll::run(app, rect).await;
    release(app);
    let outcome = match outcome {
        // Esc while the page was loading: nothing taken, nothing to report but that.
        Err(e) if e == scroll::CANCELLED => {
            ui::toast(app, Toast::info("Снимок с прокруткой отменён"));
            return Ok(());
        }
        other => other?,
    };
    let note = match outcome.ending {
        Ending::NotScrollable => Some("Область не прокручивается — снят один экран".to_string()),
        Ending::Lost => Some("Дальше склеить не удалось: страница сильно менялась при прокрутке. Снимок — до этого места".to_string()),
        Ending::Limit => Some(format!("Достигнут предел — {} px в высоту", scroll::MAX_HEIGHT)),
        Ending::End | Ending::Stopped => None,
    };
    actions::process_capture(app, outcome.image, CaptureMode::Scroll.source(), action, None, None).await?;
    // Other actions report with their own toast.
    if let (Some(note), Action::Edit) = (note, action) {
        ui::toast(app, Toast::info("Снимок с прокруткой").message(note).timeout(8000));
    }
    Ok(())
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
