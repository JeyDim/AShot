use serde::{Deserialize, Serialize};

/// Integer rectangle in physical (device) pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    pub fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && py >= self.y && px < self.right() && py < self.bottom()
    }

    pub fn area(&self) -> u64 {
        self.width as u64 * self.height as u64
    }

    pub fn center(&self) -> (i32, i32) {
        (self.x + self.width as i32 / 2, self.y + self.height as i32 / 2)
    }

    /// Intersection of two rectangles, `None` when they do not overlap.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x1 = self.x.max(other.x);
        let y1 = self.y.max(other.y);
        let x2 = self.right().min(other.right());
        let y2 = self.bottom().min(other.bottom());
        if x2 > x1 && y2 > y1 {
            Some(Rect::new(x1, y1, (x2 - x1) as u32, (y2 - y1) as u32))
        } else {
            None
        }
    }

    /// Smallest rectangle containing both.
    pub fn union(&self, other: &Rect) -> Rect {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        let x1 = self.x.min(other.x);
        let y1 = self.y.min(other.y);
        let x2 = self.right().max(other.right());
        let y2 = self.bottom().max(other.bottom());
        Rect::new(x1, y1, (x2 - x1) as u32, (y2 - y1) as u32)
    }

    pub fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect::new(self.x + dx, self.y + dy, self.width, self.height)
    }

    /// What is seen of this rectangle (a window) under `above` (the windows over it): edges
    /// covered along their whole length are cut off — the taskbar over a window that reaches
    /// below it, a docked panel. The rest stays a rectangle, so an occluder in the middle or at a
    /// corner is left alone, as is one that covers everything (an invisible layer over the
    /// screen). `None` — hardly anything is left.
    pub fn visible_part(&self, above: &[Rect]) -> Option<Rect> {
        let (mut l, mut t, mut r, mut b) = (self.x, self.y, self.right(), self.bottom());
        loop {
            let before = (l, t, r, b);
            for o in above {
                let across = o.x <= l && o.right() >= r;
                let along = o.y <= t && o.bottom() >= b;
                if across && along {
                    continue;
                }
                if across && o.y <= t && o.bottom() > t {
                    t = o.bottom();
                } else if across && o.bottom() >= b && o.y < b {
                    b = o.y;
                } else if along && o.x <= l && o.right() > l {
                    l = o.right();
                } else if along && o.right() >= r && o.x < r {
                    r = o.x;
                }
                if r - l < 8 || b - t < 8 {
                    return None;
                }
            }
            if (l, t, r, b) == before {
                return Some(Rect::new(l, t, (r - l) as u32, (b - t) as u32));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_part_cuts_covered_edges_only() {
        // (Window bounds are already cut to the screen.)
        let window = Rect::new(100, 600, 800, 480);
        // The taskbar (1920 wide, 48 high at the bottom of a 1080 screen) covers its lower part.
        let taskbar = Rect::new(0, 1032, 1920, 48);
        assert_eq!(window.visible_part(&[taskbar]), Some(Rect::new(100, 600, 800, 432)));
        // A taskbar on the left, a panel docked at the top.
        assert_eq!(Rect::new(0, 0, 500, 400).visible_part(&[Rect::new(0, 0, 60, 1080)]), Some(Rect::new(60, 0, 440, 400)));
        assert_eq!(Rect::new(0, 0, 500, 400).visible_part(&[Rect::new(0, 0, 1920, 30)]), Some(Rect::new(0, 30, 500, 370)));
        // A window in the middle or over a corner, a layer over everything: nothing is cut.
        assert_eq!(window.visible_part(&[Rect::new(300, 700, 100, 100)]), Some(window));
        assert_eq!(window.visible_part(&[Rect::new(0, 1000, 300, 300)]), Some(window));
        assert_eq!(window.visible_part(&[Rect::new(0, 0, 1920, 1080)]), Some(window));
        // One cut can make another occluder span an edge.
        let w = Rect::new(0, 0, 400, 400);
        let side = Rect::new(350, 0, 100, 380);
        let bottom = Rect::new(0, 380, 1920, 40);
        assert_eq!(w.visible_part(&[side, bottom]), Some(Rect::new(0, 0, 350, 380)));
        // Covered all but a sliver.
        assert_eq!(w.visible_part(&[Rect::new(0, 4, 1920, 1000)]), None);
    }

    #[test]
    fn intersect_and_union() {
        let a = Rect::new(0, 0, 100, 100);
        let b = Rect::new(50, 60, 100, 100);
        assert_eq!(a.intersect(&b), Some(Rect::new(50, 60, 50, 40)));
        assert_eq!(a.union(&b), Rect::new(0, 0, 150, 160));
        assert_eq!(a.intersect(&Rect::new(100, 0, 10, 10)), None);
    }

    #[test]
    fn negative_coordinates() {
        // Monitors to the left of the primary one have negative coordinates.
        let left = Rect::new(-1920, 0, 1920, 1080);
        assert!(left.contains(-1, 0));
        assert!(!left.contains(0, 0));
        assert_eq!(left.right(), 0);
    }
}
