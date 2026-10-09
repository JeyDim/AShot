import { describe, expect, it } from 'vitest';
import { actionBarPosition, bounding, clamp, fromPoints, hitHandle, moveWithin, resize, rgbToHex, topmostAt, within } from './geometry';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe('overlay geometry', () => {
  it('normalises drag in any direction', () => {
    expect(fromPoints(100, 100, 50, 20)).toEqual({ x: 50, y: 20, width: 50, height: 80 });
    expect(fromPoints(10, 10, 30, 60, true)).toEqual({ x: 10, y: 10, width: 50, height: 50 });
    expect(fromPoints(10, 10, -30, 20, true)).toEqual({ x: -30, y: 10, width: 40, height: 40 });
  });

  it('clamps and moves inside the monitor', () => {
    expect(clamp({ x: -10, y: 1000, width: 100, height: 200 }, screen)).toEqual({ x: 0, y: 1000, width: 90, height: 80 });
    expect(moveWithin({ x: 1800, y: 10, width: 200, height: 100 }, 50, -50, screen)).toEqual({ x: 1720, y: 0, width: 200, height: 100 });
  });

  it('tells a selection that reaches another monitor', () => {
    expect(within({ x: 0, y: 0, width: 1920, height: 1080 }, screen)).toBe(true);
    expect(within({ x: 1800, y: 10, width: 200, height: 100 }, screen)).toBe(false);
    expect(within({ x: -1, y: 10, width: 20, height: 20 }, screen)).toBe(false);
    // A 2K monitor on the left, a bit lower: the virtual screen covers both.
    const desktop = bounding([screen, { x: -2560, y: 200, width: 2560, height: 1440 }]);
    expect(desktop).toEqual({ x: -2560, y: 0, width: 4480, height: 1640 });
    expect(moveWithin({ x: 10, y: 10, width: 200, height: 100 }, -50, 0, desktop).x).toBe(-40);
  });

  it('resizes with handles and flips', () => {
    const r = { x: 100, y: 100, width: 100, height: 100 };
    expect(resize(r, 'se', 300, 250, screen)).toEqual({ x: 100, y: 100, width: 200, height: 150 });
    expect(resize(r, 'w', 250, 0, screen)).toEqual({ x: 200, y: 100, width: 50, height: 100 });
    expect(hitHandle(r, 201, 99, 6)).toBe('ne');
    expect(hitHandle(r, 150, 150, 6)).toBeNull();
  });

  it('finds the topmost window', () => {
    const windows = [
      { x: 100, y: 100, width: 200, height: 200 },
      { x: 0, y: 0, width: 1000, height: 800 },
    ];
    expect(topmostAt(windows, 150, 150)).toBe(windows[0]);
    expect(topmostAt(windows, 500, 500)).toBe(windows[1]);
    expect(topmostAt(windows, 1500, 900)).toBeNull();
  });

  it('places the action bar', () => {
    // room below
    expect(actionBarPosition({ x: 100, y: 100, width: 400, height: 200 }, 300, 50, 1920, 1080)).toEqual({ left: 200, top: 310 });
    // no room below → above
    expect(actionBarPosition({ x: 100, y: 900, width: 400, height: 170 }, 300, 50, 1920, 1080).top).toBe(840);
    // full screen selection → inside
    const inside = actionBarPosition({ x: 0, y: 0, width: 1920, height: 1080 }, 300, 50, 1920, 1080);
    expect(inside.top).toBe(1020);
  });

  it('hex colors', () => {
    expect(rgbToHex(255, 59, 48)).toBe('#FF3B30');
  });
});
