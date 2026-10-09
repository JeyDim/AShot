//! Windows implementation: GDI BitBlt per monitor, cursor via DrawIconEx,
//! window list via EnumWindows + DWM extended frame bounds.
//!
//! The process is Per-Monitor-V2 DPI aware (Tauri manifest), so every coordinate here
//! is in physical pixels of the virtual screen.

use std::ffi::c_void;

use image::RgbaImage;
use shoter_core::imaging::MonitorShot;
use shoter_core::Rect;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
    GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
    DIB_RGB_COLORS, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW, SRCCOPY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, EnumWindows, GetClassNameW, GetCursorInfo, GetCursorPos, GetForegroundWindow, GetIconInfo,
    GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    CURSORINFO, CURSOR_SHOWING, DI_NORMAL, GWL_EXSTYLE, ICONINFO, MONITORINFOF_PRIMARY, WS_EX_TRANSPARENT,
};

use super::{CaptureSession, MonitorInfo, WindowInfo};

fn rect_from(r: RECT) -> Rect {
    Rect::new(r.left, r.top, (r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32)
}

pub fn monitors() -> Vec<MonitorInfo> {
    unsafe extern "system" fn collect(hmon: HMONITOR, _hdc: HDC, _rect: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
        list.push(hmon);
        BOOL(1)
    }
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    let mut result: Vec<MonitorInfo> = handles
        .into_iter()
        .filter_map(|hmon| unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if !GetMonitorInfoW(hmon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO).as_bool() {
                return None;
            }
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
            let name_len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
            Some(MonitorInfo {
                index: 0,
                name: String::from_utf16_lossy(&info.szDevice[..name_len]),
                bounds: rect_from(info.monitorInfo.rcMonitor),
                work_area: rect_from(info.monitorInfo.rcWork),
                scale: dpi_x as f64 / 96.0,
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            })
        })
        .collect();
    // Stable order: left-to-right, top-to-bottom.
    result.sort_by_key(|m| (m.bounds.x, m.bounds.y));
    for (i, m) in result.iter_mut().enumerate() {
        m.index = i;
    }
    result
}

pub fn cursor_position() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

fn window_bounds(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    unsafe {
        let ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if !ok {
            GetWindowRect(hwnd, &mut r).ok()?;
        }
    }
    let rect = rect_from(r);
    (!rect.is_empty()).then_some(rect)
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4).is_ok() && cloaked != 0
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 128];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn foreground_window_rect() -> Option<Rect> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() || is_own_window(hwnd) {
        return None;
    }
    let class = class_name(hwnd);
    if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
        return None;
    }
    window_bounds(hwnd)
}

fn is_own_window(hwnd: HWND) -> bool {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid == std::process::id()
}

/// Visible top-level windows in z-order (topmost first), excluding our own windows,
/// the desktop and cloaked (hidden UWP / other virtual desktop) windows.
fn windows_list(virtual_screen: Rect) -> Vec<WindowInfo> {
    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<HWND>) };
        list.push(hwnd);
        BOOL(1)
    }
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    let mut out = Vec::new();
    for hwnd in handles {
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            if GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT.0 != 0 {
                continue;
            }
        }
        if is_own_window(hwnd) || is_cloaked(hwnd) {
            continue;
        }
        let class = class_name(hwnd);
        if matches!(class.as_str(), "Progman" | "WorkerW") {
            continue;
        }
        let Some(bounds) = window_bounds(hwnd) else { continue };
        let Some(bounds) = bounds.intersect(&virtual_screen) else { continue };
        if bounds.width < 8 || bounds.height < 8 {
            continue;
        }
        let mut title = [0u16; 256];
        let n = unsafe { GetWindowTextW(hwnd, &mut title) };
        out.push(WindowInfo { title: String::from_utf16_lossy(&title[..n.max(0) as usize]), bounds });
        if out.len() >= 400 {
            break;
        }
    }
    out
}

