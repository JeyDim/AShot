//! Screen capture: monitors, frozen screenshots and the list of top-level windows
//! used to highlight windows under the cursor in the overlay.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use shoter_core::imaging::MonitorShot;
use shoter_core::Rect;

#[cfg(windows)]
mod win;
#[cfg(windows)]
pub use win::{cursor_position, foreground_window_rect, monitors};

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use other::{cursor_position, foreground_window_rect, monitors};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    /// Physical pixels in virtual-screen coordinates.
    pub bounds: Rect,
    pub work_area: Rect,
    /// DPI scale factor (1.0 = 96 DPI).
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub title: String,
    /// Visible frame (without the invisible resize borders), physical pixels.
    pub bounds: Rect,
}

/// A frozen picture of all monitors taken when the user pressed the hotkey.
pub struct CaptureSession {
    pub id: u64,
    pub monitors: Vec<MonitorInfo>,
    pub shots: Vec<MonitorShot>,
    /// Top-level windows in z-order (topmost first).
    pub windows: Vec<WindowInfo>,
    pub cursor: (i32, i32),
    /// Foreground window at capture time (for "capture active window").
    pub foreground: Option<Rect>,
    bmp_cache: Mutex<HashMap<usize, Arc<Vec<u8>>>>,
}

impl CaptureSession {
    pub fn new(
        id: u64,
        monitors: Vec<MonitorInfo>,
        shots: Vec<MonitorShot>,
        windows: Vec<WindowInfo>,
        cursor: (i32, i32),
        foreground: Option<Rect>,
    ) -> Self {
        Self { id, monitors, shots, windows, cursor, foreground, bmp_cache: Mutex::new(HashMap::new()) }
    }

    /// BMP of one monitor for the overlay (encoded once, cached).
    pub fn monitor_bmp(&self, index: usize) -> Option<Arc<Vec<u8>>> {
        if let Some(b) = self.bmp_cache.lock().unwrap().get(&index) {
            return Some(b.clone());
        }
        let shot = self.shots.get(index)?;
        let bytes = Arc::new(shoter_core::imaging::encode_bmp(&shot.image).ok()?);
        self.bmp_cache.lock().unwrap().insert(index, bytes.clone());
        Some(bytes)
    }

    pub fn monitor_at(&self, x: i32, y: i32) -> Option<&MonitorInfo> {
        self.monitors.iter().find(|m| m.bounds.contains(x, y))
    }

    pub fn virtual_bounds(&self) -> Rect {
        shoter_core::imaging::virtual_bounds(&self.shots)
    }
}

/// Captures every monitor (optionally with the mouse cursor drawn in).
pub fn capture_session(id: u64, include_cursor: bool) -> Result<CaptureSession, String> {
    #[cfg(windows)]
    {
        win::capture_session(id, include_cursor)
    }
    #[cfg(not(windows))]
    {
        other::capture_session(id, include_cursor)
    }
}
