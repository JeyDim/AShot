// Editor document model. Everything is in image pixel coordinates; the document is
// stored next to the original screenshot so annotations stay editable later.
import type { ResizeSettings, WatermarkPosition, WatermarkSettings } from '../../lib/types';

export type Tool = 'select' | 'rect' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'marker' | 'text' | 'step' | 'pixelate' | 'crop';

interface Base {
  id: string;
}

export interface BoxShape extends Base {
  type: 'rect' | 'ellipse' | 'pixelate';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  size: number; // size preset 0..2
  fill?: boolean;
}

export interface LineShape extends Base {
  type: 'arrow' | 'line';
  points: [number, number, number, number];
  color: string;
  size: number;
}

export interface PathShape extends Base {
  type: 'pen' | 'marker';
  points: number[];
  color: string;
  size: number;
}

export interface TextShape extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  /** Absolute font size (px) – set when the text was resized with handles. */
  fontSize?: number;
}

export interface StepShape extends Base {
  type: 'step';
  x: number;
  y: number;
  n: number;
  color: string;
  size: number;
}

/** Copyright: a text or a picture (data URL, so the document keeps it even when the picture
 *  is changed later) placed once; it can be moved and resized. Put with the © button. */
export interface StampShape extends Base {
  type: 'stamp';
  x: number;
  y: number;
  text?: string;
  fontSize?: number;
  src?: string;
  w?: number;
  h?: number;
  color: string;
  size: number;
  /** 0..1 */
  opacity: number;
}

/** Watermark: the text or the picture repeated over the whole image (`x, y, w, h`) in
 *  slanted rows, under the drawings; clicks go through it. Put with the same button. */
export interface WatermarkShape extends Base {
  type: 'watermark';
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  fontSize?: number;
  src?: string;
  /** Size of one repeat of the picture. */
  itemW?: number;
  itemH?: number;
  color: string;
  size: number;
  /** 0..1 */
  opacity: number;
  /** Slope of the rows, degrees. */
  angle: number;
  /** 0 – dense … 2 – sparse. */
  spacing: number;
}

export type Shape = BoxShape | LineShape | PathShape | TextShape | StepShape | StampShape | WatermarkShape;

/** The watermark or the copyright of a document (there is at most one). */
export const isMark = (s: Shape): s is StampShape | WatermarkShape => s.type === 'stamp' || s.type === 'watermark';

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Doc {
  version: 1;
  shapes: Shape[];
  crop: Crop | null;
  /** Stroke scale used when the shapes were drawn (kept when re-editing a crop). */
  scale?: number;
}

export const emptyDoc = (): Doc => ({ version: 1, shapes: [], crop: null });

export const PALETTE = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#0A84FF', '#AF52DE', '#FFFFFF', '#1C1C1E'];

/** Stroke width for a size preset; scales slightly with the image so 4K shots stay readable. */
export function strokeWidth(size: number, imageScale = 1): number {
  return [2, 4, 7][size] * imageScale;
}
export function markerWidth(size: number, imageScale = 1): number {
  return [12, 20, 32][size] * imageScale;
}
export function fontSize(size: number, imageScale = 1): number {
  return [16, 24, 38][size] * imageScale;
}
export function stepRadius(size: number, imageScale = 1): number {
  return [12, 16, 22][size] * imageScale;
}
export function pixelCell(size: number, imageScale = 1): number {
  return Math.round([6, 10, 16][size] * imageScale);
}
export function textFontSize(t: TextShape, imageScale = 1): number {
  return t.fontSize ?? fontSize(t.size, imageScale);
}

// ---------------------------------------------------------------- watermark & copyright

export const DEFAULT_WATERMARK: WatermarkSettings = {
  kind: 'text',
  layout: 'tile',
  text: 'AShot',
  color: '#FFFFFF',
  size: 1,
  opacity: 25,
  angle: 30,
  spacing: 1,
  position: 'bottomRight',
};

/** Opacity a layout starts with: a watermark is faint, a copyright is clearly visible. */
export const MARK_OPACITY = { tile: 25, corner: 80 } as const;

/** Font size of a watermark repeat for a picture of `area`. */
export function watermarkFontSize(area: Crop, size: number): number {
  return Math.round(Math.min(160, Math.max(14, Math.min(area.w, area.h) * [0.035, 0.05, 0.075][size ?? 1])));
}

