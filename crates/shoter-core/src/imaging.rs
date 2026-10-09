//! Pure image operations: composing multi-monitor captures, cropping, thumbnails, encoding.

use std::io::Cursor;

use image::codecs::bmp::BmpEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ExtendedColorType, ImageEncoder, Rgba, RgbaImage};

use crate::geometry::Rect;

#[derive(Debug, thiserror::Error)]
pub enum ImagingError {
    #[error("ошибка кодирования изображения: {0}")]
    Image(#[from] image::ImageError),
    #[error("пустая область")]
    EmptyRegion,
}

pub type Result<T> = std::result::Result<T, ImagingError>;

/// Capture of a single monitor, positioned in virtual-screen physical coordinates.
#[derive(Clone)]
pub struct MonitorShot {
    pub bounds: Rect,
    pub image: RgbaImage,
}

/// Crops `region` (virtual-screen coordinates) out of a set of monitor captures.
/// Works for regions spanning several monitors; areas not covered by any monitor
/// (gaps between monitors of different size) are filled with black.
pub fn crop_virtual(shots: &[MonitorShot], region: Rect) -> Result<RgbaImage> {
    if region.is_empty() {
        return Err(ImagingError::EmptyRegion);
    }
    // Fast path: region inside one monitor.
    if let Some(shot) = shots.iter().find(|s| s.bounds.intersect(&region) == Some(region)) {
        let local = region.offset(-shot.bounds.x, -shot.bounds.y);
        return Ok(image::imageops::crop_imm(&shot.image, local.x as u32, local.y as u32, local.width, local.height).to_image());
    }
    let mut out = RgbaImage::from_pixel(region.width, region.height, Rgba([0, 0, 0, 255]));
    for shot in shots {
        let Some(part) = shot.bounds.intersect(&region) else { continue };
        let src = part.offset(-shot.bounds.x, -shot.bounds.y);
        let piece = image::imageops::crop_imm(&shot.image, src.x as u32, src.y as u32, src.width, src.height).to_image();
        image::imageops::replace(&mut out, &piece, (part.x - region.x) as i64, (part.y - region.y) as i64);
    }
    Ok(out)
}

/// Bounding box of all monitors.
pub fn virtual_bounds(shots: &[MonitorShot]) -> Rect {
    shots.iter().fold(Rect::default(), |acc, s| acc.union(&s.bounds))
}

/// Downscaled preview that fits into `max_w × max_h` (never upscales).
pub fn thumbnail(img: &RgbaImage, max_w: u32, max_h: u32) -> RgbaImage {
    let (w, h) = img.dimensions();
    if w <= max_w && h <= max_h {
        return img.clone();
    }
    let scale = (max_w as f64 / w as f64).min(max_h as f64 / h as f64);
    let tw = ((w as f64 * scale).round() as u32).max(1);
    let th = ((h as f64 * scale).round() as u32).max(1);
    image::imageops::resize(img, tw, th, image::imageops::FilterType::Triangle)
}

/// Downscaled copy (Lanczos — keeps text sharp); the same picture when the size matches.
pub fn resize(img: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    if img.dimensions() == (width, height) || width == 0 || height == 0 {
        return img.clone();
    }
    image::imageops::resize(img, width, height, image::imageops::FilterType::Lanczos3)
}

/// PNG with a good speed/size trade-off for screenshots.
pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(img.len() / 4);
    let enc = PngEncoder::new_with_quality(&mut out, CompressionType::Default, FilterType::Adaptive);
    enc.write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)?;
    Ok(out)
}

/// Very fast PNG (used for temporary files where speed matters more than size).
pub fn encode_png_fast(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(img.len() / 3);
    let enc = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub);
    enc.write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)?;
    Ok(out)
}

/// Uncompressed BMP – the quickest way to hand a frozen screen to the web view.
pub fn encode_bmp(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(img.len() + 256);
    let rgb = DynamicImage::ImageRgba8(img.clone()).into_rgb8();
    BmpEncoder::new(&mut out).encode(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)?;
    Ok(out)
}

pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>> {
    let rgb = DynamicImage::ImageRgba8(img.clone()).into_rgb8();
    let mut out = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut out, quality.clamp(10, 100)).encode_image(&rgb)?;
    Ok(out.into_inner())
}

