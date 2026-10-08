//! Clipboard helpers. The clipboard can be briefly locked by other applications,
//! so every write is retried a few times. arboard writes CF_DIBV5 + "PNG" on Windows,
//! which works for Office, messengers, browsers and image editors.

use std::borrow::Cow;
use std::time::Duration;

use image::RgbaImage;

fn with_retry<T>(mut f: impl FnMut() -> Result<T, arboard::Error>) -> Result<T, String> {
    let mut last = None;
    for attempt in 0..6 {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    Err(format!("буфер обмена занят: {}", last.map(|e| e.to_string()).unwrap_or_default()))
}

pub async fn set_image(image: RgbaImage) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (w, h) = image.dimensions();
        let raw = image.into_raw();
        with_retry(|| {
            let mut cb = arboard::Clipboard::new()?;
            cb.set_image(arboard::ImageData { width: w as usize, height: h as usize, bytes: Cow::Borrowed(&raw) })
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn set_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_retry(|| {
            let mut cb = arboard::Clipboard::new()?;
            cb.set_text(text.clone())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
