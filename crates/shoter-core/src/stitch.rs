//! Scrolling capture: glues the frames of a scrolling area into one tall picture.
//!
//! Each new frame is compared with the previous one by row *profiles* — the average
//! brightness of a few column blocks per row, which tolerates the moving scrollbar thumb and
//! slightly different re-rendering. The vertical shift with the smallest difference over the
//! overlap is how far the content moved. Rows that stay in place (a sticky header or footer,
//! or the browser toolbar caught in the selection) are kept out of the matching: the first
//! frame gives the header, the last one the footer, and the content in between is appended as
//! it moves up.

use image::RgbaImage;

/// Column blocks per row profile.
const BLOCKS: usize = 32;
/// Profile values are brightness × `SCALE` (keeps the averages precise in integers).
const SCALE: u32 = 16;
/// Rows whose brightness differs by at most this (0–255, mean over the blocks) are "the same".
const SAME_ROW: f32 = 1.0;
/// A match is accepted when the overlap differs by at most this on average.
const MAX_COST: f32 = 6.0;
/// Candidates this close to the best one are ties (broken by the expected shift).
const TIE: f32 = 0.35;
/// A row with less contrast than this across its blocks carries no information (blank).
const INFORMATIVE: u32 = 6 * SCALE;
/// The overlap must contain at least this many informative rows.
const MIN_INFORMATIVE: usize = 4;
/// Fixed bands (sticky header / footer) are at most this share of the frame.
const MAX_BAND: f32 = 0.3;

type Profile = [u32; BLOCKS];

/// What a new frame did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The content moved up by `shift` rows; `added` rows were appended.
    Added { shift: u32, added: u32 },
    /// Nothing moved: the end of the page (or the area does not scroll).
    Unchanged,
    /// The frames do not overlap (moved too far, or changed too much).
    NoMatch,
    /// The height limit is reached (what fitted was appended).
    Full,
}

pub struct Stitcher {
    width: u32,
    height: u32,
    /// The picture so far (RGBA rows), without the footer of the last frame.
    rows: Vec<u8>,
    prev: RgbaImage,
    prev_profiles: Vec<Profile>,
    /// Rows at the top / bottom that do not scroll — decided when the content first moves
    /// and kept for the whole capture (the appended rows depend on them).
    bands: Option<(u32, u32)>,
    last_shift: Option<u32>,
    max_height: u32,
}

impl Stitcher {
    /// Starts with the first frame; the result never gets taller than `max_height`.
    pub fn new(first: RgbaImage, max_height: u32) -> Self {
        let (width, height) = first.dimensions();
        Self {
            width,
            height,
            rows: first.as_raw().clone(),
            prev_profiles: profiles(&first),
            prev: first,
            bands: None,
            last_shift: None,
            max_height: max_height.max(height),
        }
    }

    /// Height of the picture so far (with the footer).
    pub fn height(&self) -> u32 {
        self.stored_rows() + self.bands.map_or(0, |(_, footer)| footer)
    }

    /// Shift of the last step that moved.
    pub fn last_shift(&self) -> Option<u32> {
        self.last_shift
    }

    /// Rows that scroll in a frame (without the sticky header and footer, once known).
    pub fn scrolling_rows(&self) -> u32 {
        self.bands.map_or(self.height, |(header, footer)| self.height - header - footer)
    }

    fn stored_rows(&self) -> u32 {
        (self.rows.len() / (self.width as usize * 4)) as u32
    }

    /// Adds a frame taken after scrolling down. `expected` — the likely shift, if known (it
    /// decides between equally good matches, e.g. on repeating content).
    pub fn push(&mut self, frame: RgbaImage, expected: Option<u32>) -> Step {
        if frame.dimensions() != (self.width, self.height) {
            return Step::NoMatch;
        }
        let next = profiles(&frame);
        if next.iter().zip(&self.prev_profiles).all(|(a, b)| diff(a, b) <= SAME_ROW) {
            return Step::Unchanged;
        }
        let (header, footer) = self.bands.unwrap_or_else(|| fixed_bands(&self.prev_profiles, &next));
        let expected = expected.or(self.last_shift);
        match find_shift(&self.prev_profiles, &next, header, footer, expected) {
            Some(shift) => self.append(frame, next, (header, footer), shift),
            None => Step::NoMatch,
        }
    }

    /// Adds a frame whose shift is known for sure (when matching failed but the scrolling
    /// itself reported how far it went).
    pub fn push_shifted(&mut self, frame: RgbaImage, shift: u32) -> Step {
        if frame.dimensions() != (self.width, self.height) || shift == 0 {
            return Step::NoMatch;
        }
        let next = profiles(&frame);
        let (header, footer) = self.bands.unwrap_or_else(|| fixed_bands(&self.prev_profiles, &next));
        let band = self.height - header - footer;
        self.append(frame, next, (header, footer), shift.min(band))
    }

