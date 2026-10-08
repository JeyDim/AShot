//! Window management: tray panel, toast notifications, editor, settings, about.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Theme, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::capture;
use crate::state::AppState;

pub const PANEL: &str = "panel";
pub const TOAST: &str = "toast";
pub const SETTINGS: &str = "settings";
pub const ABOUT: &str = "about";

const PANEL_SIZE: (f64, f64) = (420.0, 640.0);
const TOAST_SIZE: (f64, f64) = (400.0, 150.0);

fn url(route: &str) -> WebviewUrl {
    WebviewUrl::App(format!("index.html#/{route}").into())
}

/// Monitor work area (physical) and scale for a point, falling back to the primary monitor.
fn work_area_at(app: &AppHandle, x: i32, y: i32) -> (i32, i32, i32, i32, f64) {
    let monitor = app
        .monitor_from_point(x as f64, y as f64)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let wa = m.work_area();
            (wa.position.x, wa.position.y, wa.size.width as i32, wa.size.height as i32, m.scale_factor())
        }
        None => (0, 0, 1920, 1040, 1.0),
    }
}

// ---------------------------------------------------------------- tray panel

pub fn create_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(PANEL) {
        return Ok(w);
    }
    let window = WebviewWindowBuilder::new(app, PANEL, url("panel"))
        .title("AdvantShoter")
        .inner_size(PANEL_SIZE.0, PANEL_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .theme(Some(Theme::Dark))
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide_panel(&handle);
        }
    });
    Ok(window)
}

/// Shows the panel near the tray icon (`anchor` = tray icon position, physical) or,
/// without an anchor, near the bottom-right corner of the monitor with the cursor.
pub fn show_panel(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let Ok(window) = create_panel(app) else { return };
    let (cx, cy) = anchor.unwrap_or_else(capture::cursor_position);
    let (wx, wy, ww, wh, scale) = work_area_at(app, cx, cy);
    let pw = (PANEL_SIZE.0 * scale).round() as i32;
    let ph = (PANEL_SIZE.1 * scale).round() as i32;
    let margin = (4.0 * scale) as i32;
    let x = if anchor.is_some() { (cx - pw / 2).clamp(wx + margin, wx + ww - pw - margin) } else { wx + ww - pw - margin };
    // Taskbar at the top → open downwards, otherwise upwards.
    let y = if anchor.is_some() && cy < wy + wh / 2 { wy + margin } else { wy + wh - ph - margin };
    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.set_size(PhysicalSize::new(pw as u32, ph as u32));
    let _ = app.emit_to(PANEL, "panel:shown", ());
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn toggle_panel(app: &AppHandle, anchor: Option<(i32, i32)>) {
    let state = app.state::<AppState>();
    // The click on the tray icon first blurs (and hides) the panel; don't reopen it immediately.
    if let Some(t) = *state.panel_hidden_at.lock().unwrap() {
        if t.elapsed() < Duration::from_millis(350) {
            return;
        }
    }
    match app.get_webview_window(PANEL) {
        Some(w) if w.is_visible().unwrap_or(false) => {
            hide_panel(app);
        }
        _ => show_panel(app, anchor),
    }
}

/// Hides the panel; returns `true` when it was visible.
pub fn hide_panel(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window(PANEL) else { return false };
    let visible = w.is_visible().unwrap_or(false);
    if visible {
        let _ = w.hide();
        *app.state::<AppState>().panel_hidden_at.lock().unwrap() = Some(Instant::now());
    }
    visible
}

// ---------------------------------------------------------------- toasts

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Toast {
    /// "success" | "error" | "info" | "progress"
    pub kind: String,
    pub title: String,
    pub message: Option<String>,
    pub link: Option<String>,
    pub path: Option<String>,
    pub history_id: Option<String>,
    /// 0 = stays until replaced/closed.
    pub timeout_ms: u64,
}

impl Toast {
    pub fn success(title: impl Into<String>) -> Self {
        Self { kind: "success".into(), title: title.into(), timeout_ms: 3500, ..Default::default() }
    }
    pub fn error(title: impl Into<String>, message: impl Into<String>) -> Self {
        Self { kind: "error".into(), title: title.into(), message: Some(message.into()), timeout_ms: 9000, ..Default::default() }
    }
    pub fn info(title: impl Into<String>) -> Self {
        Self { kind: "info".into(), title: title.into(), timeout_ms: 5000, ..Default::default() }
    }
    pub fn progress(title: impl Into<String>) -> Self {
        Self { kind: "progress".into(), title: title.into(), timeout_ms: 0, ..Default::default() }
    }
    pub fn message(mut self, m: impl Into<String>) -> Self {
        self.message = Some(m.into());
        self
    }
    pub fn link(mut self, l: impl Into<String>) -> Self {
        self.link = Some(l.into());
        self
    }
    pub fn path(mut self, p: impl Into<String>) -> Self {
        self.path = Some(p.into());
        self
    }
    pub fn item(mut self, id: impl Into<String>) -> Self {
        self.history_id = Some(id.into());
        self
    }
    pub fn timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }
}

