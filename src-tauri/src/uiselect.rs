//! Hit-testing of windows and UI elements (buttons, panels, lists…) under the cursor,
//! powered by `snow-ui-selector` (UI Automation). The service is COM-apartment bound,
//! so it lives on its own thread and is driven through a channel.
//!
//! Firefox speaks MSAA natively and builds its accessibility tree lazily: the first
//! UI Automation calls may time out (cached as failed for the whole capture) or see a page
//! without content yet. For Firefox windows the MSAA backend is asked as well — it hit-tests
//! afresh on every query — and the more specific answer wins.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use shoter_core::Rect;
use snow_ui_selector::{AccessibilityBackend, ElementRect, ElementRegionService, HitTestMode, Point, QueryControl, StopReason};
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{AccessibleObjectFromWindow, IAccessible};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetWindowRect, IsIconic, IsWindowVisible, OBJID_CLIENT};
use windows::core::{BOOL, Interface};

/// A timed-out MSAA window is skipped until the next refresh; Firefox may still be starting
/// its accessibility engine, so it gets another chance after this pause.
const MSAA_RETRY_AFTER: Duration = Duration::from_secs(1);

enum Request {
    Refresh(Vec<usize>),
    Query { x: i32, y: i32, reply: tokio::sync::oneshot::Sender<Vec<Rect>> },
    Release,
}

pub struct UiSelector {
    tx: Mutex<mpsc::Sender<Request>>,
}

struct Worker {
    uia: Option<ElementRegionService>,
    /// Created on first use (only Firefox windows need it).
    msaa: Option<ElementRegionService>,
    excluded: Vec<usize>,
    msaa_refreshed: Instant,
    /// Firefox gave no elements in this capture (logged once).
    firefox_warned: bool,
}

impl Worker {
    fn new() -> Self {
        let uia = match ElementRegionService::new() {
            Ok(s) => Some(s),
            Err(e) => {
                log::warn!("UI element selection is unavailable: {e}");
                None
            }
        };
        Self { uia, msaa: None, excluded: Vec::new(), msaa_refreshed: Instant::now(), firefox_warned: false }
    }

    fn refresh(&mut self, excluded: Vec<usize>) {
        if let Some(s) = self.uia.as_mut()
            && let Err(e) = s.refresh_excluding_ids(&excluded)
        {
            log::warn!("ui-selector refresh failed: {e}");
        }
        if let Some(s) = self.msaa.as_mut()
            && let Err(e) = s.refresh_excluding_ids(&excluded)
        {
            log::warn!("ui-selector (MSAA) refresh failed: {e}");
        }
        self.msaa_refreshed = Instant::now();
        self.excluded = excluded;
        self.firefox_warned = false;
        warm_up_firefox(&self.excluded);
    }

    fn release(&mut self) {
        for s in [self.uia.as_mut(), self.msaa.as_mut()].into_iter().flatten() {
            s.release_cache();
        }
    }

    fn query(&mut self, x: i32, y: i32) -> Vec<Rect> {
        let point = Point { x, y, ..Default::default() };
        let (mut path, reason) = match self.uia.as_mut() {
            Some(s) => match s.query(point, HitTestMode::UiElement, &QueryControl::foreground(), &mut |_| {}) {
                Ok(r) => (r.path.unwrap_or_default(), r.reason),
                Err(_) => (Vec::new(), StopReason::ProviderFailure),
            },
            None => (Vec::new(), StopReason::ProviderFailure),
        };
        let window = self.uia.as_ref().and_then(|s| s.window_at(point));
        let firefox = window.is_some_and(is_firefox_window);
        let uia_failed = path.len() <= 1 && matches!(reason, StopReason::ProviderTimeout | StopReason::ProviderFailure);
        if firefox || uia_failed || self.uia.is_none() {
            let mut msaa = self.msaa_query(point);
            // Only the window: a timed-out Firefox is skipped until refresh — retry now and then.
            if firefox && msaa.len() <= 1 && self.msaa_refreshed.elapsed() >= MSAA_RETRY_AFTER {
                if let Some(s) = self.msaa.as_mut() {
                    let _ = s.refresh_excluding_ids(&self.excluded);
                }
                self.msaa_refreshed = Instant::now();
                msaa = self.msaa_query(point);
            }
            if more_specific(&msaa, &path) {
                path = msaa;
            }
            if firefox && path.len() <= 1 && !self.firefox_warned {
                self.firefox_warned = true;
                log::info!(
                    "ui-selector: Firefox returned no UI elements (UIA: {reason:?}). If this persists, check \
                     about:support → Accessibility → \"Prevent accessibility\" (must be 0)"
                );
            }
        }
        path.into_iter()
            .filter(|e| e.width() > 0 && e.height() > 0)
            .map(|e| Rect::new(e.left(), e.top(), e.width() as u32, e.height() as u32))
            .collect()
    }

