//! Scrolling capture: AShot scrolls the chosen area itself and glues the frames together
//! (`shoter_core::stitch`). It scrolls through UI Automation when the content under the
//! selection offers it (browsers, Explorer, Office): exact steps, the page goes to the top
//! first and back where it was afterwards. Otherwise — with the mouse wheel, learning how far
//! one notch goes from the glued frames.
//!
//! The progress toast is excluded from screen capture (see `ui::create_toast`), so it may sit
//! over the area. Esc (registered globally for the time of the capture) or "Stop" in the toast
//! finish with what has been glued so far.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use image::RgbaImage;
use shoter_core::Rect;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::state::AppState;
use crate::ui::{self, Toast};

/// The picture never gets taller than this.
pub const MAX_HEIGHT: u32 = 20_000;
/// Frames per capture (a minute or so of scrolling).
const MAX_FRAMES: u32 = 80;

/// How the capture ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// The end of the page.
    End,
    /// Esc or "Stop".
    Stopped,
    /// `MAX_HEIGHT` / `MAX_FRAMES`.
    Limit,
    /// A frame could not be glued (the page changed too much while scrolling).
    Lost,
    /// Nothing moved: a single frame.
    NotScrollable,
}

pub struct Outcome {
    pub image: RgbaImage,
    pub ending: Ending,
}

/// Scrolls and glues `rect` (virtual-screen coordinates, one monitor; the overlay is already
/// hidden). Returns when the page ends or the user stops it.
pub async fn run(app: &AppHandle, rect: Rect) -> Result<Outcome, String> {
    let stop = Arc::new(AtomicBool::new(false));
    *app.state::<AppState>().scroll_stop.lock().unwrap() = Some(stop.clone());
    let esc = register_esc(app).await;
    ui::toast(app, progress_toast(0, 0));

    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let flag = stop.clone();
    let spawned = std::thread::Builder::new().name("scroll-capture".into()).spawn(move || {
        let progress = |frames: u32, height: u32| ui::toast(&handle, progress_toast(frames, height));
        let _ = tx.send(engine::session(rect, &flag, &progress));
    });
    let result = match spawned {
        Ok(_) => rx.await.unwrap_or_else(|_| Err("снимок с прокруткой прерван".into())),
        Err(e) => Err(e.to_string()),
    };

    if let Some(shortcut) = esc {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = handle.global_shortcut().unregister(shortcut);
        });
    }
    app.state::<AppState>().scroll_stop.lock().unwrap().take();
    ui::hide_toast(app);
    result
}