/// The mouse cursor to draw into the captures: its picture and where it is.
struct Cursor {
    info: CURSORINFO,
    /// Physical virtual-screen position (`GetCursorPos`), the coordinate space of the monitor
    /// bounds. `CURSORINFO::ptScreenPos` is not: with monitors of different DPI scale it is off
    /// on every monitor but the primary one, and the cursor ended up outside the picture.
    at: (i32, i32),
}

/// The screen inside `rect` as it is now, without the cursor (scrolling capture).
pub fn grab(rect: Rect) -> Result<RgbaImage, String> {
    capture_rect(rect, None)
}

/// Captures one monitor rectangle with BitBlt and optionally draws the cursor.
fn capture_rect(rect: Rect, cursor: Option<&Cursor>) -> Result<RgbaImage, String> {
    let (w, h) = (rect.width as i32, rect.height as i32);
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC failed".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(bitmap.0));

        let result = (|| {
            BitBlt(mem, 0, 0, w, h, Some(screen), rect.x, rect.y, SRCCOPY | CAPTUREBLT)
                .map_err(|e| format!("BitBlt: {e}"))?;
            if let Some(c) = cursor {
                draw_cursor(mem, c, rect);
            }
            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(mem, bitmap, 0, h as u32, Some(buf.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
            if lines != h {
                return Err(format!("GetDIBits returned {lines} of {h} lines"));
            }
            // BGRA → RGBA, force opaque alpha (GDI leaves it undefined).
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
                px[3] = 255;
            }
            RgbaImage::from_raw(w as u32, h as u32, buf).ok_or_else(|| "bad buffer".to_string())
        })();

        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result
    }
}

unsafe fn draw_cursor(mem: HDC, cursor: &Cursor, rect: Rect) {
    let mut info = ICONINFO::default();
    unsafe {
        let icon = windows::Win32::UI::WindowsAndMessaging::HICON(cursor.info.hCursor.0);
        if GetIconInfo(icon, &mut info).is_err() {
            return;
        }
        let x = cursor.at.0 - info.xHotspot as i32 - rect.x;
        let y = cursor.at.1 - info.yHotspot as i32 - rect.y;
        let _ = DrawIconEx(mem, x, y, icon, 0, 0, 0, None, DI_NORMAL);
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmMask.0));
        }
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(info.hbmColor.0));
        }
    }
}

pub fn capture_session(id: u64, include_cursor: bool) -> Result<CaptureSession, String> {
    let monitors = monitors();
    if monitors.is_empty() {
        return Err("не найдено ни одного монитора".into());
    }
    let at = cursor_position();
    let cursor = include_cursor
        .then(|| unsafe {
            let mut ci = CURSORINFO { cbSize: std::mem::size_of::<CURSORINFO>() as u32, ..Default::default() };
            (GetCursorInfo(&mut ci).is_ok() && ci.flags == CURSOR_SHOWING).then_some(ci)
        })
        .flatten()
        .map(|info| {
            let reported = (info.ptScreenPos.x, info.ptScreenPos.y);
            if reported != at {
                log::info!("cursor: GetCursorInfo reports {reported:?}, GetCursorPos {at:?} — drawing at the latter");
            }
            Cursor { info, at }
        });

    let mut shots = Vec::with_capacity(monitors.len());
    for m in &monitors {
        let cursor = cursor.as_ref().filter(|c| {
            // DrawIconEx clips by itself, but skip monitors the cursor is far away from.
            let (cx, cy) = c.at;
            cx >= m.bounds.x - 64 && cy >= m.bounds.y - 64 && cx < m.bounds.right() + 64 && cy < m.bounds.bottom() + 64
        });
        shots.push(MonitorShot { bounds: m.bounds, image: capture_rect(m.bounds, cursor)? });
    }
    let virtual_screen = shoter_core::imaging::virtual_bounds(&shots);
    let windows = windows_list(virtual_screen);
    Ok(CaptureSession::new(id, monitors, shots, windows, at, foreground_window_rect()))
}
