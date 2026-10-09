import { describe, expect, it } from 'vitest';
import {
  addShape,
  calloutTextPosition,
  clampCrop,
  clampStep,
  commit,
  contrastText,
  emptyDoc,
  historyOf,
  nextStep,
  normalizeBox,
  outputSize,
  thickenFactor,
  DEFAULT_RESIZE,
  parseDoc,
  redo,
  simplify,
  snapAngle,
  translate,
  undo,
  type Shape,
} from './model';

describe('editor model', () => {
  it('undo / redo', () => {
    let h = historyOf(emptyDoc());
    const a = addShape(h.present, { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10, color: '#f00', size: 1 });
    h = commit(h, a);
    const b = addShape(h.present, { id: 'b', type: 'step', x: 5, y: 5, n: 1, color: '#f00', size: 1 });
    h = commit(h, b);
    expect(h.present.shapes).toHaveLength(2);
    h = undo(h);
    expect(h.present.shapes).toHaveLength(1);
    h = undo(h);
    expect(h.present.shapes).toHaveLength(0);
    h = undo(h); // no-op
    expect(h.past).toHaveLength(0);
    h = redo(h);
    expect(h.present.shapes).toHaveLength(1);
    // a new change drops the redo stack
    h = commit(h, emptyDoc());
    expect(h.future).toHaveLength(0);
  });

  it('numbers steps', () => {
    const shapes: Shape[] = [
      { id: '1', type: 'step', x: 0, y: 0, n: 1, color: '#f00', size: 1 },
      { id: '2', type: 'step', x: 0, y: 0, n: 4, color: '#f00', size: 1 },
    ];
    expect(nextStep(shapes)).toBe(5);
    expect(nextStep([])).toBe(1);
    // Restarted numbering continues from the last added step, not from the maximum.
    const restarted: Shape[] = [...shapes, { id: '3', type: 'rect', x: 0, y: 0, w: 5, h: 5, color: '#f00', size: 1 }, { id: '4', type: 'step', x: 0, y: 0, n: 2, color: '#f00', size: 1 }];
    expect(nextStep(restarted)).toBe(3);
    expect(clampStep(0)).toBe(1);
    expect(clampStep(12.4)).toBe(12);
    expect(clampStep(5000)).toBe(999);
    expect(clampStep(NaN)).toBe(1);
  });

  it('downscales like the Rust side', () => {
    const on = { ...DEFAULT_RESIZE, enabled: true };
    expect(outputSize(DEFAULT_RESIZE, 1920, 1080)).toEqual({ w: 1920, h: 1080 });
    expect(outputSize(on, 1920, 1080)).toEqual({ w: 740, h: 416 });
    expect(outputSize(on, 500, 900)).toEqual({ w: 500, h: 900 });
    expect(outputSize({ ...on, side: 'height' }, 500, 900)).toEqual({ w: 411, h: 740 });
    expect(outputSize({ ...on, side: 'longest' }, 1080, 1920)).toEqual({ w: 416, h: 740 });
    expect(outputSize(on, 3000, 2)).toEqual({ w: 740, h: 1 });
    expect(thickenFactor(on, 1480, 800)).toBe(2);
    expect(thickenFactor({ ...on, thicken: false }, 1480, 800)).toBe(1);
    expect(thickenFactor(on, 600, 400)).toBe(1);
  });

  it('places callout text away from the arrow head', () => {
    // arrow pointing right: text ends before the tail
    expect(calloutTextPosition([100, 100, 300, 120], 50, 20, 5)).toEqual({ x: 45, y: 90 });
    // pointing left: text starts after the tail
    expect(calloutTextPosition([100, 100, 0, 90], 50, 20, 5)).toEqual({ x: 105, y: 90 });
    // pointing down: text above the tail; up: below
    expect(calloutTextPosition([100, 100, 110, 300], 50, 20, 5)).toEqual({ x: 75, y: 75 });
    expect(calloutTextPosition([100, 100, 90, 0], 50, 20, 5)).toEqual({ x: 75, y: 105 });
  });

  it('geometry helpers', () => {
    expect(normalizeBox(50, 50, 10, 20)).toEqual({ x: 10, y: 20, w: 40, h: 30 });
    expect(normalizeBox(0, 0, 10, 30, true)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
    const [x, y] = snapAngle(0, 0, 100, 4);
    expect(Math.round(x)).toBe(100);
    expect(Math.round(y)).toBe(0);
    const [dx, dy] = snapAngle(0, 0, 50, 52);
    expect(Math.round(dx)).toBe(Math.round(dy));
  });

  it('crop clamping', () => {
    expect(clampCrop({ x: -5, y: 10, w: 50, h: 1000 }, 100, 100)).toEqual({ x: 0, y: 10, w: 45, h: 90 });
    expect(clampCrop({ x: 0, y: 0, w: 100, h: 100 }, 100, 100)).toBeNull(); // whole image = no crop
    expect(clampCrop({ x: 10, y: 10, w: 2, h: 2 }, 100, 100)).toBeNull();
  });

  it('translates shapes', () => {
    expect(translate({ id: 'l', type: 'arrow', points: [0, 0, 10, 10], color: '', size: 0 }, 5, 1)).toMatchObject({ points: [5, 1, 15, 11] });
    expect(translate({ id: 'p', type: 'pen', points: [0, 0, 1, 1], color: '', size: 0 }, 2, 3)).toMatchObject({ points: [2, 3, 3, 4] });
    expect(translate({ id: 't', type: 'text', x: 1, y: 1, text: 'a', color: '', size: 0 }, 2, 3)).toMatchObject({ x: 3, y: 4 });
  });

  it('misc', () => {
    expect(contrastText('#FFCC00')).toBe('#111');
    expect(contrastText('#0A84FF')).toBe('#fff');
    expect(parseDoc('garbage').shapes).toEqual([]);
    expect(parseDoc('{"shapes":[{"id":"x"}],"crop":null}').shapes).toHaveLength(1);
    expect(simplify([0, 0, 0.5, 0.5, 1, 1, 5, 5, 5.2, 5.2, 9, 9])).toEqual([0, 0, 5, 5, 9, 9]);
  });
});
