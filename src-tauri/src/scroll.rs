//! Scrolling capture: AShot scrolls the chosen area itself and glues the frames together
//! (`shoter_core::stitch`). First it runs to the bottom of the page, a screen at a time, so
//! lazily loaded pictures arrive; then back to the top, and down again taking the frames.
//! It scrolls through UI Automation when the content under the selection offers it
//! (browsers, Explorer, Office) — the page goes back where it was afterwards — otherwise
//! with the mouse wheel. How far a step goes is learned from the glued frames.
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

/// Esc before any frame was taken (while the page was loading): nothing to keep.
pub const CANCELLED: &str = "снимок с прокруткой отменён";

/// What the progress toast shows.
#[derive(Debug, Clone, Copy)]
pub enum Progress {
    /// Running to the bottom so the pictures load.
    Preloading,
    /// Back to the top.
    ToTop,
    /// Frames glued, the picture's height.
    Frames(u32, u32),
}

/// Scrolls and glues `rect` (virtual-screen coordinates, one monitor; the overlay is already
/// hidden). Returns when the page ends or the user stops it; `Err(CANCELLED)` — Esc before
/// the first frame.
pub async fn run(app: &AppHandle, rect: Rect) -> Result<Outcome, String> {
    let stop = Arc::new(AtomicBool::new(false));
    *app.state::<AppState>().scroll_stop.lock().unwrap() = Some(stop.clone());
    let esc = register_esc(app).await;
    ui::toast(app, progress_toast(Progress::Preloading));

    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    let flag = stop.clone();
    let spawned = std::thread::Builder::new().name("scroll-capture".into()).spawn(move || {
        let progress = |p: Progress| ui::toast(&handle, progress_toast(p));
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

fn progress_toast(progress: Progress) -> Toast {
    let message = match progress {
        Progress::Preloading => "Прогружаю страницу: до конца и обратно, чтобы загрузились картинки. Esc — отмена".to_string(),
        Progress::ToTop => "Возвращаюсь в начало… Esc — отмена".to_string(),
        Progress::Frames(frames, height) => {
            format!("{frames} {} · {height} px · Esc — остановить", shoter_core::plural(frames as u64, "кадр", "кадра", "кадров"))
        }
    };
    Toast::progress("Снимок с прокруткой").message(message).stop_scroll()
}

#[cfg(windows)]
mod engine {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread::sleep;
    use std::time::{Duration, Instant};

    use image::RgbaImage;
    use shoter_core::stitch::{self, Step, Stitcher};
    use shoter_core::Rect;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationScrollPattern, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
        ScrollAmount_SmallIncrement, UIA_ScrollPatternId, UIA_ScrollPatternNoScroll,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

    use super::{Ending, Outcome, Progress, CANCELLED, MAX_FRAMES, MAX_HEIGHT};
    use crate::capture;

    /// Share of the scrolling rows one step moves (the rest overlaps, for gluing).
    const STEP: f64 = 0.55;
    const WHEEL_DELTA: i32 = 120;
    /// Wheel notches per step while running to the bottom (about a screen in browsers).
    const PRELOAD_NOTCHES: i32 = 6;
    /// Time for lazily loaded pictures to appear after each screen of the preload run.
    const PRELOAD_PAUSE: Duration = Duration::from_millis(250);

    pub fn session(rect: Rect, stop: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Outcome, String> {
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

    fn capture_scrolling(rect: Rect, stop: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Outcome, String> {
        // Let the overlay disappear from the screen.
        sleep(Duration::from_millis(250));
        let cursor = capture::cursor_position();
        let mut scroller = Scroller::find(rect);
        // Where the page was, to put it back (UI Automation only).
        let restore = scroller.restore_point();
        let result = (|| {
            progress(Progress::Preloading);
            scroller.preload(rect, stop)?;
            progress(Progress::ToTop);
            scroller.to_top(rect, stop)?;
            glue(rect, &mut scroller, stop, progress)
        })();
        if let Some((pattern, percent)) = restore {
            unsafe {
                let _ = pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, percent);
            }
        }
        unsafe {
            let _ = SetCursorPos(cursor.0, cursor.1);
        }
        if let Err(e) = &result {
            log::info!("scrolling capture: {e}");
        }
        result
    }

    fn glue(rect: Rect, sc: &mut Scroller, stop: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Outcome, String> {
        let mut st = Stitcher::new(settle(rect, stop)?, MAX_HEIGHT);
        let mut frames = 1;
        progress(Progress::Frames(frames, st.height()));
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
            let Some(how) = sc.down(step) else {
                log::info!("scrolling capture: the scroll position is at the end");
                break if frames == 1 { Ending::NotScrollable } else { Ending::End };
            };
            let frame = settle(rect, stop)?;
            let expected = sc.moved_since(before);
            let result = st.push(frame.clone(), expected);
            log::info!("scrolling capture: step {frames}: {how}, expected {expected:?} → {result:?}");
            match result {
                Step::Added { shift, .. } => {
                    sc.learn(shift, before);
                    retries = 0;
                    frames += 1;
                    progress(Progress::Frames(frames, st.height()));
                }
                // UI Automation moved, the picture did not: some programs report a scroll
                // position they do not show — the wheel then.
                Step::Unchanged if frames == 1 && sc.is_uia() => {
                    log::info!("scrolling capture: nothing moved through UI Automation, trying the mouse wheel");
                    *sc = Scroller::wheel(rect);
                }
                Step::Unchanged => break if frames == 1 { Ending::NotScrollable } else { Ending::End },
                Step::Full => break Ending::Limit,
                Step::NoMatch => {
                    // UI Automation tells how far the page went once that is learned — trust it.
                    if let (true, Some(shift)) = (sc.is_calibrated(), expected.filter(|&e| e > 0)) {
                        log::info!("scrolling capture: no visual match, using the reported shift {shift}");
                        if st.push_shifted(frame, shift) == Step::Full {
                            break Ending::Limit;
                        }
                        frames += 1;
                        progress(Progress::Frames(frames, st.height()));
                        continue;
                    }
                    // Too far: back, and smaller steps.
                    if retries < 2 && sc.back_off(before) {
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

    /// The area as soon as it stops moving (smooth scrolling, pictures loading), or after ~1 s.
    fn settle(rect: Rect, stop: &AtomicBool) -> Result<RgbaImage, String> {
        sleep(Duration::from_millis(150));
        let mut last = capture::grab(rect)?;
        for _ in 0..12 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            sleep(Duration::from_millis(80));
            let next = capture::grab(rect)?;
            if stitch::nearly_same(&last, &next) {
                return Ok(next);
            }
            last = next;
        }
        Ok(last)
    }

    fn cancelled(stop: &AtomicBool) -> Result<(), String> {
        if stop.load(Ordering::SeqCst) { Err(CANCELLED.into()) } else { Ok(()) }
    }

    enum Scroller {
        /// UI Automation scroll pattern of the scrolling element. `per_percent` — pixels per
        /// scroll percent, learned from the glued steps (the reported page size is not
        /// trusted: browsers differ in what they report).
        Uia { _automation: IUIAutomation, pattern: IUIAutomationScrollPattern, per_percent: Option<f64> },
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
                    log::info!("scrolling capture of {rect:?}: no UI Automation scroll pattern, using the mouse wheel");
                    Self::wheel(rect)
                }
            }
        }

        fn wheel(rect: Rect) -> Self {
            // Over the content, near the right edge (away from the middle of the page).
            let at = (rect.right() - (rect.width as i32 / 8).clamp(8, 60), rect.y + rect.height as i32 / 2);
            Scroller::Wheel { at, notches: 3, per_notch: None }
        }

        fn is_uia(&self) -> bool {
            matches!(self, Scroller::Uia { .. })
        }

        /// The scroll position reports exactly how far a step went (UI Automation, learned).
        fn is_calibrated(&self) -> bool {
            matches!(self, Scroller::Uia { per_percent: Some(_), .. })
        }

        fn restore_point(&self) -> Option<(IUIAutomationScrollPattern, f64)> {
            match self {
                Scroller::Uia { pattern, .. } => Some((pattern.clone(), self.position()?)),
                Scroller::Wheel { .. } => None,
            }
        }

        /// Scroll position, percent (UI Automation only).
        fn position(&self) -> Option<f64> {
            match self {
                Scroller::Uia { pattern, .. } => unsafe { pattern.CurrentVerticalScrollPercent() }.ok().filter(|p| *p >= 0.0),
                Scroller::Wheel { .. } => None,
            }
        }

        /// To the bottom a screen at a time, so lazily loaded pictures come in on the way
        /// (as far as the capture can go anyway).
        fn preload(&mut self, rect: Rect, stop: &AtomicBool) -> Result<(), String> {
            let started = Instant::now();
            let max_steps = MAX_HEIGHT / rect.height.max(1) + 4;
            let mut steps = 0;
            match self {
                Scroller::Uia { pattern, .. } => {
                    let pattern = pattern.clone();
                    while steps < max_steps && started.elapsed() < Duration::from_secs(40) {
                        cancelled(stop)?;
                        let Some(p) = self.position().filter(|p| *p < 99.9) else { break };
                        // A page down.
                        if unsafe { pattern.Scroll(ScrollAmount_NoAmount, ScrollAmount_LargeIncrement) }.is_err() {
                            break;
                        }
                        sleep(PRELOAD_PAUSE);
                        steps += 1;
                        if self.position().is_none_or(|now| (now - p).abs() < 0.001) {
                            break;
                        }
                    }
                }
                Scroller::Wheel { at, .. } => {
                    let mut last = capture::grab(rect)?;
                    let mut still = 0;
                    while steps < max_steps && started.elapsed() < Duration::from_secs(40) {
                        cancelled(stop)?;
                        wheel(*at, -PRELOAD_NOTCHES);
                        sleep(PRELOAD_PAUSE);
                        steps += 1;
                        let next = capture::grab(rect)?;
                        // Twice nothing moved: the bottom.
                        if stitch::nearly_same(&last, &next) {
                            still += 1;
                            if still >= 2 {
                                break;
                            }
                        } else {
                            still = 0;
                        }
                        last = next;
                    }
                }
            }
            log::info!("scrolling capture: preloaded {steps} screens in {:?}", started.elapsed());
            // The last pictures.
            sleep(Duration::from_millis(400));
            cancelled(stop)
        }

        fn to_top(&mut self, rect: Rect, stop: &AtomicBool) -> Result<(), String> {
            match self {
                Scroller::Uia { pattern, .. } => unsafe {
                    let _ = pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, 0.0);
                },
                Scroller::Wheel { at, .. } => {
                    // Up until nothing moves any more.
                    let mut last = capture::grab(rect)?;
                    for _ in 0..60 {
                        cancelled(stop)?;
                        wheel(*at, 25);
                        let next = settle(rect, stop)?;
                        if stitch::nearly_same(&last, &next) {
                            break;
                        }
                        last = next;
                    }
                }
            }
            cancelled(stop)
        }

        /// Scrolls down by about `px`; what it did (for the log), `None` — already at the end.
        fn down(&mut self, px: u32) -> Option<String> {
            let percent = self.position();
            match self {
                Scroller::Uia { pattern, per_percent, .. } => {
                    let p = percent?;
                    if p >= 99.95 {
                        return None;
                    }
                    if let Some(k) = *per_percent {
                        let target = (p + px as f64 / k).min(100.0);
                        if unsafe { pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, target) }.is_ok() {
                            return Some(format!("UI Automation {p:.2}% → {target:.2}%"));
                        }
                    }
                    // The step size is not known yet: a few lines (or 1%), then it is learned.
                    if small_steps(pattern, 3) {
                        return Some(format!("UI Automation, 3 lines from {p:.2}% (calibration)"));
                    }
                    let target = (p + 1.0).min(100.0);
                    unsafe { pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, target) }
                        .is_ok()
                        .then(|| format!("UI Automation {p:.2}% → {target:.2}% (calibration)"))
                }
                Scroller::Wheel { at, notches, per_notch } => {
                    if let Some(per) = per_notch {
                        *notches = ((px as f64 / *per).round() as i32).clamp(1, 25);
                    }
                    wheel(*at, -*notches);
                    Some(format!("wheel {} notches", *notches))
                }
            }
        }

        /// How far the content should have moved since `before` (the scroll position), once
        /// the step size is learned.
        fn moved_since(&self, before: Option<f64>) -> Option<u32> {
            match self {
                Scroller::Uia { per_percent: Some(k), .. } => {
                    let moved = (self.position()? - before?) * k;
                    (moved >= 1.0).then(|| moved.round() as u32)
                }
                Scroller::Uia { .. } => None,
                Scroller::Wheel { notches, per_notch, .. } => per_notch.map(|p| (p * *notches as f64).round() as u32),
            }
        }

        /// A glued step tells how far the scrolling goes.
        fn learn(&mut self, shift: u32, before: Option<f64>) {
            let now = self.position();
            match self {
                Scroller::Uia { per_percent, .. } => {
                    if let (Some(now), Some(before)) = (now, before)
                        && now - before > 0.0001
                    {
                        let k = shift as f64 / (now - before);
                        // The page may grow while pictures load: lean to the latest step.
                        *per_percent = Some(per_percent.map_or(k, |old| old * 0.3 + k * 0.7));
                    }
                }
                Scroller::Wheel { notches, per_notch, .. } => *per_notch = Some(shift as f64 / *notches as f64),
            }
        }

        /// Undoes the last step and makes the next ones smaller.
        fn back_off(&mut self, before: Option<f64>) -> bool {
            match self {
                Scroller::Wheel { at, notches, per_notch } => {
                    wheel(*at, *notches);
                    *notches = (*notches / 2).max(1);
                    // The learned distance was for a bigger step; learn it anew.
                    *per_notch = None;
                    true
                }
                Scroller::Uia { pattern, per_percent, .. } => {
                    let Some(before) = before else { return false };
                    unsafe {
                        let _ = pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, before);
                    }
                    // Learn the step again, from a small one.
                    *per_percent = None;
                    true
                }
            }
        }
    }

    fn small_steps(pattern: &IUIAutomationScrollPattern, n: usize) -> bool {
        (0..n).all(|_| unsafe { pattern.Scroll(ScrollAmount_NoAmount, ScrollAmount_SmallIncrement) }.is_ok())
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
                let percent = unsafe { pattern.CurrentVerticalScrollPercent() }.ok().filter(|p| *p >= 0.0)?;
                let visible = unsafe { pattern.CurrentVerticalViewSize() }.unwrap_or(-1.0);
                let class = unsafe { element.CurrentClassName() }.map(|s| s.to_string()).unwrap_or_default();
                let bounds = unsafe { element.CurrentBoundingRectangle() }.ok();
                log::info!(
                    "scrolling capture of {rect:?}: UI Automation element {class:?} {bounds:?}, at {percent:.2}%, {visible:.2}% visible"
                );
                return Some(Scroller::Uia { _automation: automation, pattern, per_percent: None });
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

    use super::{Outcome, Progress};

    pub fn session(_rect: shoter_core::Rect, _stop: &AtomicBool, _progress: &dyn Fn(Progress)) -> Result<Outcome, String> {
        Err("Снимок с прокруткой пока поддерживается только в Windows".into())
    }
}

