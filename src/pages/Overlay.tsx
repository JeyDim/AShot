// Full-screen selection overlay (one window per monitor) over the frozen screenshot.
//
// Like Snow Shot / Snipaste: select an area, then draw on it right away — arrows, boxes,
// text, steps, marker, pixelation — and copy / save / get a link without opening the editor.
//
// Mouse: drag — free region; click — the highlighted window / UI element; wheel — bigger /
// smaller UI element; handles — resize; drag inside the selection (Move tool) — move;
// with a drawing tool — draw inside the selection; double click — editor;
// right click — reset selection / cancel.
// Keys: Enter — editor, Ctrl+C — copy, Ctrl+S — save as (cancelling the dialog returns
// here), Ctrl+U — upload & copy link,
// V R E A L P M T N B — tools, 1/2/3 — size, Ctrl+Z / Ctrl+Y — undo / redo, Del — delete shape,
// arrows — move the shape / selection by 1 px (Shift — 10 px, Ctrl — resize the selection),
// F — whole monitor, C — copy color, Esc — cancel.
import clsx from 'clsx';
import type Konva from 'konva';
import { Copy, Download, Link2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Group, Layer, Stage } from 'react-konva';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { IconButton } from '../components/ui';
import { useTauriEvent } from '../lib/hooks';
import { api, shotUrl } from '../lib/ipc';
import type { Action, OverlayPrepare, Rect } from '../lib/types';
import { emptyDoc, historyOf, imageScaleFor, translate, type History, type Tool } from './editor/model';
import type { PixelSource } from './editor/pixelate';
import { ColorPicker, SizePicker, StepPicker, TOOLS } from './editor/Toolbar';
import { isHandle, shapeIdOf, useAnnotator } from './editor/useAnnotator';
import {
  actionBarPosition,
  clamp,
  contains,
  cursorFor,
  fromPoints,
  handlePoint,
  HANDLES,
  hitHandle,
  moveWithin,
  resize,
  rgbToHex,
  topmostAt,
  type Handle,
} from './overlay/geometry';

const OVERLAY_TOOLS = TOOLS.filter((t) => t.id !== 'crop');
const TOOL_BY_KEY: Record<string, Tool> = { ...Object.fromEntries(OVERLAY_TOOLS.map((t) => [t.key.toLowerCase(), t.id])), h: 'marker' };

type PointerLike = { clientX: number; clientY: number; button: number; shiftKey: boolean };

type Phase = 'idle' | 'pending' | 'drawing' | 'selected' | 'moving' | 'resizing';

interface S {
  prep: OverlayPrepare | null;
  img: HTMLImageElement | null;
  sampler: CanvasRenderingContext2D | null;
  bounds: Rect; // monitor rect in local coords (0,0,w,h)
  windows: Rect[]; // local coords, topmost first
  phase: Phase;
  selection: Rect | null;
  hover: Rect | null;
  hoverIsElement: boolean;
  path: Rect[]; // UI element path (local), deepest first
  level: number;
  mouse: { x: number; y: number };
  start: { x: number; y: number };
  dragOrigin: Rect | null;
  handle: Handle | null;
  shift: boolean;
  queryBusy: boolean;
  queryPending: boolean;
  lastQuery: { x: number; y: number };
}

// Selection frame: the lime accent of the design, visible on almost any screenshot.
const ACCENT = '#B5F000';
const SANS = '"Roboto Variable", "Segoe UI", sans-serif';
const MONO = '"Roboto Mono Variable", Consolas, monospace';

function emptyState(): S {
  return {
    prep: null,
    img: null,
    sampler: null,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    windows: [],
    phase: 'idle',
    selection: null,
    hover: null,
    hoverIsElement: false,
    path: [],
    level: 0,
    mouse: { x: -1000, y: -1000 },
    start: { x: 0, y: 0 },
    dragOrigin: null,
    handle: null,
    shift: false,
    queryBusy: false,
    queryPending: false,
    lastQuery: { x: -1, y: -1 },
  };
}

