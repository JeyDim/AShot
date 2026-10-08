// Screenshot editor: annotate (shapes, arrows, text, steps, marker, pixelation), crop,
// then copy / save / upload. The document is stored with the history item, so
// annotations remain editable when the screenshot is opened again.
// Drawing itself lives in `useAnnotator` (shared with the capture overlay).
import { getCurrentWindow } from '@tauri-apps/api/window';
import clsx from 'clsx';
import type Konva from 'konva';
import { Check, Copy, Link2, Maximize, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Image as KImage, Group, Layer, Rect, Stage, Transformer } from 'react-konva';
import { Button, IconButton, Spinner } from '../../components/ui';
import { sizeLabel } from '../../lib/format';
import { useTauriEvent } from '../../lib/hooks';
import { api, errorText, shotUrl } from '../../lib/ipc';
import type { Action, AppSettings, HistoryItem } from '../../lib/types';
import { clampCrop, emptyDoc, historyOf, imageScaleFor, parseDoc, visibleArea, type Crop, type Doc, type History, type Tool } from './model';
import { sourceFromImage, type PixelSource } from './pixelate';
import { Toolbar, TOOLS } from './Toolbar';
import { useAnnotator } from './useAnnotator';

export const TOOL_KEY: Record<string, Tool> = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));
TOOL_KEY['h'] = 'marker';

interface View {
  zoom: number;
  x: number;
  y: number;
}

