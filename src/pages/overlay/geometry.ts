// Pure geometry helpers for the selection overlay (unit-tested).
import type { Rect } from '../../lib/types';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function fromPoints(x1: number, y1: number, x2: number, y2: number, square = false): Rect {
  let w = x2 - x1;
  let h = y2 - y1;
  if (square) {
    const size = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * size;
    h = Math.sign(h || 1) * size;
  }
  const x = Math.min(x1, x1 + w);
  const y = Math.min(y1, y1 + h);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.abs(w)), height: Math.round(Math.abs(h)) };
}

export function clamp(r: Rect, bounds: Rect): Rect {
  const x1 = Math.max(bounds.x, r.x);
  const y1 = Math.max(bounds.y, r.y);
  const x2 = Math.min(bounds.x + bounds.width, r.x + r.width);
  const y2 = Math.min(bounds.y + bounds.height, r.y + r.height);
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/** Moves a rectangle but keeps it fully inside `bounds`. */
export function moveWithin(r: Rect, dx: number, dy: number, bounds: Rect): Rect {
  const x = Math.min(Math.max(bounds.x, r.x + dx), bounds.x + bounds.width - r.width);
  const y = Math.min(Math.max(bounds.y, r.y + dy), bounds.y + bounds.height - r.height);
  return { ...r, x: Math.round(x), y: Math.round(y) };
}

/** Bounding box of the rectangles (all monitors — the virtual screen). */
export function bounding(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: x2 - x, height: y2 - y };
}

/** `r` lies entirely inside `bounds`. */
export function within(r: Rect, bounds: Rect): boolean {
  return r.x >= bounds.x && r.y >= bounds.y && r.x + r.width <= bounds.x + bounds.width && r.y + r.height <= bounds.y + bounds.height;
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
}

export function handlePoint(r: Rect, h: Handle): [number, number] {
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const r2 = r.x + r.width;
  const b = r.y + r.height;
  switch (h) {
    case 'nw':
      return [r.x, r.y];
    case 'n':
      return [cx, r.y];
    case 'ne':
      return [r2, r.y];
    case 'e':
      return [r2, cy];
    case 'se':
      return [r2, b];
    case 's':
      return [cx, b];
    case 'sw':
      return [r.x, b];
    case 'w':
      return [r.x, cy];
  }
}

export function hitHandle(r: Rect, x: number, y: number, radius: number): Handle | null {
  for (const h of HANDLES) {
    const [hx, hy] = handlePoint(r, h);
    if (Math.abs(x - hx) <= radius && Math.abs(y - hy) <= radius) return h;
  }
  return null;
}

/** Resizes `start` by dragging handle `h` to (x, y); edges may cross (the rect flips). */
export function resize(start: Rect, h: Handle, x: number, y: number, bounds: Rect): Rect {
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.width;
  let y2 = start.y + start.height;
  if (h.includes('w')) x1 = x;
  if (h.includes('e')) x2 = x;
  if (h.includes('n')) y1 = y;
  if (h.includes('s')) y2 = y;
  return clamp(fromPoints(x1, y1, x2, y2), bounds);
}

export function cursorFor(h: Handle | null, inside: boolean): string {
  if (h) {
    return { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }[h];
  }
  return inside ? 'move' : 'crosshair';
}

/** Topmost rectangle containing the point (list is topmost-first). */
export function topmostAt(rects: Rect[], x: number, y: number): Rect | null {
  return rects.find((r) => contains(r, x, y)) ?? null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * Where to put the action bar (CSS pixels): below the selection, above it,
 * or inside its bottom edge when there is no room around it.
 */
export function actionBarPosition(sel: Rect, barW: number, barH: number, viewW: number, viewH: number, gap = 10) {
  let left = sel.x + sel.width - barW;
  left = Math.min(Math.max(8, left), viewW - barW - 8);
  let top = sel.y + sel.height + gap;
  if (top + barH > viewH - 8) {
    top = sel.y - barH - gap;
    if (top < 8) top = Math.min(sel.y + sel.height - barH - gap, viewH - barH - 8);
  }
  return { left, top: Math.max(8, top) };
}
