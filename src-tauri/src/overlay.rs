//! Full-screen selection overlays: one borderless always-on-top window per monitor,
//! each showing the frozen screenshot of its monitor. Windows are created once and
//! reused (hidden between captures) so the overlay appears instantly.

use std::time::Duration;

use serde::Serialize;
use shoter_core::Rect;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::capture::{CaptureSession, MonitorInfo, WindowInfo};
use crate::state::{Action, AppState, CaptureMode};

pub const PREFIX: &str = "overlay-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPrepare {
    pub session_id: u64,
    pub monitor: MonitorInfo,
    /// Path for the `shot` protocol, e.g. `session/3/0.bmp`.
    pub image: String,
    /// Windows intersecting this monitor (virtual-screen coordinates), topmost first.
    pub windows: Vec<WindowInfo>,
    pub mode: CaptureMode,
    /// Initial selection (virtual-screen coordinates) – for window / fullscreen / last region.
    pub preselect: Option<Rect>,
    /// When set, the overlay performs this action right after the selection
    /// instead of showing the action bar.
    pub auto_action: Option<Action>,
    pub show_magnifier: bool,
    pub ui_elements: bool,
    pub cursor: (i32, i32),
}

pub fn label(index: usize) -> String {
    format!("{PREFIX}{index}")
}

fn build(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html#/overlay".into()))
        .title("AdvantShoter — выделение")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .inner_size(800.0, 600.0)
        .build()
}

fn place(window: &WebviewWindow, m: &MonitorInfo) {
    // Position first (may trigger a DPI change), then the physical size.
    let _ = window.set_position(PhysicalPosition::new(m.bounds.x, m.bounds.y));
    let _ = window.set_size(PhysicalSize::new(m.bounds.width, m.bounds.height));
}

/// Creates overlay windows for the given monitors in advance (called at startup).
pub fn precreate(app: &AppHandle, monitors: &[MonitorInfo]) {
    for m in monitors {
        let label = label(m.index);
        if app.get_webview_window(&label).is_none() {
            if let Ok(w) = build(app, &label) {
                place(&w, m);
            }
        }
    }
}

/// Native handles of all our windows – excluded from UI element hit-testing.
pub fn own_hwnds(app: &AppHandle) -> Vec<usize> {
    #[cfg(windows)]
    {
        app.webview_windows().values().filter_map(|w| w.hwnd().ok()).map(|h| h.0 as usize).collect()
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Vec::new()
    }
}

pub fn open(
    app: &AppHandle,
    session: &CaptureSession,
    mode: CaptureMode,
    preselect: Option<Rect>,
    auto_action: Option<Action>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings();

    // Close overlays of monitors that disappeared.
    for (label, w) in app.webview_windows() {
        if let Some(i) = label.strip_prefix(PREFIX).and_then(|s| s.parse::<usize>().ok()) {
            if i >= session.monitors.len() {
                let _ = w.close();
            }
        }
    }

    let mut payloads = Vec::with_capacity(session.monitors.len());
    for m in &session.monitors {
        let preselect_here = preselect.and_then(|r| {
            let (cx, cy) = r.center();
            m.bounds.contains(cx, cy).then(|| r.intersect(&m.bounds)).flatten()
        });
        let payload = OverlayPrepare {
            session_id: session.id,
            monitor: m.clone(),
            image: format!("session/{}/{}.bmp", session.id, m.index),
            windows: session.windows.iter().filter(|w| w.bounds.intersect(&m.bounds).is_some()).cloned().collect(),
            mode,
            preselect: preselect_here,
            auto_action,
            show_magnifier: settings.show_magnifier,
            ui_elements: cfg!(windows),
            cursor: session.cursor,
        };
        payloads.push((m, label(m.index), serde_json::to_value(&payload).map_err(|e| e.to_string())?));
    }
    // Publish the payloads first (short lock): freshly created overlays pull them via
    // `overlay_pending`, which runs on the main thread — never hold the lock while
    // creating windows, that needs the main thread too.
    {
        let mut pending = state.overlay_pending.lock().unwrap();
        pending.clear();
        for (_, label, value) in &payloads {
            pending.insert(label.clone(), value.clone());
        }
    }
    for (m, label, value) in payloads {
        let window = match app.get_webview_window(&label) {
            Some(w) => w,
            None => build(app, &label).map_err(|e| e.to_string())?,
        };
        place(&window, m);
        // Targeted: every overlay must get only the picture of its own monitor.
        let _ = app.emit_to(label.as_str(), "overlay:prepare", value);
    }

    // Watchdog: if no overlay reported "ready" (web view crashed, etc.) give the user
    // their screen back instead of leaving the app stuck in "capturing" state.
    let app = app.clone();
    let session_id = session.id;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let state = app.state::<AppState>();
        let stuck = {
            let flow = state.flow.lock().unwrap();
            let same = state.session.lock().unwrap().as_ref().map(|s| s.id) == Some(session_id);
            flow.busy && !flow.shown && same
        };
        if stuck {
            log::error!("overlay did not become ready, cancelling capture");
            crate::flow::cancel(&app);
            crate::ui::toast(&app, crate::ui::Toast::error("Не удалось показать выделение", "Попробуйте ещё раз"));
        }
    });
    Ok(())
}

/// Payload for an overlay that loaded after the event was emitted.
pub fn pending(app: &AppHandle, label: &str) -> Option<serde_json::Value> {
    app.state::<AppState>().overlay_pending.lock().unwrap().get(label).cloned()
}

/// Called by an overlay when its frozen image is decoded – shows that window.
pub fn ready(app: &AppHandle, label: &str, session_id: u64) {
    let state = app.state::<AppState>();
    let Some(session) = state.session.lock().unwrap().clone() else { return };
    if session.id != session_id {
        return;
    }
    let Some(window) = app.get_webview_window(label) else { return };
    let index = label.strip_prefix(PREFIX).and_then(|s| s.parse::<usize>().ok());
    if let Some(m) = index.and_then(|i| session.monitors.get(i)) {
        place(&window, m);
    }
    state.flow.lock().unwrap().shown = true;
    let _ = window.set_always_on_top(true);
    let _ = window.show();
    let (cx, cy) = session.cursor;
    let has_cursor = index
        .and_then(|i| session.monitors.get(i))
        .map(|m| m.bounds.contains(cx, cy))
        .unwrap_or(false);
    if has_cursor || session.monitors.len() == 1 {
        let _ = window.set_focus();
    }
}

pub fn hide_all(app: &AppHandle) {
    app.state::<AppState>().overlay_pending.lock().unwrap().clear();
    for (label, w) in app.webview_windows() {
        if label.starts_with(PREFIX) {
            let _ = w.hide();
            let _ = app.emit_to(label.as_str(), "overlay:reset", ());
        }
    }
}
