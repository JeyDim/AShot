// Editor document model. Everything is in image pixel coordinates; the document is
// stored next to the original screenshot so annotations stay editable later.

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

export type Shape = BoxShape | LineShape | PathShape | TextShape | StepShape;

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

export function nextStep(shapes: Shape[]): number {
  return shapes.reduce((m, s) => (s.type === 'step' ? Math.max(m, s.n) : m), 0) + 1;
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
    if (d && Array.isArray(d.shapes)) return { version: 1, shapes: d.shapes, crop: d.crop ?? null };
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
