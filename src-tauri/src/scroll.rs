//! Scrolling capture: AShot scrolls the chosen area itself and glues the frames together
//! (`shoter_core::stitch`). First it runs to the bottom of the page, a screen at a time, so
//! lazily loaded pictures arrive; then back to the top, and down again with the mouse wheel,
//! taking the frames. How far a notch goes and where the page ends are decided from the
//! picture alone. When the content under the selection offers UI Automation scrolling
//! (browsers, Explorer, Office), it does the run to the bottom and back without the cursor,
//! finds where the wheel scrolls that content and nothing inside it, and puts the page back
//! where it was afterwards.
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
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationScrollPattern, ScrollAmount_LargeIncrement,
        ScrollAmount_NoAmount, UIA_ScrollPatternId, UIA_ScrollPatternNoScroll,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSEINPUT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

    use super::{Ending, Outcome, Progress, CANCELLED, MAX_FRAMES, MAX_HEIGHT};
    use crate::capture;

    /// Share of the scrolling rows one step moves (the rest overlaps, for gluing).
    const STEP: f64 = 0.55;
    const WHEEL_DELTA: i32 = 120;
    /// Most wheel notches in one step.
    const MAX_NOTCHES: i32 = 25;
    /// Wheel notches per screen while running to the bottom without UI Automation.
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

    /// Down with the wheel a step at a time, gluing each frame. Every decision is made from the
    /// picture: how far a notch goes (learned from the glued frames) and where the page ends
    /// (twice nothing moved). Browsers report their scroll position late, so it is not used.
    fn glue(rect: Rect, sc: &mut Scroller, stop: &AtomicBool, progress: &dyn Fn(Progress)) -> Result<Outcome, String> {
        let mut st = Stitcher::new(settle(rect, stop)?, MAX_HEIGHT);
        let mut frames = 1;
        progress(Progress::Frames(frames, st.height()));
        // Steps in a row that moved nothing / did not match.
        let (mut still, mut misses) = (0, 0);
        let ending = loop {
            if stop.load(Ordering::SeqCst) {
                break Ending::Stopped;
            }
            if frames >= MAX_FRAMES {
                break Ending::Limit;
            }
            let px = ((st.scrolling_rows() as f64 * STEP) as u32).max(16);
            // After a step that showed nothing, a bigger one: smooth scrolling that started
            // late, a notch too small to show (programs that scroll by whole lines).
            let notches = sc.down(px, if still > 0 { 2 } else { 1 });
            let frame = settle(rect, stop)?;
            let expected = sc.expected();
            let result = st.push(frame, expected);
            log::info!(
                "scrolling capture: step {frames}: {notches} notches ({} since the last frame), expected {expected:?} → {result:?}",
                sc.pending
            );
            match result {
                Step::Added { shift, .. } => {
                    sc.glued(shift);
                    (still, misses) = (0, 0);
                    frames += 1;
                    progress(Progress::Frames(frames, st.height()));
                }
                Step::Unchanged => {
                    still += 1;
                    if still >= 2 {
                        break if frames == 1 { Ending::NotScrollable } else { Ending::End };
                    }
                }
                Step::Full => break Ending::Limit,
                // Too far (or the page changed): back, and smaller steps.
                Step::NoMatch if misses < 2 => {
                    misses += 1;
                    sc.back_off();
                    let _ = settle(rect, stop)?;
                }
                Step::NoMatch => break Ending::Lost,
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
            if stitch::stopped(&last, &next) {
                return Ok(next);
            }
            last = next;
        }
        Ok(last)
    }

    fn cancelled(stop: &AtomicBool) -> Result<(), String> {
        if stop.load(Ordering::SeqCst) { Err(CANCELLED.into()) } else { Ok(()) }
    }

    /// UI Automation scroll pattern of the scrolling element: runs to the bottom and to the top
    /// without the cursor, and puts the page back afterwards.
    struct Uia {
        _automation: IUIAutomation,
        pattern: IUIAutomationScrollPattern,
    }

    struct Scroller {
        uia: Option<Uia>,
        /// Where the wheel turns: over the scrolling element (its scrollbar when it can be).
        at: (i32, i32),
        /// Where the cursor waits between the steps: off the area, so hover effects stay out
        /// of the frames.
        park: Option<(i32, i32)>,
        /// Notches turned since the last glued frame.
        pending: i32,
        /// Pixels a notch scrolls, learned from the glued frames.
        per_notch: Option<f64>,
        /// Notches per step until `per_notch` is known.
        first: i32,
        /// Most notches per step (halved after a step that went too far).
        most: i32,
    }

    impl Scroller {
        fn find(rect: Rect) -> Self {
            let park = park_spot(rect);
            let (uia, at) = match uia_scroller(rect) {
                Some((automation, element, pattern)) => {
                    let at = wheel_point(&automation, &element, rect);
                    log::info!("scrolling capture: the wheel turns at {at:?}");
                    (Some(Uia { _automation: automation, pattern }), at.unwrap_or_else(|| inside(rect)))
                }
                None => {
                    log::info!("scrolling capture of {rect:?}: no UI Automation scroll pattern, the mouse wheel only");
                    (None, inside(rect))
                }
            };
            if let Some((x, y)) = park {
                unsafe {
                    let _ = SetCursorPos(x, y);
                }
            }
            let first = (rect.height as i32 / 300).clamp(1, 3);
            Scroller { uia, at, park, pending: 0, per_notch: None, first, most: MAX_NOTCHES }
        }

        fn restore_point(&self) -> Option<(IUIAutomationScrollPattern, f64)> {
            // Nothing has scrolled yet: the reported position is current.
            let uia = self.uia.as_ref()?;
            let percent = unsafe { uia.pattern.CurrentVerticalScrollPercent() }.ok().filter(|p| *p >= 0.0)?;
            Some((uia.pattern.clone(), percent))
        }

        /// To the bottom a screen at a time, so lazily loaded pictures come in on the way (as
        /// far as the capture can go anyway). The bottom: twice nothing moved.
        fn preload(&mut self, rect: Rect, stop: &AtomicBool) -> Result<(), String> {
            let started = Instant::now();
            let max_steps = MAX_HEIGHT / rect.height.max(1) + 4;
            let (mut steps, mut still) = (0, 0);
            let mut last = capture::grab(rect)?;
            while steps < max_steps && started.elapsed() < Duration::from_secs(40) {
                cancelled(stop)?;
                let paged = self.uia.as_ref().is_some_and(|u| unsafe { u.pattern.Scroll(ScrollAmount_NoAmount, ScrollAmount_LargeIncrement) }.is_ok());
                if !paged {
                    self.wheel(-PRELOAD_NOTCHES);
                }
                sleep(PRELOAD_PAUSE);
                steps += 1;
                let next = capture::grab(rect)?;
                if stitch::stopped(&last, &next) {
                    still += 1;
                    if still >= 2 {
                        break;
                    }
                } else {
                    still = 0;
                }
                last = next;
            }
            log::info!("scrolling capture: preloaded {steps} screens in {:?}", started.elapsed());
            // The last pictures.
            sleep(Duration::from_millis(400));
            cancelled(stop)
        }

        /// To the top: UI Automation jumps there; the wheel makes sure (up until nothing moves —
        /// the jump may be missing, or land short on a page that grew).
        fn to_top(&mut self, rect: Rect, stop: &AtomicBool) -> Result<(), String> {
            if let Some(uia) = &self.uia {
                unsafe {
                    let _ = uia.pattern.SetScrollPercent(UIA_ScrollPatternNoScroll, 0.0);
                }
            }
            let mut last = settle(rect, stop)?;
            for _ in 0..60 {
                cancelled(stop)?;
                self.wheel(MAX_NOTCHES);
                let next = settle(rect, stop)?;
                if stitch::stopped(&last, &next) {
                    break;
                }
                last = next;
            }
            cancelled(stop)
        }

        /// Turns the wheel down for about `px` (× `boost`); the notches turned.
        fn down(&mut self, px: u32, boost: i32) -> i32 {
            let n = self.per_notch.map_or(self.first, |p| (px as f64 / p).round() as i32);
            let n = (n.max(1) * boost).clamp(1, self.most);
            self.wheel(-n);
            self.pending += n;
            n
        }

        /// How far the content should have moved since the last glued frame, once known.
        fn expected(&self) -> Option<u32> {
            self.per_notch.map(|p| (p * self.pending as f64).round() as u32)
        }

        /// A frame was glued, `shift` rows lower: that is what the notches since the last one did.
        fn glued(&mut self, shift: u32) {
            if self.pending > 0 {
                let per = shift as f64 / self.pending as f64;
                // The last step may stop short at the end of the page: lean to the latest step,
                // without forgetting the earlier ones.
                self.per_notch = Some(self.per_notch.map_or(per, |old| old * 0.3 + per * 0.7));
            }
            self.pending = 0;
        }

        /// Undoes the steps since the last glued frame and makes the next ones smaller.
        fn back_off(&mut self) {
            let last = self.pending;
            self.wheel(self.pending);
            self.pending = 0;
            self.most = (last / 2).max(1);
        }

        /// Turns the wheel at `at`, `notches` > 0 — up, < 0 — down, and takes the cursor back to
        /// `park`. One input batch, so the wheel goes where the cursor was put for it.
        fn wheel(&self, notches: i32) {
            if notches == 0 {
                return;
            }
            let notch = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT { mouseData: (notches.signum() * WHEEL_DELTA) as u32, dwFlags: MOUSEEVENTF_WHEEL, ..Default::default() },
                },
            };
            let mut inputs = vec![move_to(self.at)];
            inputs.extend(std::iter::repeat_n(notch, notches.unsigned_abs() as usize));
            inputs.extend(self.park.map(move_to));
            unsafe {
                SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
            }
        }
    }

    /// The nearest element under the middle of the area that scrolls vertically.
    fn uia_scroller(rect: Rect) -> Option<(IUIAutomation, IUIAutomationElement, IUIAutomationScrollPattern)> {
        let automation: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
        let (element, pattern) = scroller_at(&automation, rect.center())?;
        let percent = unsafe { pattern.CurrentVerticalScrollPercent() }.unwrap_or(-1.0);
        let visible = unsafe { pattern.CurrentVerticalViewSize() }.unwrap_or(-1.0);
        let class = unsafe { element.CurrentClassName() }.map(|s| s.to_string()).unwrap_or_default();
        let bounds = unsafe { element.CurrentBoundingRectangle() }.ok();
        log::info!("scrolling capture of {rect:?}: UI Automation element {class:?} {bounds:?}, at {percent:.2}%, {visible:.2}% visible");
        Some((automation, element, pattern))
    }

    /// The nearest element at the point (or above it) that scrolls vertically.
    fn scroller_at(automation: &IUIAutomation, (x, y): (i32, i32)) -> Option<(IUIAutomationElement, IUIAutomationScrollPattern)> {
        let own = std::process::id() as i32;
        let walker = unsafe { automation.ControlViewWalker() }.ok()?;
        let mut element = unsafe { automation.ElementFromPoint(POINT { x, y }) }.ok()?;
        for _ in 0..40 {
            if unsafe { element.CurrentProcessId() }.ok() == Some(own) {
                return None;
            }
            if let Ok(pattern) = unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) }
                && unsafe { pattern.CurrentVerticallyScrollable() }.is_ok_and(|v| v.as_bool())
            {
                return Some((element, pattern));
            }
            element = unsafe { walker.GetParentElement(&element) }.ok()?;
        }
        None
    }

    /// A point where the wheel scrolls `target` itself (not a scrolling box inside it, a map,
    /// an embedded page): its scrollbar, else a spot in the area near its sides.
    fn wheel_point(automation: &IUIAutomation, target: &IUIAutomationElement, rect: Rect) -> Option<(i32, i32)> {
        let (cx, cy) = rect.center();
        let inset = (rect.width as i32 / 8).clamp(8, 60);
        let mut spots = Vec::new();
        if let Ok(b) = unsafe { target.CurrentBoundingRectangle() }
            && b.right - b.left > 40
            && b.bottom - b.top > 60
        {
            spots.push((b.right - 7, cy.clamp(b.top + 20, b.bottom - 21)));
        }
        spots.extend([(rect.right() - inset, cy), (rect.x + inset, cy), (cx, cy), (cx, rect.y + rect.height as i32 / 4)]);
        spots.into_iter().find(|&spot| {
            scroller_at(automation, spot).is_some_and(|(element, _)| unsafe { automation.CompareElements(&element, target) }.is_ok_and(|same| same.as_bool()))
        })
    }

    /// Over the content, near the right edge (away from the middle of the page).
    fn inside(rect: Rect) -> (i32, i32) {
        (rect.right() - (rect.width as i32 / 8).clamp(8, 60), rect.y + rect.height as i32 / 2)
    }

    fn virtual_screen() -> (i32, i32, i32, i32) {
        unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        }
    }

    /// Just outside the area, on a screen.
    fn park_spot(rect: Rect) -> Option<(i32, i32)> {
        let (vx, vy, vw, vh) = virtual_screen();
        let (cx, cy) = rect.center();
        let spots = [(rect.right() + 4, cy), (rect.x - 5, cy), (cx, rect.bottom() + 4), (cx, rect.y - 5)];
        spots.into_iter().find(|&(x, y)| x >= vx && y >= vy && x < vx + vw && y < vy + vh)
    }

    /// A cursor move to `(x, y)` (virtual-screen pixels) as input.
    fn move_to((x, y): (i32, i32)) -> INPUT {
        let (vx, vy, vw, vh) = virtual_screen();
        let norm = |v: i32, origin: i32, size: i32| (((v - origin) as i64 * 65535 + (size as i64 - 1) / 2) / (size as i64 - 1).max(1)) as i32;
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: norm(x, vx, vw),
                    dy: norm(y, vy, vh),
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    ..Default::default()
                },
            },
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