/** Size of one picture repeat of a watermark (× `scale`), at most 45% of the picture wide. */
export function watermarkItemSize(area: Crop, size: number, logoW: number, logoH: number, scale = 1): { w: number; h: number } {
  const k = Math.min((Math.min(area.w, area.h) * [0.08, 0.12, 0.18][size ?? 1] * scale) / logoH, (area.w * 0.45) / logoW);
  return { w: Math.max(1, Math.round(logoW * k)), h: Math.max(1, Math.round(logoH * k)) };
}

/** Pattern tile for repeats of `w × h`: a brick layout (every other row shifted by half a
 *  repeat), gaps by `spacing`. Returns the tile size and the centers of the repeats in it
 *  (the shifted one is drawn at both edges, so the pattern has no seams). */
export function watermarkTile(w: number, h: number, spacing: number): { tw: number; th: number; centers: [number, number][] } {
  const s = spacing ?? 1;
  const gapX = h * 1.5 + w * [0.25, 0.6, 1.1][s];
  const gapY = h * [1.4, 2.4, 3.8][s];
  const tw = Math.ceil(w + gapX);
  const th = Math.ceil(2 * (h + gapY));
  return { tw, th, centers: [[tw / 2, th / 4], [0, (3 * th) / 4], [tw, (3 * th) / 4]] };
}

/** Font size of a text stamp for a picture of `area` (grows with the picture, preset 0..2). */
export function stampFontSize(area: Crop, size: number): number {
  return Math.round(Math.min(72, Math.max(12, Math.min(area.w, area.h) * [0.022, 0.03, 0.045][size ?? 1])));
}

/** Height of a picture stamp for a picture of `area`. */
export function stampImageHeight(area: Crop, size: number): number {
  return Math.round(Math.min(400, Math.max(16, Math.min(area.w, area.h) * [0.06, 0.09, 0.14][size ?? 1])));
}

/** Gap between the stamp and the edges of the picture. */
export function stampMargin(area: Crop): number {
  return Math.round(Math.max(6, Math.min(area.w, area.h) * 0.025));
}

/** Top-left corner of a `w × h` stamp at `pos` inside `area`. */
export function placeStamp(area: Crop, w: number, h: number, pos: WatermarkPosition, margin = stampMargin(area)): { x: number; y: number } {
  const col = pos.endsWith('Left') || pos === 'left' ? 0 : pos.endsWith('Right') || pos === 'right' ? 2 : 1;
  const row = pos.startsWith('top') ? 0 : pos.startsWith('bottom') ? 2 : 1;
  const x = [area.x + margin, area.x + (area.w - w) / 2, area.x + area.w - margin - w][col];
  const y = [area.y + margin, area.y + (area.h - h) / 2, area.y + area.h - margin - h][row];
  return { x: Math.round(x), y: Math.round(y) };
}

/** Picture stamp size: `stampImageHeight` tall (× `scale`), at most 40% of the picture wide. */
export function stampImageSize(area: Crop, size: number, logoW: number, logoH: number, scale = 1): { w: number; h: number } {
  const k = Math.min((stampImageHeight(area, size) * scale) / logoH, (area.w * 0.4) / logoW);
  return { w: Math.max(1, Math.round(logoW * k)), h: Math.max(1, Math.round(logoH * k)) };
}

// ---------------------------------------------------------------- "downscale to N px"

export const DEFAULT_RESIZE: ResizeSettings = { enabled: false, side: 'width', size: 740, thicken: true };
export const MIN_RESIZE = 16;
export const MAX_RESIZE = 20000;

/** Output size of a `width × height` picture (same rule as `ResizeSettings::output_size` in Rust). */
export function outputSize(r: ResizeSettings, width: number, height: number): { w: number; h: number } {
  const limited = r.side === 'width' ? width : r.side === 'height' ? height : Math.max(width, height);
  if (!r.enabled || width <= 0 || height <= 0 || limited <= r.size) return { w: width, h: height };
  const k = r.size / limited;
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/** Stroke multiplier that makes drawings look normal after downscaling ("thicken" option). */
export function thickenFactor(r: ResizeSettings, width: number, height: number): number {
  if (!r.enabled || !r.thicken || width <= 0) return 1;
  const out = outputSize(r, width, height);
  return Math.min(8, width / out.w);
}

/** Helps big screenshots (4K) get proportionally thicker strokes. */
export function imageScaleFor(width: number, height: number): number {
  const longest = Math.max(width, height);
  return longest > 3000 ? 1.6 : longest > 2200 ? 1.3 : 1;
}

let counter = 0;
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The number after the most recently added step: numbering can restart or jump (see the
 *  "next number" field) and still continue from there; undo steps it back. */
export function nextStep(shapes: Shape[]): number {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.type === 'step') return s.n + 1;
  }
  return 1;
}