    fn append(&mut self, frame: RgbaImage, next: Vec<Profile>, (header, footer): (u32, u32), shift: u32) -> Step {
        let row_bytes = self.width as usize * 4;
        if self.bands.is_none() {
            // The first frame's own footer goes: the content continues below it.
            self.bands = Some((header, footer));
            self.rows.truncate((self.height - footer) as usize * row_bytes);
        }
        // The rows that just came into view above the footer.
        let room = self.max_height.saturating_sub(self.stored_rows() + footer);
        let added = shift.min(room);
        let from = (self.height - footer - shift) as usize * row_bytes;
        self.rows.extend_from_slice(&frame.as_raw()[from..from + added as usize * row_bytes]);
        self.prev = frame;
        self.prev_profiles = next;
        self.last_shift = Some(shift);
        if added < shift { Step::Full } else { Step::Added { shift, added } }
    }

    /// The tall picture: everything stitched, then the footer of the last frame.
    pub fn finish(self) -> RgbaImage {
        let row_bytes = self.width as usize * 4;
        let mut rows = self.rows;
        if let Some((_, footer)) = self.bands {
            let raw = self.prev.as_raw();
            rows.extend_from_slice(&raw[(self.height - footer) as usize * row_bytes..]);
        }
        let height = (rows.len() / row_bytes) as u32;
        RgbaImage::from_raw(self.width, height, rows).expect("whole rows")
    }
}

/// Two frames show the same picture (up to re-rendering noise): the page stopped moving.
pub fn nearly_same(a: &RgbaImage, b: &RgbaImage) -> bool {
    a.dimensions() == b.dimensions() && (a.as_raw() == b.as_raw() || profiles(a).iter().zip(&profiles(b)).all(|(x, y)| diff(x, y) <= SAME_ROW))
}

/// Row profiles: the brightness of `BLOCKS` column blocks. A strip at the right (a scrollbar)
/// and at the left edge is left out — it changes while the content scrolls.
fn profiles(img: &RgbaImage) -> Vec<Profile> {
    let (w, h) = img.dimensions();
    let left = (w / 100).min(6);
    let right = (w / 20).min(24);
    let span = w.saturating_sub(left + right).max(1);
    let blocks = (span as usize).min(BLOCKS);
    let raw = img.as_raw();
    (0..h)
        .map(|y| {
            let mut p = [0u32; BLOCKS];
            let row = &raw[(y * w * 4) as usize..((y + 1) * w * 4) as usize];
            for (b, slot) in p.iter_mut().enumerate().take(blocks) {
                let x0 = left + (span as usize * b / blocks) as u32;
                let x1 = (left + (span as usize * (b + 1) / blocks) as u32).max(x0 + 1).min(w);
                let mut sum = 0u32;
                for x in x0..x1 {
                    let px = &row[(x * 4) as usize..(x * 4 + 3) as usize];
                    sum += (px[0] as u32 * 299 + px[1] as u32 * 587 + px[2] as u32 * 114) / 1000;
                }
                *slot = sum * SCALE / (x1 - x0).max(1);
            }
            p
        })
        .collect()
}

/// Mean brightness difference of two rows (0–255).
fn diff(a: &Profile, b: &Profile) -> f32 {
    let sum: u32 = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).sum();
    sum as f32 / (BLOCKS as u32 * SCALE) as f32
}

fn informative(p: &Profile) -> bool {
    let (min, max) = p.iter().fold((u32::MAX, 0), |(lo, hi), &v| (lo.min(v), hi.max(v)));
    max - min > INFORMATIVE
}

/// Rows at the top and bottom that are the same in both frames (sticky header / footer).
/// Blank rows at the inner edge of a band do not count: blank page margins look the same
/// in both frames, yet they scroll.
fn fixed_bands(prev: &[Profile], next: &[Profile]) -> (u32, u32) {
    let h = prev.len();
    let cap = (h as f32 * MAX_BAND) as usize;
    let same = |y: usize| diff(&prev[y], &next[y]) <= SAME_ROW;
    let band = |rows: &mut dyn Iterator<Item = usize>| {
        let mut len = 0;
        for (i, y) in rows.enumerate().take(cap) {
            if !same(y) {
                break;
            }
            if informative(&next[y]) {
                len = i + 1;
            }
        }
        len as u32
    };
    let header = band(&mut (0..h));
    let footer = band(&mut (0..h).rev());
    (header, footer)
}

