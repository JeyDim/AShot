//! Non-Windows stubs. The application currently targets Windows only; these keep the
//! crate compiling on other platforms (CI checks, UI development).

use super::{CaptureSession, MonitorInfo};

pub fn capture_session(_id: u64, _include_cursor: bool) -> Result<CaptureSession, String> {
    Err("Захват экрана пока поддерживается только в Windows".into())
}

pub fn monitors() -> Vec<MonitorInfo> {
    Vec::new()
}

pub fn cursor_position() -> (i32, i32) {
    (0, 0)
}
