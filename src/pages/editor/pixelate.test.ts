import { describe, expect, it } from 'vitest';
import { pixelateArea, type PixelSource } from './pixelate';

function gradient(w: number, h: number): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = x * 10;
      data[i + 1] = y * 10;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

describe('pixelate', () => {
  it('fills blocks with their average color', () => {
    const src = gradient(8, 8);
    const out = pixelateArea(src, 0, 0, 4, 4, 2);
    // block (0..1, 0..1): x avg = 5, y avg = 5
    expect([out[0], out[1], out[3]]).toEqual([5, 5, 255]);
    // pixel (1,1) belongs to the same block
    const i = (1 * 4 + 1) * 4;
    expect([out[i], out[i + 1]]).toEqual([5, 5]);
    // pixel (2,0) → block (2..3): x avg 25
    expect(out[2 * 4]).toBe(25);
  });

  it('aligns blocks to the image grid for offset areas', () => {
    const src = gradient(8, 8);
    const out = pixelateArea(src, 1, 1, 2, 2, 2);
    // (1,1) is in block (0..1,0..1) → avg 5; (2,2) is in block (2..3,2..3) → avg 25
    expect(out[0]).toBe(5);
    expect(out[(1 * 2 + 1) * 4]).toBe(25);
  });

  it('handles empty areas and image edges', () => {
    const src = gradient(4, 4);
    expect(pixelateArea(src, 0, 0, 0, 5, 2)).toHaveLength(0);
    const out = pixelateArea(src, 2, 2, 4, 4, 3); // partly outside the image
    expect(out).toHaveLength(64);
  });
});
