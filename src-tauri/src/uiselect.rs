//! Hit-testing of windows and UI elements (buttons, panels, lists…) under the cursor,
//! powered by `snow-ui-selector` (UI Automation). The service is COM-apartment bound,
//! so it lives on its own thread and is driven through a channel.

use std::sync::mpsc;
use std::sync::Mutex;

use shoter_core::Rect;
use snow_ui_selector::{ElementRegionService, HitTestMode, Point, QueryControl};

enum Request {
    Refresh(Vec<usize>),
    Query { x: i32, y: i32, reply: tokio::sync::oneshot::Sender<Vec<Rect>> },
    Release,
}

pub struct UiSelector {
    tx: Mutex<mpsc::Sender<Request>>,
}

impl UiSelector {
    pub fn spawn() -> Self {
        let (tx, rx) = mpsc::channel::<Request>();
        let spawned = std::thread::Builder::new().name("ui-selector".into()).spawn(move || {
            let mut service = match ElementRegionService::new() {
                Ok(s) => Some(s),
                Err(e) => {
                    log::warn!("UI element selection is unavailable: {e}");
                    None
                }
            };
            while let Ok(request) = rx.recv() {
                match request {
                    Request::Refresh(excluded) => {
                        if let Some(s) = service.as_mut() {
                            if let Err(e) = s.refresh_excluding_ids(&excluded) {
                                log::warn!("ui-selector refresh failed: {e}");
                            }
                        }
                    }
                    Request::Query { x, y, reply } => {
                        let rects = service
                            .as_mut()
                            .and_then(|s| {
                                s.query(
                                    Point { x, y, ..Default::default() },
                                    HitTestMode::UiElement,
                                    &QueryControl::foreground(),
                                    &mut |_| {},
                                )
                                .ok()
                            })
                            .and_then(|r| r.path)
                            .unwrap_or_default()
                            .into_iter()
                            .filter(|e| e.width() > 0 && e.height() > 0)
                            .map(|e| Rect::new(e.left(), e.top(), e.width() as u32, e.height() as u32))
                            .collect();
                        let _ = reply.send(rects);
                    }
                    Request::Release => {
                        if let Some(s) = service.as_mut() {
                            s.release_cache();
                        }
                    }
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