/// Lossless WebP (the pure-Rust encoder has no lossy mode; screenshots compress well anyway).
pub fn encode_webp(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(img.len() / 4);
    WebPEncoder::new_lossless(&mut out).encode(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)?;
    Ok(out)
}

pub fn decode(bytes: &[u8]) -> Result<RgbaImage> {
    Ok(image::load_from_memory(bytes)?.into_rgba8())
}

/// Picture for the watermark (PNG, JPEG, WebP, BMP), transparency kept, no larger than
/// `max` px on the longest side (it is drawn small anyway, and it is stored in every edited
/// screenshot's document).
pub fn prepare_logo(bytes: &[u8], max: u32) -> Result<RgbaImage> {
    let img = decode(bytes)?;
    let (w, h) = img.dimensions();
    if w <= max && h <= max {
        return Ok(img);
    }
    let k = max as f64 / w.max(h) as f64;
    let size = |v: u32| ((v as f64 * k).round() as u32).max(1);
    Ok(resize(&img, size(w), size(h)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, c: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba(c))
    }

    #[test]
    fn crop_inside_single_monitor() {
        let shots = vec![MonitorShot { bounds: Rect::new(-100, 0, 100, 50), image: solid(100, 50, [255, 0, 0, 255]) }];
        let img = crop_virtual(&shots, Rect::new(-90, 10, 20, 5)).unwrap();
        assert_eq!(img.dimensions(), (20, 5));
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn crop_spanning_two_monitors_with_gap() {
        // left monitor 100x50 red, right monitor 100x100 blue
        let shots = vec![
            MonitorShot { bounds: Rect::new(0, 0, 100, 50), image: solid(100, 50, [255, 0, 0, 255]) },
            MonitorShot { bounds: Rect::new(100, 0, 100, 100), image: solid(100, 100, [0, 0, 255, 255]) },
        ];
        let img = crop_virtual(&shots, Rect::new(90, 40, 20, 20)).unwrap();
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]); // from left monitor
        assert_eq!(img.get_pixel(15, 0).0, [0, 0, 255, 255]); // from right monitor
        assert_eq!(img.get_pixel(0, 15).0, [0, 0, 0, 255]); // gap below the left monitor
        assert_eq!(virtual_bounds(&shots), Rect::new(0, 0, 200, 100));
    }

    #[test]
    fn empty_region_is_error() {
        assert!(crop_virtual(&[], Rect::new(0, 0, 0, 10)).is_err());
    }

    #[test]
    fn thumbnails_and_encoders() {
        let img = solid(400, 200, [10, 20, 30, 255]);
        let t = thumbnail(&img, 100, 100);
        assert_eq!(t.dimensions(), (100, 50));
        assert_eq!(thumbnail(&img, 1000, 1000).dimensions(), (400, 200));

        for bytes in [encode_png(&img).unwrap(), encode_png_fast(&img).unwrap(), encode_bmp(&img).unwrap(), encode_webp(&img).unwrap()] {
            let back = decode(&bytes).unwrap();
            assert_eq!(back.dimensions(), (400, 200));
            assert_eq!(back.get_pixel(5, 5).0, [10, 20, 30, 255]);
        }
        assert_eq!(resize(&img, 74, 37).dimensions(), (74, 37));
        assert_eq!(resize(&img, 74, 37).get_pixel(10, 10).0, [10, 20, 30, 255]);
        assert_eq!(resize(&img, 400, 200).dimensions(), (400, 200));
        let jpg = encode_jpeg(&img, 90).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn logos_are_limited_and_keep_transparency() {
        let logo = solid(3000, 1000, [200, 0, 0, 0]);
        let small = prepare_logo(&encode_png(&logo).unwrap(), 800).unwrap();
        assert_eq!(small.dimensions(), (800, 267));
        assert_eq!(small.get_pixel(10, 10).0[3], 0, "alpha kept");
        let tiny = solid(120, 40, [0, 0, 0, 255]);
        assert_eq!(prepare_logo(&encode_jpeg(&tiny, 90).unwrap(), 800).unwrap().dimensions(), (120, 40), "never upscaled");
        assert!(prepare_logo(b"not an image", 800).is_err());
    }
}