export default function Editor({ id }: { id: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const cropTrRef = useRef<Konva.Transformer>(null);
  const cropRectRef = useRef<Konva.Rect>(null);

  const [item, setItem] = useState<HistoryItem | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [source, setSource] = useState<PixelSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hist, setHist] = useState<History>(historyOf(emptyDoc()));
  const doc = hist.present;
  const [savedDoc, setSavedDoc] = useState<Doc | null>(null);
  const [tool, setToolState] = useState<Tool>(() => (localStorage.getItem('editor.tool') as Tool) || 'arrow');
  const [color, setColorState] = useState('#FF3B30');
  const [size, setSizeState] = useState(1);
  const [cropDraft, setCropDraft] = useState<Crop | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ w: 800, h: 600 });
  const [busy, setBusy] = useState<Action | null>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [userZoomed, setUserZoomed] = useState(false);
  const [space, setSpace] = useState(false);

  const cropStart = useRef<{ x: number; y: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const prefsLoaded = useRef(false);

  const W = img?.naturalWidth ?? 1;
  const H = img?.naturalHeight ?? 1;
  // Documents drawn on the capture overlay keep the stroke scale of the full screen.
  const k = doc.scale ?? imageScaleFor(W, H);
  const dpr = window.devicePixelRatio || 1;
  const dirty = savedDoc !== null && doc !== savedDoc;
  const cursor = space || panStart.current ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';

  const ann = useAnnotator({ hist, setHist, tool, color, size, k, source, stageRef, view, disabled: tool === 'crop', cursor });

  // ------------------------------------------------------------ loading
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [it, annotations, settings] = await Promise.all([api.historyGet(id), api.historyAnnotations(id), api.settingsGet()]);
        if (cancelled) return;
        setItem(it);
        applyPrefs(settings.settings);
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.src = shotUrl(`history/${id}/original.png?r=${it.revision}`);
        await image.decode();
        if (cancelled) return;
        const d = parseDoc(annotations);
        setImg(image);
        setSource(sourceFromImage(image));
        setHist(historyOf(d));
        setSavedDoc(d);
      } catch (e) {
        setLoadError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const applyPrefs = (s: AppSettings) => {
    if (prefsLoaded.current) return;
    prefsLoaded.current = true;
    setColorState(s.editor.color || '#FF3B30');
    setSizeState(s.editor.size ?? 1);
  };

  useTauriEvent('history:changed', () => {
    api.historyGet(id).then(setItem).catch(() => {});
  });

  // ------------------------------------------------------------ layout & zoom
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const area = tool === 'crop' ? { x: 0, y: 0, w: W, h: H } : visibleArea(doc, W, H);

  const fit = useCallback(
    (a = area) => {
      const pad = 36;
      const z = Math.min((stageSize.w - pad * 2) / a.w, (stageSize.h - pad * 2) / a.h, 1 / dpr);
      const zoom = Math.max(0.02, z);
      setView({ zoom, x: (stageSize.w - a.w * zoom) / 2 - a.x * zoom, y: (stageSize.h - a.h * zoom) / 2 - a.y * zoom });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stageSize.w, stageSize.h, area.x, area.y, area.w, area.h, dpr],
  );

  useEffect(() => {
    if (img && !userZoomed) fit();
  }, [img, fit, userZoomed]);

  const zoomTo = (zoom: number, cx = stageSize.w / 2, cy = stageSize.h / 2) => {
    zoom = Math.min(Math.max(zoom, 0.05), 16 / dpr);
    setUserZoomed(true);
    setView((v) => {
      const ix = (cx - v.x) / v.zoom;
      const iy = (cy - v.y) / v.zoom;
      return { zoom, x: cx - ix * zoom, y: cy - iy * zoom };
    });
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const { deltaX, deltaY, ctrlKey, shiftKey } = e.evt;
    if (ctrlKey) {
      const p = stageRef.current!.getPointerPosition() ?? { x: stageSize.w / 2, y: stageSize.h / 2 };
      zoomTo(view.zoom * (deltaY < 0 ? 1.15 : 1 / 1.15), p.x, p.y);
    } else {
      setUserZoomed(true);
      setView((v) => ({ ...v, x: v.x - (shiftKey ? deltaY : deltaX), y: v.y - (shiftKey ? 0 : deltaY) }));
    }
  };

  // ------------------------------------------------------------ tools & style
  const setTool = (t: Tool) => {
    ann.commitText();
    if (t === 'crop') setCropDraft(doc.crop ?? { x: 0, y: 0, w: W, h: H });
    else setCropDraft(null);
    setToolState(t);
    localStorage.setItem('editor.tool', t);
    if (t !== 'select') ann.setSelectedId(null);
    setUserZoomed(false);
  };

  const savePrefs = (c: string, s: number) => api.settingsPatch({ editor: { color: c, size: s } }).catch(() => {});
  const setColor = (c: string) => {
    setColorState(c);
    savePrefs(c, size);
    ann.setStyle({ color: c });
  };
  const setSize = (s: number) => {
    setSizeState(s);
    savePrefs(color, s);
    ann.setStyle({ size: s });
  };

  // ------------------------------------------------------------ pointer
  const imagePoint = () => stageRef.current!.getRelativePointerPosition() ?? { x: 0, y: 0 };

  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!img) return;
    const stage = stageRef.current!;
    if (e.evt.button === 1 || space) {
      const p = stage.getPointerPosition()!;
      panStart.current = { x: p.x, y: p.y, vx: view.x, vy: view.y };
      return;
    }
    if (e.evt.button !== 0) return;
    if (tool === 'crop') {
      if (e.target === cropRectRef.current || e.target.getParent()?.className === 'Transformer') return;
      const p = imagePoint();
      cropStart.current = p;
      setCropDraft({ x: p.x, y: p.y, w: 0, h: 0 });
      return;
    }
    ann.onMouseDown(e);
  };

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (panStart.current) {
      const p = stage.getPointerPosition()!;
      setUserZoomed(true);
      setView((v) => ({ ...v, x: panStart.current!.vx + p.x - panStart.current!.x, y: panStart.current!.vy + p.y - panStart.current!.y }));
      return;
    }
    if (tool === 'crop' && cropStart.current) {
      const p = imagePoint();
      const start = cropStart.current;
      const x = Math.min(start.x, p.x);
      const y = Math.min(start.y, p.y);
      let w = Math.abs(p.x - start.x);
      let h = Math.abs(p.y - start.y);
      if (e.evt.shiftKey) w = h = Math.max(w, h);
      setCropDraft({ x, y, w, h });
      return;
    }
    ann.onMouseMove(e);
  };

  const onMouseUp = () => {
    if (panStart.current) {
      panStart.current = null;
      return;
    }
    if (cropStart.current) {
      cropStart.current = null;
      return;
    }
    ann.onMouseUp();
  };

  useEffect(() => {
    const tr = cropTrRef.current;
    if (!tr) return;
    tr.nodes(tool === 'crop' && cropRectRef.current && cropDraft && cropDraft.w > 0 ? [cropRectRef.current] : []);
    tr.getLayer()?.batchDraw();
  }, [tool, cropDraft]);

  // ------------------------------------------------------------ crop
  const applyCrop = () => {
    if (!cropDraft) return;
    ann.apply({ ...doc, crop: clampCrop(cropDraft, W, H) });
    setCropDraft(null);
    setToolState('select');
    setUserZoomed(false);
  };
  const resetCrop = () => {
    ann.apply({ ...doc, crop: null });
    setCropDraft({ x: 0, y: 0, w: W, h: H });
  };
  const cancelCrop = () => {
    setCropDraft(null);
    setToolState('select');
    setUserZoomed(false);
  };

  // ------------------------------------------------------------ export & actions
  const renderPng = async (): Promise<Uint8Array> => {
    const stage = stageRef.current!;
    const layer = contentRef.current!;
    const a = visibleArea(doc, W, H);
    const old = { scale: stage.scale(), pos: stage.position() };
    stage.scale({ x: 1, y: 1 });
    stage.position({ x: 0, y: 0 });
    let canvas: HTMLCanvasElement;
    try {
      canvas = layer.toCanvas({ x: a.x, y: a.y, width: a.w, height: a.h, pixelRatio: 1 });
    } finally {
      stage.scale(old.scale);
      stage.position(old.pos);
      stage.batchDraw();
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  };

  const act = async (action: Action) => {
    if (!img || busy) return;
    ann.commitText();
    ann.setSelectedId(null);
    setBusy(action);
    setStatus(null);
    // Let React apply the pending text commit / deselection before rendering.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    try {
      const current = docRef.current;
      const png = await renderPng();
      const res = await api.editorCommit(id, action, png, JSON.stringify({ ...current, scale: k }));
      setSavedDoc(current);
      if (action === 'upload' && res.shareUrl) setStatus({ kind: 'ok', text: 'Ссылка скопирована' });
      if (action === 'copy') setStatus({ kind: 'ok', text: 'Скопировано в буфер обмена' });
      if ((action === 'save' || action === 'saveAs') && res.savedPath) setStatus({ kind: 'ok', text: `Сохранено: ${res.savedPath}` });
    } catch (e) {
      setStatus({ kind: 'error', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const docRef = useRef(doc);
  docRef.current = doc;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const actRef = useRef(act);
  actRef.current = act;

  // Closing with unsaved changes keeps them in the history (temporary storage).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (event) => {
        if (!dirtyRef.current) return;
        event.preventDefault();
        try {
          await actRef.current('store');
        } finally {
          await win.destroy();
        }
      })
      .then((fn) => (unlisten = fn))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (ann.textEdit) return; // the textarea handles its own keys
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const code = e.code;
      if (e.key === ' ') {
        setSpace(true);
        e.preventDefault();
        return;
      }
      if (ctrl) {
        if (code === 'KeyZ' && !e.shiftKey) return (e.preventDefault(), ann.undo());
        if ((code === 'KeyZ' && e.shiftKey) || code === 'KeyY') return (e.preventDefault(), ann.redo());
        if (code === 'KeyC') return (e.preventDefault(), act('copy'));
        if (code === 'KeyS') return (e.preventDefault(), act('saveAs'));
        if (code === 'KeyU') return (e.preventDefault(), act('upload'));
        if (code === 'Digit0') return (e.preventDefault(), setUserZoomed(false), fit());
        if (code === 'Digit1') return (e.preventDefault(), zoomTo(1 / dpr));
        if (code === 'Equal' || code === 'NumpadAdd') return (e.preventDefault(), zoomTo(view.zoom * 1.25));
        if (code === 'Minus' || code === 'NumpadSubtract') return (e.preventDefault(), zoomTo(view.zoom / 1.25));
        return;
      }
      if (tool === 'crop') {
        if (e.key === 'Enter') return applyCrop();
        if (e.key === 'Escape') return cancelCrop();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && ann.removeSelected()) return;
      if (e.key === 'Escape') {
        ann.setSelectedId(null);
        return;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key]) {
        const step = e.shiftKey ? 10 : 1;
        if (ann.nudgeSelected(arrows[e.key][0] * step, arrows[e.key][1] * step)) e.preventDefault();
        return;
      }
      if (['1', '2', '3'].includes(e.key)) return setSize(Number(e.key) - 1);
      const codeKey = code.startsWith('Key') ? code.slice(3).toLowerCase() : key;
      if (TOOL_KEY[codeKey]) setTool(TOOL_KEY[codeKey]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpace(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  });

  // ------------------------------------------------------------ render
  const clip = tool === 'crop' ? null : doc.crop;
  const shownArea = visibleArea(doc, W, H);

  const cropBar =
    tool === 'crop' && cropDraft
      ? {
          left: Math.min(Math.max(8, view.x + (cropDraft.x + cropDraft.w) * view.zoom - 300), stageSize.w - 308),
          top: Math.min(view.y + (cropDraft.y + cropDraft.h) * view.zoom + 12, stageSize.h - 52),
        }
      : null;

  return (
    <div className="flex h-full flex-col bg-bg">
      <Toolbar
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        size={size}
        setSize={setSize}
        canUndo={hist.past.length > 0}
        canRedo={hist.future.length > 0}
        undo={ann.undo}
        redo={ann.redo}
        busy={busy}
        act={act}
      />

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{
          backgroundColor: 'var(--color-canvas)',
          backgroundImage: 'radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-text) 8%, transparent) 1px, transparent 0)',
          backgroundSize: '22px 22px',
        }}
      >
        {!img && (
          <div className="absolute inset-0 flex items-center justify-center text-muted">
            {loadError ? <span className="text-danger">Не удалось открыть снимок: {loadError}</span> : <Spinner size={28} />}
          </div>
        )}
        {img && (
          <Stage
            ref={stageRef}
            width={stageSize.w}
            height={stageSize.h}
            scaleX={view.zoom}
            scaleY={view.zoom}
            x={view.x}
            y={view.y}
            style={{ cursor }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onWheel={onWheel}
            onContextMenu={(e) => e.evt.preventDefault()}
          >
            <Layer ref={contentRef} imageSmoothingEnabled={view.zoom * dpr < 1}>
              <Group clipX={clip?.x} clipY={clip?.y} clipWidth={clip?.w} clipHeight={clip?.h}>
                <Rect x={shownArea.x} y={shownArea.y} width={shownArea.w} height={shownArea.h} shadowColor="black" shadowBlur={30 / view.zoom} shadowOpacity={0.6} fill="#000" listening={false} />
                <KImage image={img} x={0} y={0} width={W} height={H} name="base" />
                {ann.shapeElements}
              </Group>
            </Layer>
            <Layer>
              {ann.uiElements}
              {tool === 'crop' && cropDraft && (
                <>
                  <Group listening={false}>
                    {/* dim outside of the crop */}
                    <Rect x={-1e5} y={-1e5} width={2e5} height={1e5 + cropDraft.y} fill="rgba(0,0,0,0.55)" />
                    <Rect x={-1e5} y={cropDraft.y + cropDraft.h} width={2e5} height={1e5} fill="rgba(0,0,0,0.55)" />
                    <Rect x={-1e5} y={cropDraft.y} width={1e5 + cropDraft.x} height={cropDraft.h} fill="rgba(0,0,0,0.55)" />
                    <Rect x={cropDraft.x + cropDraft.w} y={cropDraft.y} width={1e5} height={cropDraft.h} fill="rgba(0,0,0,0.55)" />
                  </Group>
                  <Rect
                    ref={cropRectRef}
                    x={cropDraft.x}
                    y={cropDraft.y}
                    width={cropDraft.w}
                    height={cropDraft.h}
                    stroke="#fff"
                    strokeWidth={1.5 / view.zoom}
                    dash={[6 / view.zoom, 4 / view.zoom]}
                    draggable
                    onDragMove={(e) => setCropDraft({ ...cropDraft, x: e.target.x(), y: e.target.y() })}
                    onTransform={(e) => {
                      const n = e.target;
                      const w = n.width() * n.scaleX();
                      const h = n.height() * n.scaleY();
                      n.scale({ x: 1, y: 1 });
                      setCropDraft({ x: n.x(), y: n.y(), w, h });
                    }}
                  />
                  <Transformer ref={cropTrRef} rotateEnabled={false} ignoreStroke keepRatio={false} anchorSize={10} anchorStroke="#1E1E20" anchorFill="#B5F000" borderEnabled={false} />
                </>
              )}
            </Layer>
          </Stage>
        )}

        {ann.textArea}

        {cropBar && (
          <div className="animate-pop-in absolute flex items-center gap-1 rounded-[12px] bg-elevated p-1 shadow-(--shadow-pop)" style={{ left: cropBar.left, top: cropBar.top, width: 300 }}>
            <span className="flex-1 px-2 text-[12px] text-muted">{cropDraft && sizeLabel(Math.round(cropDraft.w), Math.round(cropDraft.h))}</span>
            <IconButton tip="Сбросить обрезку" size={32} onClick={resetCrop}>
              <RotateCcw size={16} />
            </IconButton>
            <IconButton tip="Отмена · Esc" size={32} onClick={cancelCrop}>
              <X size={16} />
            </IconButton>
            <Button size="sm" variant="primary" icon={<Check size={15} />} onClick={applyCrop}>
              Обрезать
            </Button>
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[12px] text-muted">
        <span>{img ? sizeLabel(Math.round(shownArea.w), Math.round(shownArea.h)) : '…'}</span>
        {doc.crop && <span className="text-subtle">обрезано из {sizeLabel(W, H)}</span>}
        <span className="truncate text-subtle">{hintFor(tool)}</span>
        <div className="flex-1" />
        {status && (
          <span className={clsx('flex min-w-0 items-center gap-1.5 truncate', status.kind === 'error' ? 'text-danger' : 'text-success')}>
            {status.kind === 'ok' && <Check size={13} />}
            <span className="truncate">{status.text}</span>
          </span>
        )}
        {item?.shareUrl && (
          <button
            onClick={() => api.copyText(item.shareUrl!).then(() => setStatus({ kind: 'ok', text: 'Ссылка скопирована' }))}
            data-tip={item.linkOutdated || dirty ? 'Ссылка на предыдущую версию. Нажмите «Получить ссылку», чтобы загрузить новую' : 'Скопировать ссылку'}
            data-tip-pos="top"
            className="inline-flex items-center gap-1.5 rounded-[7px] bg-surface-2 px-2 py-1 font-mono text-[11.5px] text-text hover:bg-surface-3"
          >
            <Link2 size={12} />
            {item.shortLink}
            {(item.linkOutdated || dirty) && <span className="h-1.5 w-1.5 rounded-full bg-warning" />}
            <Copy size={11} className="opacity-60" />
          </button>
        )}
        <div className="flex items-center gap-0.5">
          <IconButton tip="Уменьшить · Ctrl+−" tipPos="top" size={26} onClick={() => zoomTo(view.zoom / 1.25)}>
            <ZoomOut size={14} />
          </IconButton>
          <button className="w-12 text-center tabular-nums hover:text-text" data-tip="100% · Ctrl+1" data-tip-pos="top" onClick={() => zoomTo(1 / dpr)}>
            {Math.round(view.zoom * dpr * 100)}%
          </button>
          <IconButton tip="Увеличить · Ctrl+=" tipPos="top" size={26} onClick={() => zoomTo(view.zoom * 1.25)}>
            <ZoomIn size={14} />
          </IconButton>
          <IconButton
            tip="По размеру окна · Ctrl+0"
            tipPos="top-left"
            size={26}
            onClick={() => {
              setUserZoomed(false);
              fit();
            }}
          >
            <Maximize size={13} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function hintFor(tool: Tool): string {
  switch (tool) {
    case 'select':
      return 'Клик — выбрать, перетаскивание — переместить, Del — удалить, стрелки — сдвиг';
    case 'rect':
    case 'ellipse':
      return 'Shift — квадрат / круг';
    case 'arrow':
    case 'line':
      return 'Shift — шаг 45°';
    case 'pen':
    case 'marker':
      return 'Shift — прямая линия';
    case 'text':
      return 'Клик — новый текст, Enter — готово, Shift+Enter — новая строка';
    case 'step':
      return 'Клик — следующий номер';
    case 'pixelate':
      return 'Выделите область, которую нужно скрыть';
    case 'crop':
      return 'Выделите область, Enter — обрезать, Esc — отмена';
  }
}