/// Stops the running scrolling capture ("Stop" in the toast, Esc).
pub fn stop(app: &AppHandle) {
    if let Some(flag) = app.state::<AppState>().scroll_stop.lock().unwrap().as_ref() {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Plain Esc, the key that stops a scrolling capture.
pub fn is_stop_key(shortcut: &Shortcut) -> bool {
    "Escape".parse::<Shortcut>().is_ok_and(|esc| esc.id() == shortcut.id())
}

/// Esc is grabbed for the time of the capture (the overlay that would take it is gone).
async fn register_esc(app: &AppHandle) -> Option<Shortcut> {
    let shortcut: Shortcut = "Escape".parse().ok()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    // Hotkeys are registered on the main thread (see `hotkeys::apply`).
    app.run_on_main_thread(move || {
        let _ = tx.send(handle.global_shortcut().register(shortcut).is_ok());
    })
    .ok()?;
    rx.await.ok()?.then_some(shortcut)
}

fn progress_toast(frames: u32, height: u32) -> Toast {
    let message = if frames == 0 {
        "Прокручиваю в начало… Esc — остановить".to_string()
    } else {
        format!("{frames} {} · {height} px · Esc — остановить", shoter_core::plural(frames as u64, "кадр", "кадра", "кадров"))
    };
    Toast::progress("Снимок с прокруткой").message(message).stop_scroll()
}

#[cfg(windows)]
mod engine {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::sleep;
    use std::time::Duration;

    use image::RgbaImage;
    use shoter_core::stitch::{self, Step, Stitcher};
    use shoter_core::Rect;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationScrollPattern, UIA_ScrollPatternId, UIA_ScrollPatternNoScroll,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

    use super::{Ending, Outcome, MAX_FRAMES, MAX_HEIGHT};
    use crate::capture;

    /// Share of the scrolling rows one step moves (the rest overlaps, for gluing).
    const STEP: f64 = 0.6;
    const WHEEL_DELTA: i32 = 120;

    pub fn session(rect: Rect, stop: &AtomicBool, progress: &dyn Fn(u32, u32)) -> Result<Outcome, String> {
        if rect.width < 32 || rect.height < 48 {
            return Err("слишком маленькая область для прокрутки".into());
        }
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
        let result = capture_scrolling(rect, stop, progress);
        if com {
            unsafe { CoUninitialize() };
        }
        result
    }

    fn capture_scrolling(rect: Rect, stop: &AtomicBool, progress: &dyn Fn(u32, u32)) -> Result<Outcome, String> {
        // Let the overlay disappear from the screen.
        sleep(Duration::from_millis(250));
        let cursor = capture::cursor_position();
        let mut scroller = Scroller::find(rect);
        log::info!("scrolling capture of {rect:?} via {}", scroller.name());
        let result = glue(rect, &mut scroller, stop, progress);
        scroller.restore();
        unsafe {
            let _ = SetCursorPos(cursor.0, cursor.1);
        }
        result
    }

    fn glue(rect: Rect, sc: &mut Scroller, stop: &AtomicBool, progress: &dyn Fn(u32, u32)) -> Result<Outcome, String> {
        sc.to_top(rect, stop)?;
        let mut st = Stitcher::new(settle(rect, stop)?, MAX_HEIGHT);
        let mut frames = 1;
        progress(frames, st.height());
        let mut retries = 0;
        let ending = loop {
            if stop.load(Ordering::SeqCst) {
                break Ending::Stopped;
            }
            if frames >= MAX_FRAMES {
                break Ending::Limit;
            }
            let step = ((st.scrolling_rows() as f64 * STEP) as u32).max(16);
            let before = sc.position();
            if !sc.down(step) {
                break if frames == 1 { Ending::NotScrollable } else { Ending::End };
            }
            let frame = settle(rect, stop)?;
            let expected = sc.moved_since(before);
            match st.push(frame.clone(), expected) {
                Step::Added { shift, .. } => {
                    sc.learn(shift);
                    retries = 0;
                    frames += 1;
                    progress(frames, st.height());
                }
                Step::Unchanged => break if frames == 1 { Ending::NotScrollable } else { Ending::End },
                Step::Full => break Ending::Limit,
                Step::NoMatch => {
                    // UI Automation tells exactly how far the page went — trust it.
                    if let (true, Some(shift)) = (sc.is_exact(), expected.filter(|&e| e > 0)) {
                        log::info!("scrolling capture: no visual match, using the reported shift {shift}");
                        if st.push_shifted(frame, shift) == Step::Full {
                            break Ending::Limit;
                        }
                        frames += 1;
                        progress(frames, st.height());
                        continue;
                    }
                    // The wheel went too far: back, and smaller steps.
                    if retries < 2 && sc.back_off() {
                        retries += 1;
                        let _ = settle(rect, stop)?;
                        continue;
                    }
                    break Ending::Lost;
                }
            }
        };
        log::info!("scrolling capture: {frames} frames, {} px, {ending:?}", st.height());
        Ok(Outcome { image: st.finish(), ending })
    }

    /// The area as soon as it stops moving (smooth scrolling, lazy loading), or after ~1 s.
    fn settle(rect: Rect, stop: &AtomicBool) -> Result<RgbaImage, String> {
        sleep(Duration::from_millis(120));
        let mut last = capture::grab(rect)?;
        for _ in 0..12 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            sleep(Duration::from_millis(70));
            let next = capture::grab(rect)?;
            if stitch::nearly_same(&last, &next) {
                return Ok(next);
            }
            last = next;
        }
        Ok(last)
    }

    enum Scroller {
        /// UI Automation scroll pattern of the scrolling element; `viewport` — its height (px).
        Uia { _automation: IUIAutomation, pattern: IUIAutomationScrollPattern, start: f64, viewport: f64 },
        /// Mouse wheel at `at`; `per_notch` — pixels one notch scrolls, once known.
        Wheel { at: (i32, i32), notches: i32, per_notch: Option<f64> },
    }

    impl Scroller {
        fn find(rect: Rect) -> Self {
            match uia_scroller(rect) {
                Some(s) => {
                    park_cursor(rect);
                    s
                }
                None => {
                    // Over the content, near the right edge (away from the middle of the page).
                    let at = (rect.right() - (rect.width as i32 / 8).clamp(8, 60), rect.y + rect.height as i32 / 2);
                    Scroller::Wheel { at, notches: 3, per_notch: None }
                }
            }
        }

        fn name(&self) -> &'static str {
            match self {
                Scroller::Uia { .. } => "UI Automation",
                Scroller::Wheel { .. } => "the mouse wheel",
            }
        }

        fn is_exact(&self) -> bool {
            matches!(self, Scroller::Uia { .. })
        }

        fn to_top(&mut self, rect: Rect, stop: &AtomicBool) -> Result<(), String> {
            match self {
                Scroller::Uia { pattern, .. } => unsafe {
                    let _ = pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, 0.0);
                },
                Scroller::Wheel { at, .. } => {
                    // Up until nothing moves any more.
                    let mut last = capture::grab(rect)?;
                    for _ in 0..40 {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        wheel(*at, 15);
                        let next = settle(rect, stop)?;
                        if stitch::nearly_same(&last, &next) {
                            break;
                        }
                        last = next;
                    }
                }
            }
            Ok(())
        }

        /// Scroll position, percent (UI Automation only).
        fn position(&self) -> Option<f64> {
            match self {
                Scroller::Uia { pattern, .. } => unsafe { pattern.CurrentVerticalScrollPercent() }.ok().filter(|p| *p >= 0.0),
                Scroller::Wheel { .. } => None,
            }
        }

        /// Pixels per scroll percent (UI Automation), from the visible share of the content.
        fn px_per_percent(&self) -> Option<f64> {
            match self {
                Scroller::Uia { pattern, viewport, .. } => {
                    let view = unsafe { pattern.CurrentVerticalViewSize() }.ok().filter(|v| *v > 0.0 && *v < 100.0)?;
                    Some(viewport * (100.0 / view - 1.0) / 100.0)
                }
                Scroller::Wheel { .. } => None,
            }
        }

        /// Scrolls down by about `px`; `false` — already at the end.
        fn down(&mut self, px: u32) -> bool {
            let percent = self.position();
            let per_percent = self.px_per_percent();
            match self {
                Scroller::Uia { pattern, .. } => {
                    let (Some(p), Some(k)) = (percent, per_percent) else { return false };
                    if p >= 99.95 {
                        return false;
                    }
                    let target = (p + px as f64 / k).min(100.0);
                    unsafe { pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, target) }.is_ok()
                }
                Scroller::Wheel { at, notches, per_notch } => {
                    if let Some(per) = per_notch {
                        *notches = ((px as f64 / *per).round() as i32).clamp(1, 25);
                    }
                    wheel(*at, -*notches);
                    true
                }
            }
        }

        /// How far the content should have moved since `before` (the scroll position).
        fn moved_since(&self, before: Option<f64>) -> Option<u32> {
            match self {
                Scroller::Uia { .. } => {
                    let moved = (self.position()? - before?) * self.px_per_percent()?;
                    (moved >= 1.0).then(|| moved.round() as u32)
                }
                Scroller::Wheel { notches, per_notch, .. } => per_notch.map(|p| (p * *notches as f64).round() as u32),
            }
        }

        /// A glued step tells how far one wheel notch goes.
        fn learn(&mut self, shift: u32) {
            if let Scroller::Wheel { notches, per_notch, .. } = self {
                *per_notch = Some(shift as f64 / *notches as f64);
            }
        }

        /// Wheel only: undoes the last step and makes the next ones smaller.
        fn back_off(&mut self) -> bool {
            match self {
                Scroller::Wheel { at, notches, per_notch } => {
                    wheel(*at, *notches);
                    *notches = (*notches / 2).max(1);
                    // The learned distance was for a bigger step; learn it anew.
                    *per_notch = None;
                    true
                }
                Scroller::Uia { .. } => false,
            }
        }

        /// Puts the page back where it was (UI Automation).
        fn restore(&self) {
            if let Scroller::Uia { pattern, start, .. } = self {
                unsafe {
                    let _ = pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, *start);
                }
            }
        }
    }

    /// The nearest element under the middle of the area that scrolls vertically.
    fn uia_scroller(rect: Rect) -> Option<Scroller> {
        let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
        let (cx, cy) = rect.center();
        let own = std::process::id() as i32;
        let walker = unsafe { automation.ControlViewWalker() }.ok()?;
        let mut element = unsafe { automation.ElementFromPoint(POINT { x: cx, y: cy }) }.ok()?;
        for _ in 0..40 {
            if unsafe { element.CurrentProcessId() }.ok() == Some(own) {
                return None;
            }
            if let Ok(pattern) = unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }
                && unsafe { pattern.CurrentVerticallyScrollable() }.is_ok_and(|v| v.as_bool())
            {
                let start = unsafe { pattern.CurrentVerticalScrollPercent() }.ok().filter(|p| *p >= 0.0)?;
                let viewport = unsafe { element.CurrentBoundingRectangle() }
                    .ok()
                    .map(|r| (r.bottom - r.top) as f64)
                    .filter(|h| *h > 0.0)
                    .unwrap_or(rect.height as f64);
                return Some(Scroller::Uia { _automation: automation, pattern, start, viewport });
            }
            element = unsafe { walker.GetParentElement(&element) }.ok()?;
        }
        None
    }

    /// Mouse wheel at `at`: `notches` > 0 — up, < 0 — down.
    fn wheel(at: (i32, i32), notches: i32) {
        unsafe {
            let _ = SetCursorPos(at.0, at.1);
        }
        let one = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT { mouseData: (notches.signum() * WHEEL_DELTA) as u32, dwFlags: MOUSEEVENTF_WHEEL, ..Default::default() },
            },
        };
        let inputs = vec![one; notches.unsigned_abs() as usize];
        unsafe {
            SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    /// Takes the cursor off the area, so hover effects do not change the frames.
    fn park_cursor(rect: Rect) {
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let (cx, cy) = rect.center();
        let spots = [(rect.right() + 4, cy), (rect.x - 5, cy), (cx, rect.bottom() + 4), (cx, rect.y - 5)];
        if let Some(&(x, y)) = spots.iter().find(|&&(x, y)| x >= vx && y >= vy && x < vx + vw && y < vy + vh) {
            unsafe {
                let _ = SetCursorPos(x, y);
            }
        }
    }
}

#[cfg(not(windows))]
mod engine {
    use std::sync::atomic::AtomicBool;

    use super::Outcome;

    pub fn session(_rect: shoter_core::Rect, _stop: &AtomicBool, _progress: &dyn Fn(u32, u32)) -> Result<Outcome, String> {
        Err("Снимок с прокруткой пока поддерживается только в Windows".into())
    }
}