pub fn create_toast(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(TOAST) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, TOAST, url("toast"))
        .title("AdvantShoter")
        .inner_size(TOAST_SIZE.0, TOAST_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .theme(Some(Theme::Dark))
        .build()
}

/// Shows a notification in the bottom-right corner of the monitor with the cursor.
/// The toast window is pre-created at startup, so this never builds a window.
pub fn toast(app: &AppHandle, toast: Toast) {
    let Ok(window) = create_toast(app) else { return };
    let (cx, cy) = capture::cursor_position();
    let (wx, wy, ww, wh, scale) = work_area_at(app, cx, cy);
    let tw = (TOAST_SIZE.0 * scale).round() as i32;
    let th = (TOAST_SIZE.1 * scale).round() as i32;
    let margin = (8.0 * scale) as i32;
    let _ = window.set_position(PhysicalPosition::new(wx + ww - tw - margin, wy + wh - th - margin));
    let _ = window.set_size(PhysicalSize::new(tw as u32, th as u32));
    let _ = app.emit_to(TOAST, "toast:show", &toast);
    show_without_focus(&window);
}

/// Hides the toast; returns `true` when it was visible.
pub fn hide_toast(app: &AppHandle) -> bool {
    let Some(w) = app.get_webview_window(TOAST) else { return false };
    let visible = w.is_visible().unwrap_or(false);
    if visible {
        hide_native(&w);
    }
    visible
}

/// Shows a window without activating it, so the user's application keeps keyboard
/// focus (e.g. Ctrl+V right after "copied to clipboard").
#[cfg(windows)]
fn show_without_focus(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE,
    };
    let Ok(hwnd) = window.hwnd() else {
        let _ = window.show();
        return;
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
    }
}

#[cfg(not(windows))]
fn show_without_focus(window: &WebviewWindow) {
    let _ = window.show();
}

/// Counterpart of [`show_without_focus`]: the window was shown natively, so hide it
/// natively too (the windowing library does not know it is visible).
#[cfg(windows)]
fn hide_native(window: &WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    match window.hwnd() {
        Ok(hwnd) => unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        },
        Err(_) => {
            let _ = window.hide();
        }
    }
}

#[cfg(not(windows))]
fn hide_native(window: &WebviewWindow) {
    let _ = window.hide();
}

// ---------------------------------------------------------------- regular windows

fn focus_existing(app: &AppHandle, label: &str) -> bool {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return true;
    }
    false
}

pub fn open_settings(app: &AppHandle) {
    hide_panel(app);
    if focus_existing(app, SETTINGS) {
        return;
    }
    let _ = WebviewWindowBuilder::new(app, SETTINGS, url("settings"))
        .title("Настройки — AdvantShoter")
        .inner_size(860.0, 640.0)
        .min_inner_size(720.0, 520.0)
        .center()
        .theme(Some(Theme::Dark))
        .build();
}

pub fn open_about(app: &AppHandle) {
    hide_panel(app);
    if focus_existing(app, ABOUT) {
        return;
    }
    let _ = WebviewWindowBuilder::new(app, ABOUT, url("about"))
        .title("О программе — AdvantShoter")
        .inner_size(460.0, 520.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .theme(Some(Theme::Dark))
        .build();
}

pub fn editor_label(id: &str) -> String {
    format!("editor-{id}")
}

pub fn open_editor(app: &AppHandle, id: &str) {
    hide_panel(app);
    let label = editor_label(id);
    if focus_existing(app, &label) {
        return;
    }
    let state = app.state::<AppState>();
    let (iw, ih) = state.history.get(id).map(|i| (i.width, i.height)).unwrap_or((1280, 720));
    let (cx, cy) = capture::cursor_position();
    let (wx, wy, ww, wh, scale) = work_area_at(app, cx, cy);
    // Logical sizes: image at 100% + toolbar/status bar/padding, clamped to the work area.
    let max_w = ww as f64 / scale * 0.92;
    let max_h = wh as f64 / scale * 0.92;
    let w = (iw as f64 / scale + 96.0).clamp(980.0_f64.min(max_w), max_w);
    let h = (ih as f64 / scale + 190.0).clamp(640.0_f64.min(max_h), max_h);
    let x = wx as f64 / scale + (ww as f64 / scale - w) / 2.0;
    let y = wy as f64 / scale + (wh as f64 / scale - h) / 2.0;
    let built = WebviewWindowBuilder::new(app, &label, url(&format!("editor/{id}")))
        .title("Редактор — AdvantShoter")
        .inner_size(w, h)
        .min_inner_size(760.0, 480.0)
        .position(x, y)
        .theme(Some(Theme::Dark))
        .focused(true)
        .build();
    if let Ok(window) = built {
        let _ = window.set_focus();
    }
}