export default function Overlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const s = useRef<S>(emptyState());
  const raf = useRef(0);
  const [imageSrc, setImageSrc] = useState<string>('');
  const [bar, setBar] = useState<{ sel: Rect } | null>(null);
  const [hint, setHint] = useState(true);
  const [mode, setMode] = useState<OverlayPrepare['mode']>('region');
  const [toast, setToast] = useState<string | null>(null);
  const finishing = useRef(false);

  // Drawing on the selection (shared logic with the editor).
  const stageRef = useRef<Konva.Stage>(null);
  const shapesLayerRef = useRef<Konva.Layer>(null);
  const clipRef = useRef<Konva.Group>(null);
  // The last tool is remembered, so a habitual "arrow" user can draw right after selecting.
  const lastTool = (): Tool => {
    try {
      const t = localStorage.getItem('overlay.tool') as Tool | null;
      return t && OVERLAY_TOOLS.some((x) => x.id === t) ? t : 'select';
    } catch {
      return 'select';
    }
  };
  const [tool, setToolState] = useState<Tool>(lastTool);
  const [color, setColor] = useState('#FF3B30');
  const [size, setSize] = useState(1);
  const [hist, setHist] = useState<History>(historyOf(emptyDoc()));
  const [source, setSource] = useState<PixelSource | null>(null);
  const [selectionRev, setSelectionRev] = useState(0);

  /** Physical pixels per CSS pixel. */
  const scale = () => {
    const img = s.current.img;
    return img && img.naturalWidth ? img.naturalWidth / window.innerWidth : window.devicePixelRatio || 1;
  };

  const redraw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => draw());
  }, []);

  const syncBar = () => {
    const st = s.current;
    if (st.phase === 'selected' && st.selection && !st.prep?.autoAction) setBar({ sel: { ...st.selection } });
    else setBar(null);
  };

  // ------------------------------------------------------------ annotations
  const strokeScale = () => {
    const b = s.current.bounds;
    return imageScaleFor(b.width, b.height);
  };
  const sel = s.current.selection;
  const ann = useAnnotator({
    hist,
    setHist,
    tool,
    color,
    size,
    k: strokeScale(),
    source,
    stageRef,
    view: { zoom: 1 / scale(), x: 0, y: 0 },
    drawArea: sel ? { x: sel.x, y: sel.y, w: sel.width, h: sel.height } : null,
    cursor: 'crosshair',
  });
  const annRef = useRef(ann);
  annRef.current = ann;
  const docRef = useRef(hist.present);
  docRef.current = hist.present;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  void selectionRev; // re-render trigger for the selection-dependent props above

  const resetDrawing = () => {
    annRef.current.reset();
    setHist(historyOf(emptyDoc()));
    setToolState(lastTool());
    setSource(null);
  };

  const setTool = (t: Tool) => {
    annRef.current.commitText();
    if (t !== 'select') annRef.current.setSelectedId(null);
    setToolState(t);
    setHint(false);
    try {
      localStorage.setItem('overlay.tool', t);
    } catch {
      /* storage unavailable */
    }
  };

  // Pixelation needs the pixels of the frozen screen — read them only when used.
  useEffect(() => {
    const st = s.current;
    if (source || !st.sampler) return;
    if (tool !== 'pixelate' && !hist.present.shapes.some((sh) => sh.type === 'pixelate')) return;
    const { width, height } = st.bounds;
    setSource({ data: st.sampler.getImageData(0, 0, width, height).data, width, height });
  }, [tool, hist, source]);

  // Last used color / size are shared with the editor.
  useEffect(() => {
    api
      .settingsGet()
      .then((v) => {
        setColor(v.settings.editor.color || '#FF3B30');
        setSize(v.settings.editor.size ?? 1);
      })
      .catch(() => {});
  }, []);
  const changeColor = (c: string) => {
    setColor(c);
    ann.setStyle({ color: c });
    api.settingsPatch({ editor: { color: c, size } }).catch(() => {});
  };
  const changeSize = (v: number) => {
    setSize(v);
    ann.setStyle({ size: v });
    api.settingsPatch({ editor: { color, size: v } }).catch(() => {});
  };

  // ------------------------------------------------------------ drawing
  function draw() {
    const st = s.current;
    const canvas = canvasRef.current;
    if (!canvas || !st.img) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width;
    const H = canvas.height;
    const k = scale();
    ctx.clearRect(0, 0, W, H);

    const focus = st.selection ?? (st.phase === 'idle' ? st.hover : null);
    // Dim everything except the focused area.
    ctx.fillStyle = 'rgba(8, 10, 16, 0.5)';
    if (focus) {
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(focus.x, focus.y, focus.width, focus.height);
      ctx.fill('evenodd');
    } else {
      ctx.fillRect(0, 0, W, H);
    }

    // Crosshair while choosing.
    if (st.phase === 'idle' || st.phase === 'drawing' || st.phase === 'pending') {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      ctx.moveTo(0, st.mouse.y + 0.5);
      ctx.lineTo(W, st.mouse.y + 0.5);
      ctx.moveTo(st.mouse.x + 0.5, 0);
      ctx.lineTo(st.mouse.x + 0.5, H);
      ctx.stroke();
      ctx.restore();
    }

    if (focus) {
      const isSelection = !!st.selection;
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = Math.max(1, Math.round((isSelection ? 2 : 2) * k));
      if (!isSelection && st.hoverIsElement) ctx.setLineDash([6 * k, 4 * k]);
      const lw = ctx.lineWidth;
      ctx.strokeRect(focus.x - lw / 2, focus.y - lw / 2, focus.width + lw, focus.height + lw);
      ctx.restore();

      // Size label above the area (or inside when there is no room).
      const label = `${focus.width} × ${focus.height}`;
      ctx.font = `500 ${Math.round(12 * k)}px ${SANS}`;
      const tw = ctx.measureText(label).width;
      const ph = Math.round(22 * k);
      const pw = tw + 16 * k;
      let lx = focus.x;
      let ly = focus.y - ph - 6 * k;
      if (ly < 4 * k) ly = focus.y + 6 * k;
      lx = Math.min(Math.max(4 * k, lx), W - pw - 4 * k);
      roundRect(ctx, lx, ly, pw, ph, 6 * k);
      ctx.fillStyle = 'rgba(30,30,32,0.88)';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, lx + 8 * k, ly + ph / 2 + 0.5);

      if (isSelection && (st.phase === 'selected' || st.phase === 'moving' || st.phase === 'resizing')) {
        const hs = Math.round(5 * k);
        for (const h of HANDLES) {
          const [hx, hy] = handlePoint(focus, h);
          ctx.beginPath();
          ctx.arc(hx, hy, hs, 0, Math.PI * 2);
          ctx.fillStyle = ACCENT;
          ctx.fill();
          ctx.lineWidth = Math.max(1, 1.5 * k);
          ctx.strokeStyle = '#1E1E20';
          ctx.stroke();
        }
      }
    }

    if (st.prep?.showMagnifier && st.phase !== 'selected' && st.phase !== 'moving' && st.mouse.x >= 0) {
      drawMagnifier(ctx, st, k, W, H);
    }

    // Drawings are clipped to the selection (also while it is being moved / resized).
    const g = clipRef.current;
    if (g) {
      const sel = st.selection ?? { x: 0, y: 0, width: 0, height: 0 };
      g.clip({ x: sel.x, y: sel.y, width: sel.width, height: sel.height });
      g.getLayer()?.batchDraw();
    }
  }

  function drawMagnifier(ctx: CanvasRenderingContext2D, st: S, k: number, W: number, H: number) {
    const img = st.img!;
    const cells = 17;
    const size = Math.round(170 * k);
    const cell = size / cells;
    const infoH = Math.round(50 * k);
    const off = Math.round(26 * k);
    let x = st.mouse.x + off;
    let y = st.mouse.y + off;
    if (x + size > W) x = st.mouse.x - off - size;
    if (y + size + infoH > H) y = st.mouse.y - off - size - infoH;
    const sx = Math.round(st.mouse.x) - Math.floor(cells / 2);
    const sy = Math.round(st.mouse.y) - Math.floor(cells / 2);

    ctx.save();
    roundRect(ctx, x, y, size, size + infoH, 12 * k);
    ctx.fillStyle = '#1E1E20';
    ctx.fill();
    ctx.save();
    roundRect(ctx, x, y, size, size, 12 * k);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, cells, cells, x, y, size, size);
    // pixel grid
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < cells; i++) {
      ctx.moveTo(x + i * cell, y);
      ctx.lineTo(x + i * cell, y + size);
      ctx.moveTo(x, y + i * cell);
      ctx.lineTo(x + size, y + i * cell);
    }
    ctx.stroke();
    // crosshair + center pixel
    const c = Math.floor(cells / 2);
    ctx.fillStyle = 'rgba(181,240,0,0.25)';
    ctx.fillRect(x, y + c * cell, size, cell);
    ctx.fillRect(x + c * cell, y, cell, size);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.strokeRect(x + c * cell, y + c * cell, cell, cell);
    ctx.restore();

    // info: coordinates + color
    const px = Math.min(Math.max(0, Math.round(st.mouse.x)), img.naturalWidth - 1);
    const py = Math.min(Math.max(0, Math.round(st.mouse.y)), img.naturalHeight - 1);
    const bx = st.prep?.monitor.bounds.x ?? 0;
    const by = st.prep?.monitor.bounds.y ?? 0;
    ctx.textBaseline = 'middle';
    const row1 = y + size + infoH * 0.3;
    const row2 = y + size + infoH * 0.7;
    ctx.font = `500 ${Math.round(11.5 * k)}px ${SANS}`;
    ctx.fillStyle = '#9A9A9F';
    ctx.fillText(`X ${px + bx}  Y ${py + by}`, x + 10 * k, row1);
    if (st.sampler) {
      const d = st.sampler.getImageData(px, py, 1, 1).data;
      const hex = rgbToHex(d[0], d[1], d[2]);
      ctx.fillStyle = hex;
      roundRect(ctx, x + 10 * k, row2 - 6 * k, 12 * k, 12 * k, 3 * k);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#F2F2F3';
      ctx.font = `500 ${Math.round(11.5 * k)}px ${MONO}`;
      ctx.fillText(hex, x + 28 * k, row2);
      // "C" key hint
      const kw = 16 * k;
      roundRect(ctx, x + size - 10 * k - kw, row2 - 8 * k, kw, 16 * k, 4 * k);
      ctx.fillStyle = '#2A2A2D';
      ctx.fill();
      ctx.fillStyle = '#9A9A9F';
      ctx.font = `500 ${Math.round(10.5 * k)}px ${SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('C', x + size - 10 * k - kw / 2, row2 + 0.5);
    }
    ctx.restore();
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, size - 1, size + infoH - 1, 12 * k);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.stroke();
  }

  // ------------------------------------------------------------ hover / UI elements
  const local = (r: Rect): Rect => {
    const b = s.current.prep!.monitor.bounds;
    return { x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height };
  };

  function updateHover() {
    const st = s.current;
    if (st.phase !== 'idle') return;
    const { x, y } = st.mouse;
    const pathRect = st.path.length ? st.path[Math.min(st.level, st.path.length - 1)] : null;
    if (pathRect && contains(pathRect, x, y)) {
      st.hover = clamp(pathRect, st.bounds);
      st.hoverIsElement = st.level < st.path.length - 1;
    } else {
      const w = topmostAt(st.windows, x, y);
      st.hover = w ? clamp(w, st.bounds) : st.bounds;
      st.hoverIsElement = false;
    }
    if (st.hover && (st.hover.width < 4 || st.hover.height < 4)) st.hover = st.bounds;
  }

  async function queryElements() {
    const st = s.current;
    if (!st.prep?.uiElements || st.phase !== 'idle') return;
    if (st.queryBusy) {
      st.queryPending = true;
      return;
    }
    st.queryBusy = true;
    const { x, y } = st.mouse;
    st.lastQuery = { x, y };
    const b = st.prep.monitor.bounds;
    try {
      const rects = await api.overlayHitTest(Math.round(x + b.x), Math.round(y + b.y));
      const path = rects.map(local).filter((r) => r.width >= 6 && r.height >= 6);
      // Keep the chosen level when only the deepest element changed size slightly.
      const changed = path.length !== st.path.length || path.some((r, i) => r.x !== st.path[i]?.x || r.width !== st.path[i]?.width);
      st.path = path;
      if (changed) st.level = 0;
      updateHover();
      redraw();
    } catch {
      /* UI Automation unavailable – window highlighting still works */
    } finally {
      st.queryBusy = false;
      if (st.queryPending) {
        st.queryPending = false;
        queryElements();
      }
    }
  }

  // ------------------------------------------------------------ lifecycle
  const prepare = useCallback(
    async (p: OverlayPrepare) => {
      const st = s.current;
      // Events reach every overlay window: take only the picture of our own monitor.
      if (p.label !== getCurrentWindow().label) return;
      if (st.prep?.sessionId === p.sessionId) return;
      finishing.current = false;
      const next = emptyState();
      next.prep = p;
      s.current = next;
      setMode(p.mode);
      setHint(true);
      setBar(null);
      resetDrawing();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = shotUrl(p.image);
      try {
        await img.decode();
      } catch (e) {
        console.error('cannot load frozen screen', e);
        return;
      }
      if (s.current !== next) return;
      next.img = img;
      next.bounds = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
      next.windows = p.windows.map((w) => clamp(local(w.bounds), next.bounds)).filter((r) => r.width > 0 && r.height > 0);
      // Pixel sampler for the color picker.
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const sctx = c.getContext('2d', { willReadFrequently: true });
      sctx?.drawImage(img, 0, 0);
      next.sampler = sctx;
      const canvas = canvasRef.current!;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const [cx, cy] = p.cursor;
      const b = p.monitor.bounds;
      if (cx >= b.x && cy >= b.y && cx < b.x + b.width && cy < b.y + b.height) next.mouse = { x: cx - b.x, y: cy - b.y };
      if (p.preselect) {
        next.selection = clamp(local(p.preselect), next.bounds);
        next.phase = 'selected';
        setHint(false);
      }
      updateHover();
      setImageSrc(img.src);
      draw();
      syncBar();
      // No requestAnimationFrame here: the window is still hidden and hidden pages may not
      // get animation frames. The picture is decoded and drawn, so it can be shown now.
      api.overlayReady(p.sessionId);
      queryElements();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    api.overlayPending().then((p) => p && prepare(p)).catch(() => {});
  }, [prepare]);

  useTauriEvent<OverlayPrepare>('overlay:prepare', (e) => prepare(e.payload));
  useTauriEvent('overlay:reset', () => {
    s.current = emptyState();
    setImageSrc('');
    setBar(null);
    resetDrawing();
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  });

  // ------------------------------------------------------------ actions
  /** Selection image with the drawings on top, as PNG bytes. */
  const renderAnnotated = async (sel: Rect): Promise<Uint8Array> => {
    const st = s.current;
    const out = document.createElement('canvas');
    out.width = sel.width;
    out.height = sel.height;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(st.img!, sel.x, sel.y, sel.width, sel.height, 0, 0, sel.width, sel.height);
    const stage = stageRef.current!;
    const layer = shapesLayerRef.current!;
    const old = { scale: stage.scale(), pos: stage.position() };
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    try {
      ctx.drawImage(layer.toCanvas({ x: sel.x, y: sel.y, width: sel.width, height: sel.height, pixelRatio: 1 }), 0, 0);
    } finally {
      stage.scale(old.scale);
      stage.position(old.pos);
      stage.batchDraw();
    }
    const blob = await new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  };

  const finish = useCallback(async (action: Action, rect?: Rect) => {
    const st = s.current;
    const sel = rect ?? st.selection;
    if (!sel || !st.prep || finishing.current) return;
    if (sel.width < 2 || sel.height < 2) return;
    finishing.current = true;
    const b = st.prep.monitor.bounds;
    const target = { x: Math.round(sel.x + b.x), y: Math.round(sel.y + b.y), width: Math.round(sel.width), height: Math.round(sel.height) };
    try {
      const a = annRef.current;
      a.commitText();
      a.setSelectedId(null);
      // Let React apply a pending text commit before reading the document.
      await new Promise((r) => setTimeout(r, 30));
      // "Save as…": choose the file while the selection is still on screen — cancelling
      // the dialog returns to it instead of closing the capture.
      let savePath: string | undefined;
      if (action === 'saveAs') {
        const picked = await api.overlaySavePath(target.width, target.height);
        if (!picked) {
          finishing.current = false;
          return;
        }
        savePath = picked;
      }
      const shapes = docRef.current.shapes;
      if (!shapes.length) {
        await api.overlayFinish(target, action, savePath);
        return;
      }
      const png = await renderAnnotated({ ...target, x: target.x - b.x, y: target.y - b.y });
      // Document relative to the selection, so the editor can keep editing the drawings.
      const doc = { version: 1, crop: null, scale: strokeScale(), shapes: shapes.map((sh) => translate(sh, -(target.x - b.x), -(target.y - b.y))) };
      await api.overlayFinishAnnotated(target, action, png, JSON.stringify(doc), savePath);
    } catch (e) {
      finishing.current = false;
      console.error(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancel = useCallback(() => {
    finishing.current = true;
    api.overlayCancel();
  }, []);

  const select = (r: Rect) => {
    const st = s.current;
    st.selection = r;
    st.phase = 'selected';
    if (st.prep?.autoAction) {
      finish(st.prep.autoAction, r);
      return;
    }
    syncBar();
    setSelectionRev((v) => v + 1);
  };

  // ------------------------------------------------------------ input
  const point = (e: { clientX: number; clientY: number }) => {
    const k = scale();
    return { x: Math.round(e.clientX * k), y: Math.round(e.clientY * k) };
  };

  const setCursor = (c: string) => {
    const el = stageRef.current?.container();
    if (el && el.style.cursor !== c) el.style.cursor = c;
  };

  const onMouseMove = (e: PointerLike) => {
    const st = s.current;
    if (!st.img) return;
    const p = point(e);
    st.mouse = p;
    st.shift = e.shiftKey;
    const k = scale();
    switch (st.phase) {
      case 'idle':
        updateHover();
        if (Math.abs(p.x - st.lastQuery.x) + Math.abs(p.y - st.lastQuery.y) > 2) queryElements();
        setCursor('crosshair');
        break;
      case 'pending':
      case 'drawing':
        if (st.phase === 'pending') {
          if (Math.abs(p.x - st.start.x) <= 4 * k && Math.abs(p.y - st.start.y) <= 4 * k) break;
          st.phase = 'drawing';
          setHint(false);
        }
        st.selection = clamp(fromPoints(st.start.x, st.start.y, p.x, p.y, e.shiftKey), st.bounds);
        break;
      case 'moving':
        if (st.dragOrigin) st.selection = moveWithin(st.dragOrigin, p.x - st.start.x, p.y - st.start.y, st.bounds);
        break;
      case 'resizing':
        if (st.dragOrigin && st.handle) st.selection = resize(st.dragOrigin, st.handle, p.x, p.y, st.bounds);
        break;
      case 'selected': {
        const h = st.selection ? hitHandle(st.selection, p.x, p.y, 8 * k) : null;
        const inside = !!st.selection && contains(st.selection, p.x, p.y);
        const t = toolRef.current;
        if (h || t === 'select') setCursor(cursorFor(h, inside));
        else setCursor(inside ? (t === 'text' ? 'text' : 'crosshair') : 'default');
        break;
      }
    }
    redraw();
  };

  const onMouseDown = (e: PointerLike) => {
    const st = s.current;
    if (!st.img || e.button !== 0) return;
    const p = point(e);
    st.mouse = p;
    st.start = p;
    const k = scale();
    if (st.phase === 'selected' && st.selection) {
      const h = hitHandle(st.selection, p.x, p.y, 8 * k);
      if (h) {
        st.phase = 'resizing';
        st.handle = h;
        st.dragOrigin = { ...st.selection };
        setBar(null);
        return;
      }
      if (contains(st.selection, p.x, p.y)) {
        st.phase = 'moving';
        st.dragOrigin = { ...st.selection };
        setBar(null);
        return;
      }
      // Outside: start over.
      st.selection = null;
      setBar(null);
    }
    st.phase = 'pending';
    redraw();
  };

  const onMouseUp = (e: PointerLike) => {
    const st = s.current;
    if (!st.img || e.button !== 0) return;
    switch (st.phase) {
      case 'pending':
        // Click: take the highlighted window / element.
        st.phase = 'idle';
        updateHover();
        if (st.hover) select({ ...st.hover });
        break;
      case 'drawing':
        if (st.selection && st.selection.width >= 4 && st.selection.height >= 4) select(st.selection);
        else {
          st.selection = null;
          st.phase = 'idle';
        }
        break;
      case 'moving':
      case 'resizing':
        st.phase = 'selected';
        st.dragOrigin = null;
        st.handle = null;
        syncBar();
        setSelectionRev((v) => v + 1);
        break;
    }
    redraw();
  };

  const onDoubleClick = (e: PointerLike) => {
    const st = s.current;
    const p = point(e);
    if (st.selection && contains(st.selection, p.x, p.y)) finish('edit');
  };

  const onContextMenu = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const st = s.current;
    if (st.selection && st.phase === 'selected' && !st.prep?.preselect && !docRef.current.shapes.length) {
      st.selection = null;
      st.phase = 'idle';
      updateHover();
      syncBar();
      redraw();
    } else {
      cancel();
    }
  };

  // Konva stage on top receives all pointer events and routes them:
  // selection handles → frame; shapes / drawing tool inside the selection → annotator;
  // otherwise → selection logic (new region, moving the frame).
  const stageDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const st = s.current;
    if (!st.img || e.evt.button !== 0) return;
    if (st.phase === 'selected' && st.selection) {
      const p = point(e.evt);
      const frameHandle = hitHandle(st.selection, p.x, p.y, 8 * scale());
      const inside = contains(st.selection, p.x, p.y);
      const toAnnotator = isHandle(e.target) || (!frameHandle && (shapeIdOf(e.target) !== null || (tool !== 'select' && inside)));
      if (toAnnotator && ann.onMouseDown(e)) {
        setHint(false);
        return;
      }
      if (ann.textEdit) ann.commitText();
      if (!frameHandle && inside && tool === 'select') ann.setSelectedId(null);
      // Keep the drawings: no new region once something is drawn.
      if (!frameHandle && !inside && docRef.current.shapes.length) return;
    }
    onMouseDown(e.evt);
  };
  const stageMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (ann.onMouseMove(e)) return;
    onMouseMove(e.evt);
  };
  const stageUp = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (ann.onMouseUp()) return;
    onMouseUp(e.evt);
  };
  const stageDblClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (shapeIdOf(e.target) !== null || tool !== 'select') return;
    onDoubleClick(e.evt);
  };

  const onWheel = (e: { deltaY: number }) => {
    const st = s.current;
    if (st.phase !== 'idle' || st.path.length < 2) return;
    st.level = Math.min(st.path.length - 1, Math.max(0, st.level + (e.deltaY < 0 ? 1 : -1)));
    updateHover();
    redraw();
  };

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const st = s.current;
      if (!st.img) return;
      const a = annRef.current;
      if (a.textEdit) return; // the textarea handles its own keys
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return; // custom step number field
      if (finishing.current) return; // e.g. the "Save as…" dialog is open
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const code = e.code;
      const selected = st.phase === 'selected' && !!st.selection;
      if (e.key === 'Escape') return cancel();
      if (e.key === 'Enter') {
        if (st.selection) return finish('edit');
        if (st.hover) return finish('edit', st.hover);
      }
      if (ctrl && selected) {
        if (code === 'KeyC') return (e.preventDefault(), finish('copy'));
        if (code === 'KeyS') return (e.preventDefault(), finish('saveAs'));
        if (code === 'KeyU') return (e.preventDefault(), finish('upload'));
        if (code === 'KeyZ' && !e.shiftKey) return (e.preventDefault(), a.undo());
        if ((code === 'KeyZ' && e.shiftKey) || code === 'KeyY') return (e.preventDefault(), a.redo());
      }
      if (selected && (e.key === 'Delete' || e.key === 'Backspace') && a.removeSelected()) return;
      if (!ctrl && st.phase !== 'selected' && (code === 'KeyC' || key === 'c') && st.sampler) {
        const px = Math.min(Math.max(0, st.mouse.x), st.bounds.width - 1);
        const py = Math.min(Math.max(0, st.mouse.y), st.bounds.height - 1);
        const d = st.sampler.getImageData(px, py, 1, 1).data;
        const hex = rgbToHex(d[0], d[1], d[2]);
        await api.copyText(hex);
        setToast(`Цвет ${hex} скопирован`);
        window.setTimeout(() => setToast(null), 1400);
        return;
      }
      if (!ctrl && (code === 'KeyF' || key === 'f') && !docRef.current.shapes.length) {
        select({ ...st.bounds });
        return redraw();
      }
      if (!ctrl && selected) {
        const tk = code.startsWith('Key') ? code.slice(3).toLowerCase() : key;
        if (TOOL_BY_KEY[tk]) return setTool(TOOL_BY_KEY[tk]);
        if (['1', '2', '3'].includes(e.key)) return changeSize(Number(e.key) - 1);
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key] && st.selection && st.phase === 'selected') {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = arrows[e.key];
        if (!ctrl && a.nudgeSelected(dx * step, dy * step)) return;
        st.selection = ctrl
          ? clamp({ ...st.selection, width: Math.max(1, st.selection.width + dx * step), height: Math.max(1, st.selection.height + dy * step) }, st.bounds)
          : moveWithin(st.selection, dx * step, dy * step, st.bounds);
        syncBar();
        setSelectionRev((v) => v + 1);
        redraw();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The window can be re-placed after a DPI change: re-layout and redraw.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => {
      setViewport((v) => v + 1);
      syncBar();
      redraw();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => setHint(false), 4000);
    return () => window.clearTimeout(t);
  }, [mode, imageSrc]);

  // ------------------------------------------------------------ render
  const [barSize, setBarSize] = useState({ w: 960, h: 52 });
  const barObserver = useRef<ResizeObserver | null>(null);
  const measureBar = useCallback((el: HTMLDivElement | null) => {
    barObserver.current?.disconnect();
    if (!el) return;
    const update = () => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      setBarSize((old) => (old.w === w && old.h === h ? old : { w, h }));
    };
    barObserver.current = new ResizeObserver(update);
    barObserver.current.observe(el);
    update();
  }, []);
  const k = typeof window !== 'undefined' ? scale() : 1;
  const pixelExact = Math.abs(k - (window.devicePixelRatio || 1)) < 0.01;
  // The toolbar hugs its content; its measured size is used for placement.
  const barW = Math.min(barSize.w, window.innerWidth - 16);
  const barH = barSize.h;
  const barPos = bar
    ? actionBarPosition(
        { x: bar.sel.x / k, y: bar.sel.y / k, width: bar.sel.width / k, height: bar.sel.height / k },
        barW,
        barH,
        window.innerWidth,
        window.innerHeight,
      )
    : null;
  const barUp = !!barPos && barPos.top > window.innerHeight / 2;

  return (
    <div
      className="fixed inset-0 overflow-hidden bg-black select-none"
      onMouseEnter={() => getCurrentWindow().setFocus().catch(() => {})}
      onMouseLeave={() => {
        s.current.mouse = { x: -1000, y: -1000 };
        if (s.current.phase === 'idle') s.current.hover = null;
        redraw();
      }}
    >
      {imageSrc && (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 h-full w-full"
          // Nearest-neighbour only when screen pixels map 1:1 (crisp); otherwise smooth
          // scaling instead of a grainy picture.
          style={{ imageRendering: pixelExact ? 'pixelated' : 'auto' }}
        />
      )}
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {/* Drawings + input surface (stage units = physical pixels of the monitor). */}
      <Stage
        ref={stageRef}
        className="absolute inset-0"
        style={{ cursor: 'crosshair' }}
        width={window.innerWidth}
        height={window.innerHeight}
        scaleX={1 / k}
        scaleY={1 / k}
        onMouseDown={stageDown}
        onMouseMove={stageMove}
        onMouseUp={stageUp}
        onDblClick={stageDblClick}
        onContextMenu={(e) => onContextMenu(e.evt)}
        onWheel={(e) => onWheel(e.evt)}
      >
        <Layer ref={shapesLayerRef}>
          <Group ref={clipRef}>{ann.shapeElements}</Group>
        </Layer>
        <Layer>{ann.uiElements}</Layer>
      </Stage>
      {ann.textArea}

      {hint && imageSrc && (
        <div className="animate-fade-in pointer-events-none absolute top-6 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-surface/95 px-5 py-2.5 text-[13px] text-text shadow-(--shadow-pop)">
          <span className="font-medium">{mode === 'windowPick' ? 'Кликните по окну или элементу' : 'Выделите область или кликните по окну'}</span>
          <span className="text-subtle">·</span>
          <span className="text-muted">колесо — уровень элемента</span>
          <span className="text-subtle">·</span>
          <span className="kbd">C</span>
          <span className="text-muted">цвет</span>
          <span className="text-subtle">·</span>
          <span className="kbd">Esc</span>
          <span className="text-muted">отмена</span>
        </div>
      )}

      {toast && (
        <div className="animate-pop-in pointer-events-none absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-surface/95 px-4 py-2 text-[13px] shadow-(--shadow-pop)">
          {toast}
        </div>
      )}

      {barPos && (
        <div
          ref={measureBar}
          className="animate-pop-in absolute flex w-max flex-wrap items-center justify-end gap-0.5 rounded-[16px] bg-surface/95 p-1 shadow-(--shadow-pop) ring-1 ring-border backdrop-blur"
          style={{ left: barPos.left, top: barPos.top, maxWidth: window.innerWidth - 16 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center" role="toolbar" aria-label="Инструменты">
            {OVERLAY_TOOLS.map((t) => (
              <IconButton key={t.id} tip={`${t.label} · ${t.key}`} tipPos="top" active={tool === t.id} size={34} onClick={() => setTool(t.id)}>
                {t.icon}
              </IconButton>
            ))}
          </div>
          <BarDivider />
          <ColorPicker color={color} setColor={changeColor} compact up={barUp} />
          <SizePicker size={size} setSize={changeSize} color={color} compact up={barUp} />
          {tool === 'step' && <StepPicker value={ann.stepNext} onChange={ann.setStepNext} color={color} up={barUp} />}
          <BarDivider />
          <BarButton tip="Копировать · Ctrl+C" onClick={() => finish('copy')}>
            <Copy size={18} />
          </BarButton>
          <BarButton tip="Сохранить… (куда и под каким именем) · Ctrl+S" onClick={() => finish('saveAs')}>
            <Download size={18} />
          </BarButton>
          <button
            data-tip="Загрузить в Box и скопировать ссылку · Ctrl+U"
            data-tip-pos="top-left"
            onClick={() => finish('upload')}
            className="ml-0.5 inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-lime px-3.5 text-[13.5px] font-medium text-on-lime transition hover:brightness-105"
          >
            <Link2 size={17} /> Ссылка
          </button>
          <BarButton tip="Отмена · Esc" onClick={cancel} danger>
            <X size={18} />
          </BarButton>
        </div>
      )}
    </div>
  );
}

function BarDivider() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" />;
}

function BarButton({ children, tip, onClick, danger }: { children: ReactNode; tip: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      data-tip={tip}
      data-tip-pos="top"
      onClick={onClick}
      className={clsx(
        'inline-flex h-9 w-9 items-center justify-center rounded-full text-text transition-colors',
        danger ? 'hover:bg-danger/20 hover:text-danger' : 'hover:bg-text/10',
      )}
    >
      {children}
    </button>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