    fn msaa_query(&mut self, point: Point) -> Vec<ElementRect> {
        if self.msaa.is_none() {
            match ElementRegionService::with_backend_excluding_ids(AccessibilityBackend::Msaa, &self.excluded) {
                Ok(s) => self.msaa = Some(s),
                Err(e) => {
                    log::warn!("ui-selector (MSAA) is unavailable: {e}");
                    return Vec::new();
                }
            }
            self.msaa_refreshed = Instant::now();
        }
        self.msaa
            .as_mut()
            .and_then(|s| s.query(point, HitTestMode::UiElement, &QueryControl::foreground(), &mut |_| {}).ok())
            .and_then(|r| r.path)
            .unwrap_or_default()
    }
}

/// Paths are deepest first: the smaller deepest element is the more precise answer.
fn more_specific(candidate: &[ElementRect], current: &[ElementRect]) -> bool {
    let area = |e: &ElementRect| i64::from(e.width()) * i64::from(e.height());
    match (candidate.first(), current.first()) {
        (Some(c), Some(cur)) => candidate.len() > 1 && area(c) < area(cur),
        (Some(_), None) => true,
        _ => false,
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}

/// Firefox (and other Gecko apps: Thunderbird, Tor Browser) top-level windows.
fn is_firefox_window(hwnd: usize) -> bool {
    matches!(class_name(HWND(hwnd as *mut _)).as_str(), "MozillaWindowClass" | "MozillaDialogClass")
}

/// Visible, not minimized Firefox windows, except ours.
fn firefox_windows(excluded: &[usize]) -> Vec<isize> {
    unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
        let out = unsafe { &mut *(out.0 as *mut Vec<isize>) };
        let mut rect = RECT::default();
        let shown = unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() && GetWindowRect(hwnd, &mut rect).is_ok() };
        if shown && rect.right > rect.left && rect.bottom > rect.top && is_firefox_window(hwnd.0 as usize) {
            out.push(hwnd.0 as isize);
        }
        true.into()
    }
    let mut found: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut found as *mut Vec<isize> as isize));
    }
    found.retain(|h| !excluded.contains(&(*h as usize)));
    found
}

/// Firefox creates its accessibility tree only when a client first asks for it, and the
/// first answers come late or empty. Ask right when the screen is frozen, so the tree is
/// ready by the time the cursor reaches the window. One warm-up at a time: a busy Firefox
/// may block the call for a while.
fn warm_up_firefox(excluded: &[usize]) {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    let windows = firefox_windows(excluded);
    if windows.is_empty() || RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    let spawned = std::thread::Builder::new().name("ui-selector-warmup".into()).spawn(move || {
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        for hwnd in windows {
            let mut raw = std::ptr::null_mut();
            let got = unsafe { AccessibleObjectFromWindow(HWND(hwnd as *mut _), OBJID_CLIENT.0 as u32, &IAccessible::IID, &mut raw) };
            if got.is_ok() && !raw.is_null() {
                let root = unsafe { IAccessible::from_raw(raw) };
                // Any call that needs the tree makes Firefox build it.
                let _ = unsafe { root.accChildCount() };
            }
        }
        if com {
            unsafe { CoUninitialize() };
        }
        RUNNING.store(false, Ordering::Release);
    });
    if spawned.is_err() {
        RUNNING.store(false, Ordering::Release);
    }
}

impl UiSelector {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Request>();
        let spawned = std::thread::Builder::new().name("ui-selector".into()).spawn(move || {
            let mut worker = Worker::new();
            while let Ok(request) = rx.recv() {
                match request {
                    Request::Refresh(excluded) => worker.refresh(excluded),
                    Request::Query { x, y, reply } => {
                        let _ = reply.send(worker.query(x, y));
                    }
                    Request::Release => worker.release(),
                }
            }
        });
        if let Err(e) = spawned {
            log::warn!("cannot start ui-selector thread: {e}");
        }
        Self { tx: Mutex::new(tx) }
    }

    /// Takes a fresh snapshot of the windows, ignoring our own windows (overlays).
    pub fn refresh(&self, excluded_hwnds: Vec<usize>) {
        let _ = self.tx.lock().unwrap().send(Request::Refresh(excluded_hwnds));
    }

    /// Element path under the point: the deepest element first, the window last.
    pub async fn query(&self, x: i32, y: i32) -> Vec<Rect> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        if self.tx.lock().unwrap().send(Request::Query { x, y, reply }).is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    pub fn release(&self) {
        let _ = self.tx.lock().unwrap().send(Request::Release);
    }
}