/// The shift (rows the content moved up) that matches `next` to `prev` best inside the
/// scrolling band; `None` when nothing matches well enough.
fn find_shift(prev: &[Profile], next: &[Profile], header: u32, footer: u32, expected: Option<u32>) -> Option<u32> {
    let h = prev.len();
    let (top, bottom) = (header as usize, h - footer as usize);
    let band = bottom.saturating_sub(top);
    let min_overlap = (band / 8).max(12);
    if band <= min_overlap {
        return None;
    }
    // (shift, mean cost)
    let mut scored: Vec<(usize, f32)> = Vec::new();
    let mut best = f32::MAX;
    for shift in 1..=band - min_overlap {
        let rows = band - shift;
        let budget = best.min(MAX_COST) * rows as f32;
        let mut sum = 0.0f32;
        let mut info = 0;
        let mut pruned = false;
        for y in top..bottom - shift {
            sum += diff(&next[y], &prev[y + shift]);
            if sum > budget + TIE * rows as f32 {
                pruned = true;
                break;
            }
            if informative(&next[y]) {
                info += 1;
            }
        }
        if pruned || info < MIN_INFORMATIVE {
            continue;
        }
        let cost = sum / rows as f32;
        best = best.min(cost);
        scored.push((shift, cost));
    }
    if best > MAX_COST {
        return None;
    }
    // Equally good shifts (repeating content, blank stretches): the one closest to the
    // expected shift, otherwise the smallest (the largest overlap).
    let ties = scored.into_iter().filter(|&(_, c)| c <= best + TIE);
    let pick = match expected {
        Some(e) => ties.min_by_key(|&(s, _)| (s as i64 - e as i64).unsigned_abs()),
        None => ties.min_by_key(|&(s, _)| s),
    };
    pick.map(|(s, _)| s as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// A long page: colored blocks that differ from row group to row group, with blank
    /// stretches every 300 rows (like gaps between sections).
    fn page(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            if y % 300 >= 260 {
                return Rgba([255, 255, 255, 255]);
            }
            let cell = (x / 23) as u64 * 7919 + (y / 9) as u64 * 104_729;
            let v = (cell.wrapping_mul(2_654_435_761) >> 7) as u8;
            Rgba([v, v.wrapping_mul(3), v ^ 0x5a, 255])
        })
    }

    fn band(w: u32, h: u32, seed: u8) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let v = ((x / 17 + y / 5) as u8).wrapping_mul(29).wrapping_add(seed);
            Rgba([v, 40, 255 - v, 255])
        })
    }

    /// What the viewport shows at scroll offset `offset`: the page under the sticky bands.
    fn frame(page: &RgbaImage, offset: u32, view_h: u32, header: Option<&RgbaImage>, footer: Option<&RgbaImage>) -> RgbaImage {
        let w = page.width();
        RgbaImage::from_fn(w, view_h, |x, y| {
            if let Some(hd) = header
                && y < hd.height()
            {
                return *hd.get_pixel(x, y);
            }
            if let Some(ft) = footer
                && y >= view_h - ft.height()
            {
                return *ft.get_pixel(x, y - (view_h - ft.height()));
            }
            *page.get_pixel(x, offset + y)
        })
    }

    fn same(a: &RgbaImage, b: &RgbaImage) -> bool {
        a.dimensions() == b.dimensions() && a.as_raw() == b.as_raw()
    }

    #[test]
    fn plain_page_is_glued_back_exactly() {
        let (w, view) = (400, 300);
        let pg = page(w, 2000);
        let mut s = Stitcher::new(frame(&pg, 0, view, None, None), 50_000);
        let mut offset = 0;
        for step in [180, 180, 175, 190, 180, 180, 180, 180, 180, 175] {
            offset = (offset + step).min(2000 - view);
            let r = s.push(frame(&pg, offset, view, None, None), None);
            assert!(matches!(r, Step::Added { .. }), "offset {offset}: {r:?}");
        }
        assert_eq!(s.push(frame(&pg, offset, view, None, None), None), Step::Unchanged, "end of the page");
        let out = s.finish();
        let want = image::imageops::crop_imm(&pg, 0, 0, w, offset + view).to_image();
        assert_eq!(out.height(), offset + view);
        assert!(same(&out, &want));
    }

    #[test]
    fn sticky_header_and_footer_appear_once() {
        let (w, view) = (360, 320);
        let pg = page(w, 1600);
        let (hd, ft) = (band(w, 48, 0), band(w, 30, 99));
        let shot = |o| frame(&pg, o, view, Some(&hd), Some(&ft));
        let mut s = Stitcher::new(shot(0), 50_000);
        let mut offset = 0;
        for _ in 0..5 {
            offset += 150;
            assert!(matches!(s.push(shot(offset), None), Step::Added { shift: 150, .. }));
        }
        let out = s.finish();
        // header, the content from under the header of the first frame to above the footer
        // of the last one, then the footer
        assert_eq!(out.height(), offset + view);
        let content_end = offset + view - 30;
        assert!(same(&image::imageops::crop_imm(&out, 0, 0, w, 48).to_image(), &hd));
        assert!(same(
            &image::imageops::crop_imm(&out, 0, 48, w, content_end - 48).to_image(),
            &image::imageops::crop_imm(&pg, 0, 48, w, content_end - 48).to_image()
        ));
        assert!(same(&image::imageops::crop_imm(&out, 0, out.height() - 30, w, 30).to_image(), &ft));
    }

    #[test]
    fn small_differences_and_a_moving_scrollbar_are_tolerated() {
        let (w, view) = (400, 300);
        let pg = page(w, 1200);
        let noisy = |o: u32, seed: u32| {
            let mut f = frame(&pg, o, view, None, None);
            for (x, y, px) in f.enumerate_pixels_mut() {
                // re-rendering noise everywhere, a scrollbar thumb at the right that moves
                if x >= w - 14 {
                    *px = if (y + seed * 37) % view < 60 { Rgba([90, 90, 90, 255]) } else { Rgba([240, 240, 240, 255]) };
                } else if (x * 7 + y * 13 + seed) % 5 == 0 {
                    px.0[0] = px.0[0].saturating_add(2);
                }
            }
            f
        };
        let mut s = Stitcher::new(noisy(0, 0), 50_000);
        assert_eq!(s.push(noisy(170, 1), None), Step::Added { shift: 170, added: 170 });
        assert_eq!(s.push(noisy(340, 2), None), Step::Added { shift: 170, added: 170 });
        assert_eq!(s.finish().height(), 340 + view);
    }

    #[test]
    fn repeating_content_follows_the_expected_shift() {
        // The same 40-row stripe over and over: any multiple of 40 fits equally well.
        let (w, view) = (300, 240);
        let pg = RgbaImage::from_fn(w, 2000, |x, y| {
            let v = ((y % 40) * 6 + (x / 30) * 11) as u8;
            Rgba([v, v, 255 - v, 255])
        });
        // (A shift by a multiple of 40 would give the very same frame — "nothing moved".)
        let mut s = Stitcher::new(frame(&pg, 0, view, None, None), 50_000);
        assert_eq!(s.push(frame(&pg, 100, view, None, None), Some(98)), Step::Added { shift: 100, added: 100 });
        // Without a hint the previous shift is the hint.
        assert_eq!(s.push(frame(&pg, 200, view, None, None), None), Step::Added { shift: 100, added: 100 });
    }

    #[test]
    fn too_far_or_unrelated_frames_do_not_match() {
        let (w, view) = (400, 300);
        let pg = page(w, 3000);
        let mut s = Stitcher::new(frame(&pg, 0, view, None, None), 50_000);
        assert_eq!(s.push(frame(&pg, 900, view, None, None), None), Step::NoMatch);
        assert_eq!(s.push(band(w, view, 7), None), Step::NoMatch);
        assert_eq!(s.push(band(w, 10, 7), None), Step::NoMatch, "another size");
        // The caller may still append a frame whose shift it knows.
        assert_eq!(s.push_shifted(frame(&pg, 200, view, None, None), 200), Step::Added { shift: 200, added: 200 });
        assert_eq!(s.finish().height(), 500);
    }

    #[test]
    fn stops_at_the_height_limit() {
        let (w, view) = (200, 300);
        let pg = page(w, 3000);
        let mut s = Stitcher::new(frame(&pg, 0, view, None, None), 700);
        assert!(matches!(s.push(frame(&pg, 200, view, None, None), None), Step::Added { .. }));
        assert!(matches!(s.push(frame(&pg, 400, view, None, None), None), Step::Added { .. }));
        assert_eq!(s.push(frame(&pg, 600, view, None, None), None), Step::Full);
        assert_eq!(s.height(), 700);
        assert_eq!(s.finish().height(), 700);
    }

    #[test]
    fn settled_frames_are_nearly_the_same() {
        let pg = page(200, 600);
        let a = frame(&pg, 0, 200, None, None);
        let mut b = a.clone();
        b.get_pixel_mut(5, 5).0[0] ^= 1;
        assert!(nearly_same(&a, &b));
        assert!(!nearly_same(&a, &frame(&pg, 20, 200, None, None)));
        let mut s = Stitcher::new(a, 10_000);
        assert_eq!(s.scrolling_rows(), 200);
        s.push(frame(&pg, 100, 200, None, None), None);
        assert_eq!(s.scrolling_rows(), 200, "no sticky bands on this page");
    }

    #[test]
    fn blank_margins_are_not_a_sticky_header() {
        // Both frames start with blank rows (a gap between sections) — they still scroll.
        let p = vec![[100 * SCALE; BLOCKS]; 10];
        let mut q = p.clone();
        q[9] = [0; BLOCKS];
        assert_eq!(fixed_bands(&p, &q), (0, 0));
    }
}

