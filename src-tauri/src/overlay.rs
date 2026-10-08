//! Full-screen selection overlays: one borderless always-on-top window per monitor,
//! each showing the frozen screenshot of its monitor. Windows are created once and
//! reused (hidden between captures) so the overlay appears instantly.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Serialize;
use shoter_core::Rect;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::capture::{CaptureSession, MonitorInfo, WindowInfo};
use crate::state::{Action, AppState, CaptureMode};

pub const PREFIX: &str = "overlay-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPrepare {
    /// Window the payload is meant for. Web pages listening for an event receive it
    /// even when it was emitted to another window, so every overlay checks this.
    pub label: String,
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
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html#/overlay".into()))
        .title("AdvantShoter — выделение")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .inner_size(800.0, 600.0)
        .build()?;
    // Moving a window to a monitor with another DPI scale makes Windows/tao resize it to
    // keep its *logical* size (a 2K overlay would shrink to ~FullHD and show a squeezed,
    // grainy picture). Whenever that happens, snap it back to the exact monitor bounds.
    let handle = app.clone();
    let lbl = label.to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::ScaleFactorChanged { .. } | WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
            fit_to_monitor(&handle, &lbl);
        }
    });
    Ok(window)
}

fn place(window: &WebviewWindow, m: &MonitorInfo) {
    // Position first (may trigger a DPI change), then the physical size.
    let _ = window.set_position(PhysicalPosition::new(m.bounds.x, m.bounds.y));
    let _ = window.set_size(PhysicalSize::new(m.bounds.width, m.bounds.height));
}

/// Re-placements per overlay since the last capture started (guards against a loop if
/// Windows keeps refusing the requested bounds).
static FIT_ATTEMPTS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn target_monitor(app: &AppHandle, label: &str) -> Option<MonitorInfo> {
    let index = label.strip_prefix(PREFIX)?.parse::<usize>().ok()?;
    let session = app.state::<AppState>().session.lock().unwrap().clone();
    match session {
        Some(s) => s.monitors.get(index).cloned(),
        None => crate::capture::monitors().get(index).cloned(),
    }
}

/// Puts the overlay exactly over its monitor when its bounds drifted.
fn fit_to_monitor(app: &AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else { return };
    let Some(m) = target_monitor(app, label) else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
    let b = m.bounds;
    if pos.x == b.x && pos.y == b.y && size.width == b.width && size.height == b.height {
        return;
    }
    let attempts = {
        let mut map = FIT_ATTEMPTS.lock().unwrap();
        let n = map.entry(label.to_string()).or_insert(0);
        *n += 1;
        *n
    };
    if attempts > 6 {
        return;
    }
    log::info!(
        "{label}: window {}x{} at {},{} (scale {:?}) does not match monitor {}x{} at {},{} (scale {}), re-placing",
        size.width,
        size.height,
        pos.x,
        pos.y,
        window.scale_factor().ok(),
        b.width,
        b.height,
        b.x,
        b.y,
        m.scale
    );
    place(&window, &m);
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
    FIT_ATTEMPTS.lock().unwrap().clear();

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
            label: label(m.index),
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
    // Showing a window can deliver a late DPI change – check the bounds again shortly after.
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        for delay in [60, 250, 800] {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            fit_to_monitor(&app, &label);
        }
    });
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