export const MAX_STEP = 999;

export function clampStep(n: number): number {
  return Math.min(MAX_STEP, Math.max(1, Math.round(n) || 1));
}

/** Black or white text depending on the background luminance. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#111' : '#fff';
}

export function normalizeBox(x1: number, y1: number, x2: number, y2: number, square = false) {
  let w = x2 - x1;
  let h = y2 - y1;
  if (square) {
    const s = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * s;
    h = Math.sign(h || 1) * s;
  }
  return { x: Math.min(x1, x1 + w), y: Math.min(y1, y1 + h), w: Math.abs(w), h: Math.abs(h) };
}

/** Top-left corner of a callout's text (`w × h`): the box sits at the arrow's tail
 *  (points[0..1]), on the side away from where the arrow points (points[2..3]). */
export function calloutTextPosition(points: [number, number, number, number], w: number, h: number, gap: number): { x: number; y: number } {
  const [tx, ty, px, py] = points;
  const dx = px - tx;
  const dy = py - ty;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: dx > 0 ? tx - gap - w : tx + gap, y: ty - h / 2 };
  return { x: tx - w / 2, y: dy > 0 ? ty - gap - h : ty + gap };
}

/** Snaps the end point to multiples of 45° (Shift while drawing lines/arrows). */
export function snapAngle(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return [x1 + Math.cos(a) * len, y1 + Math.sin(a) * len];
}

/** Bounds of the visible/exported area. */
export function visibleArea(doc: Doc, width: number, height: number): Crop {
  return doc.crop ?? { x: 0, y: 0, w: width, h: height };
}

export function clampCrop(c: Crop, width: number, height: number): Crop | null {
  const x1 = Math.max(0, Math.round(c.x));
  const y1 = Math.max(0, Math.round(c.y));
  const x2 = Math.min(width, Math.round(c.x + c.w));
  const y2 = Math.min(height, Math.round(c.y + c.h));
  if (x2 - x1 < 4 || y2 - y1 < 4) return null;
  if (x1 === 0 && y1 === 0 && x2 === width && y2 === height) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function parseDoc(json: string | null): Doc {
  if (!json) return emptyDoc();
  try {
    const d = JSON.parse(json);
    if (d && Array.isArray(d.shapes)) return { version: 1, shapes: d.shapes, crop: d.crop ?? null, ...(typeof d.scale === 'number' ? { scale: d.scale } : {}) };
  } catch {
    /* ignore corrupt documents */
  }
  return emptyDoc();
}

// ---------------------------------------------------------------- undo / redo

export interface History {
  past: Doc[];
  present: Doc;
  future: Doc[];
}

export const historyOf = (doc: Doc): History => ({ past: [], present: doc, future: [] });

export function commit(h: History, next: Doc, limit = 200): History {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-limit), present: next, future: [] };
}

export function undo(h: History): History {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo(h: History): History {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

export function updateShape(doc: Doc, id: string, patch: Partial<Shape>): Doc {
  return { ...doc, shapes: doc.shapes.map((s) => (s.id === id ? ({ ...s, ...patch } as Shape) : s)) };
}

export function removeShape(doc: Doc, id: string): Doc {
  return { ...doc, shapes: doc.shapes.filter((s) => s.id !== id) };
}

export function addShape(doc: Doc, shape: Shape): Doc {
  return { ...doc, shapes: [...doc.shapes, shape] };
}

/** Moves a shape by dx/dy (used for keyboard nudging and drag end). */
export function translate(s: Shape, dx: number, dy: number): Shape {
  switch (s.type) {
    case 'arrow':
    case 'line':
      return { ...s, points: [s.points[0] + dx, s.points[1] + dy, s.points[2] + dx, s.points[3] + dy] };
    case 'pen':
    case 'marker':
      return { ...s, points: s.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return { ...s, x: s.x + dx, y: s.y + dy } as Shape;
  }
}

/** Reduces freehand points: drops points closer than `minDist` to the previous one. */
export function simplify(points: number[], minDist = 1.5): number[] {
  if (points.length <= 4) return points;
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length - 2; i += 2) {
    const px = out[out.length - 2];
    const py = out[out.length - 1];
    if (Math.hypot(points[i] - px, points[i + 1] - py) >= minDist) out.push(points[i], points[i + 1]);
  }
  out.push(points[points.length - 2], points[points.length - 1]);
  return out;
}
