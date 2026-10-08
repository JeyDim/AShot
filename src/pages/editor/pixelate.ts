// Pixelation ("hide sensitive data") computed from the original image pixels, so the
// result is irreversible and identical on screen and in the exported PNG.

export interface PixelSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function sourceFromImage(img: HTMLImageElement): PixelSource {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
}

/** Returns RGBA pixels (w × h) of the pixelated area; blocks are aligned to the image grid. */
export function pixelateArea(src: PixelSource, x: number, y: number, w: number, h: number, cell: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
  if (w <= 0 || h <= 0) return out;
  cell = Math.max(2, Math.round(cell));
  const startBx = Math.floor(x / cell) * cell;
  const startBy = Math.floor(y / cell) * cell;
  for (let by = startBy; by < y + h; by += cell) {
    for (let bx = startBx; bx < x + w; bx += cell) {
      // average of the block (clipped to the image)
      const x0 = Math.max(0, bx);
      const y0 = Math.max(0, by);
      const x1 = Math.min(src.width, bx + cell);
      const y1 = Math.min(src.height, by + cell);
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      if (n) {
        r = Math.round(r / n);
        g = Math.round(g / n);
        b = Math.round(b / n);
      }
      // fill the part of the block inside the requested area
      const fx0 = Math.max(x, bx);
      const fy0 = Math.max(y, by);
      const fx1 = Math.min(x + w, bx + cell);
      const fy1 = Math.min(y + h, by + cell);
      for (let yy = fy0; yy < fy1; yy++) {
        let o = ((yy - y) * w + (fx0 - x)) * 4;
        for (let xx = fx0; xx < fx1; xx++, o += 4) {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = 255;
        }
      }
    }
  }
  return out;
}

export function pixelateCanvas(src: PixelSource, x: number, y: number, w: number, h: number, cell: number): HTMLCanvasElement {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const iw = Math.max(1, Math.round(w));
  const ih = Math.max(1, Math.round(h));
  const c = document.createElement('canvas');
  c.width = iw;
  c.height = ih;
  const pixels = pixelateArea(src, ix, iy, iw, ih, cell);
  c.getContext('2d')!.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, iw, ih), 0, 0);
  return c;
}
