// Shared drawing logic of the editor and the capture overlay: drafting new shapes,
// selecting / moving / resizing them, in-place text editing, arrow end-point anchors.
// The host owns the Konva Stage (zoom, panning, crop, selection frame) and forwards
// pointer events; each handler returns `true` when the annotator used the event.
import type Konva from 'konva';
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { Circle as KCircle, Transformer } from 'react-konva';
import {
  addShape,
  commit,
  fontSize as fontSizeFor,
  newId,
  nextStep,
  normalizeBox,
  redo as redoH,
  removeShape,
  simplify,
  snapAngle,
  textFontSize,
  translate,
  undo as undoH,
  updateShape,
  type Crop,
  type Doc,
  type History,
  type Shape,
  type TextShape,
  type Tool,
} from './model';
import type { PixelSource } from './pixelate';
import { FONT_FAMILY, ShapeView } from './ShapeView';

const TRANSFORMABLE = new Set(['rect', 'ellipse', 'pixelate', 'text', 'pen', 'marker']);

export interface TextEdit {
  id: string | null;
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  fontSize?: number;
}

export interface AnnotatorView {
  /** CSS pixels per image pixel. */
  zoom: number;
  x: number;
  y: number;
}

export interface AnnotatorOptions {
  hist: History;
  setHist: Dispatch<SetStateAction<History>>;
  tool: Tool;
  color: string;
  size: number;
  /** Stroke scale for big images (see `imageScaleFor`). */
  k: number;
  source: PixelSource | null;
  stageRef: RefObject<Konva.Stage | null>;
  view: AnnotatorView;
  /** New shapes may only start inside this area (overlay selection). */
  drawArea?: Crop | null;
  /** No interaction at all (editor crop mode). */
  disabled?: boolean;
  /** Cursor to restore after hovering an anchor. */
  cursor?: string;
}

export function shapeIdOf(node: Konva.Node | null): string | null {
  let n: Konva.Node | null = node;
  while (n) {
    if (n.hasName('shape')) return n.id();
    n = n.getParent();
  }
  return null;
}

export function isHandle(node: Konva.Node | null): boolean {
  return !!node && (node.getParent()?.className === 'Transformer' || node.hasName('anchor'));
}

export function useAnnotator(o: AnnotatorOptions) {
  const { hist, setHist, tool, color, size, k, source, stageRef, view } = o;
  const doc = hist.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const drawStart = useRef<{ x: number; y: number } | null>(null);
  const gestureStart = useRef<Doc | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const textRef = useRef<TextEdit | null>(null);
  textRef.current = textEdit;

  const selected = doc.shapes.find((s) => s.id === selectedId) ?? null;

  // ------------------------------------------------------------ document updates
  const apply = (next: Doc) => setHist((h) => commit(h, next));
  /** Update based on the latest document (safe inside handlers with stale closures). */
  const applyFn = (fn: (d: Doc) => Doc) => setHist((h) => commit(h, fn(h.present)));
  const live = (next: Doc) => setHist((h) => ({ ...h, present: next }));
  const beginGesture = () => {
    gestureStart.current = docRef.current;
  };
  const endGesture = () => {
    const start = gestureStart.current;
    gestureStart.current = null;
    if (start) setHist((h) => (h.present === start ? h : { past: [...h.past, start].slice(-200), present: h.present, future: [] }));
  };
  const undo = () => {
    setSelectedId(null);
    setHist(undoH);
  };
  const redo = () => {
    setSelectedId(null);
    setHist(redoH);
  };

  // ------------------------------------------------------------ text
  const commitText = () => {
    // Called from blur *and* mousedown — the ref guarantees a single commit.
    const te = textRef.current;
    if (!te) return;
    textRef.current = null;
    const value = te.text.replace(/\s+$/, '');
    if (te.id) {
      const id = te.id;
      applyFn((d) => (value ? updateShape(d, id, { text: value, color: te.color, size: te.size, fontSize: te.fontSize }) : removeShape(d, id)));
    } else if (value) {
      const shape: TextShape = { id: newId(), type: 'text', x: te.x, y: te.y, text: value, color: te.color, size: te.size };
      applyFn((d) => addShape(d, shape));
      setSelectedId(shape.id);
    }
    setTextEdit(null);
  };

  const startTextEdit = (t: TextShape) => {
    setSelectedId(null);
    setTextEdit({ id: t.id, x: t.x, y: t.y, text: t.text, color: t.color, size: t.size, fontSize: t.fontSize });
  };

  /** Applies color / size to the selected shape and the text being edited. */
  const setStyle = (patch: { color?: string; size?: number }) => {
    const cur = docRef.current.shapes.find((s) => s.id === selectedId);
    if (cur) {
      const p: Partial<Shape> = {};
      if (patch.color !== undefined) p.color = patch.color;
      if (patch.size !== undefined) Object.assign(p, cur.type === 'text' ? { size: patch.size, fontSize: undefined } : { size: patch.size });
      applyFn((d) => updateShape(d, cur.id, p));
    }
    if (textEdit) setTextEdit({ ...textEdit, ...(patch.color !== undefined ? { color: patch.color } : {}), ...(patch.size !== undefined ? { size: patch.size, fontSize: undefined } : {}) });
  };

  const removeSelected = (): boolean => {
    if (!selectedId) return false;
    const id = selectedId;
    applyFn((d) => removeShape(d, id));
    setSelectedId(null);
    return true;
  };

  const nudgeSelected = (dx: number, dy: number): boolean => {
    const cur = docRef.current.shapes.find((s) => s.id === selectedId);
    if (!cur) return false;
    applyFn((d) => updateShape(d, cur.id, translate(cur, dx, dy)));
    return true;
  };

  // ------------------------------------------------------------ pointer
  const pointer = () => stageRef.current?.getRelativePointerPosition() ?? { x: 0, y: 0 };
  const inArea = (p: { x: number; y: number }) =>
    !o.drawArea || (p.x >= o.drawArea.x && p.y >= o.drawArea.y && p.x <= o.drawArea.x + o.drawArea.w && p.y <= o.drawArea.y + o.drawArea.h);

  const onMouseDown = (e: Konva.KonvaEventObject<MouseEvent>): boolean => {
    if (o.disabled || e.evt.button !== 0) return false;
    if (textRef.current) {
      commitText();
      if (tool === 'text') return true;
    }
    const target = e.target;
    if (isHandle(target)) return true;
    const hitId = shapeIdOf(target);
    const p = pointer();
    if (tool === 'crop') return false;
    if (tool === 'select') {
      setSelectedId(hitId);
      return hitId !== null;
    }
    if (hitId && hitId === selectedId) return true; // drag the selected shape
    if (!inArea(p)) return false;
    if (tool === 'text') {
      // Keep the browser from moving focus away from the textarea we are about to show.
      e.evt.preventDefault();
      const hit = docRef.current.shapes.find((s) => s.id === hitId);
      if (hit?.type === 'text') {
        startTextEdit(hit);
        return true;
      }
      setSelectedId(null);
      setTextEdit({ id: null, x: p.x, y: p.y - fontSizeFor(size, k) * 0.6, text: '', color, size });
      return true;
    }
    if (tool === 'step') {
      const s: Shape = { id: newId(), type: 'step', x: p.x, y: p.y, n: nextStep(docRef.current.shapes), color, size };
      applyFn((d) => addShape(d, s));
      setSelectedId(s.id);
      return true;
    }
    setSelectedId(null);
    drawStart.current = p;
    const base = { id: newId(), color, size };
    switch (tool) {
      case 'rect':
      case 'ellipse':
      case 'pixelate':
        setDraft({ ...base, type: tool, x: p.x, y: p.y, w: 0, h: 0 });
        break;
      case 'arrow':
      case 'line':
        setDraft({ ...base, type: tool, points: [p.x, p.y, p.x, p.y] });
        break;
      case 'pen':
      case 'marker':
        setDraft({ ...base, type: tool, points: [p.x, p.y] });
        break;
    }
    return true;
  };

  const onMouseMove = (e: Konva.KonvaEventObject<MouseEvent>): boolean => {
    const start = drawStart.current;
    if (!start || !draft) return false;
    const p = pointer();
    const shift = e.evt.shiftKey;
    switch (draft.type) {
      case 'rect':
      case 'ellipse':
      case 'pixelate':
        setDraft({ ...draft, ...normalizeBox(start.x, start.y, p.x, p.y, shift) });
        break;
      case 'arrow':
      case 'line': {
        const [x2, y2] = shift ? snapAngle(start.x, start.y, p.x, p.y) : [p.x, p.y];
        setDraft({ ...draft, points: [start.x, start.y, x2, y2] });
        break;
      }
      case 'pen':
      case 'marker':
        if (shift && draft.points.length >= 2) {
          // straight segment from the first point
          const [x2, y2] = snapAngle(draft.points[0], draft.points[1], p.x, p.y);
          setDraft({ ...draft, points: [draft.points[0], draft.points[1], x2, y2] });
        } else setDraft({ ...draft, points: [...draft.points, p.x, p.y] });
        break;
    }
    return true;
  };

  const onMouseUp = (): boolean => {
    const start = drawStart.current;
    drawStart.current = null;
    if (!start || !draft) return false;
    let ok = true;
    let shape: Shape = draft;
    switch (draft.type) {
      case 'rect':
      case 'ellipse':
      case 'pixelate':
        ok = draft.w >= 3 && draft.h >= 3;
        if (draft.type === 'pixelate') shape = { ...draft, x: Math.round(draft.x), y: Math.round(draft.y), w: Math.round(draft.w), h: Math.round(draft.h) };
        break;
      case 'arrow':
      case 'line':
        ok = Math.hypot(draft.points[2] - draft.points[0], draft.points[3] - draft.points[1]) >= 4;
        break;
      case 'pen':
      case 'marker':
        shape = { ...draft, points: draft.points.length === 2 ? [...draft.points, draft.points[0] + 0.1, draft.points[1] + 0.1] : simplify(draft.points) };
        break;
    }
    setDraft(null);
    if (ok) {
      applyFn((d) => addShape(d, shape));
      setSelectedId(shape.id);
    }
    return true;
  };

  // ------------------------------------------------------------ drag & transform
  const onDragStart = (e: Konva.KonvaEventObject<DragEvent>) => {
    const sid = shapeIdOf(e.target);
    if (sid) setSelectedId(sid);
  };

  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    const node = e.target;
    const sid = shapeIdOf(node);
    const s = docRef.current.shapes.find((x) => x.id === sid);
    if (!s) return;
    let next: Shape;
    switch (s.type) {
      case 'arrow':
      case 'line':
      case 'pen':
      case 'marker':
        next = translate(s, node.x(), node.y());
        node.position({ x: 0, y: 0 });
        break;
      case 'ellipse':
        next = { ...s, x: node.x() - s.w / 2, y: node.y() - s.h / 2 };
        break;
      case 'pixelate':
        next = { ...s, x: Math.round(node.x()), y: Math.round(node.y()) };
        break;
      default:
        next = { ...s, x: node.x(), y: node.y() } as Shape;
    }
    applyFn((d) => updateShape(d, s.id, next));
  };

  const onTransformEnd = (e: Konva.KonvaEventObject<Event>) => {
    const node = e.target;
    const s = docRef.current.shapes.find((x) => x.id === node.id());
    if (!s) return;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scale({ x: 1, y: 1 });
    let next: Shape = s;
    switch (s.type) {
      case 'rect':
      case 'pixelate': {
        const w = Math.max(3, node.width() * sx);
        const h = Math.max(3, node.height() * sy);
        next = { ...s, x: node.x(), y: node.y(), w, h };
        if (s.type === 'pixelate') next = { ...next, x: Math.round(node.x()), y: Math.round(node.y()), w: Math.round(w), h: Math.round(h) } as Shape;
        break;
      }
      case 'ellipse': {
        const w = Math.max(3, s.w * sx);
        const h = Math.max(3, s.h * sy);
        next = { ...s, x: node.x() - w / 2, y: node.y() - h / 2, w, h };
        break;
      }
      case 'text':
        next = { ...s, x: node.x(), y: node.y(), fontSize: Math.max(6, textFontSize(s, k) * sy) };
        break;
      case 'pen':
      case 'marker': {
        const nx = node.x();
        const ny = node.y();
        node.position({ x: 0, y: 0 });
        next = { ...s, points: s.points.map((v, i) => (i % 2 === 0 ? v * sx + nx : v * sy + ny)) };
        break;
      }
    }
    applyFn((d) => updateShape(d, s.id, next));
  };

  // Attach the transformer to the selected node.
  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = selected && TRANSFORMABLE.has(selected.type) && !textEdit ? stageRef.current?.findOne(`#${selected.id}`) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [selected, doc, textEdit, stageRef]);

  // ------------------------------------------------------------ render pieces
  const shapes = draft ? [...doc.shapes, draft] : doc.shapes;
  const shapeElements: ReactNode[] = shapes.map((s) => (
    <ShapeView
      key={s.id}
      shape={s}
      k={k}
      source={source}
      ev={{
        draggable: !o.disabled && tool !== 'crop' && !textEdit && (tool === 'select' || s.id === selectedId),
        visible: !(textEdit && textEdit.id === s.id),
        onDragStart,
        onDragEnd,
        onTransformEnd,
        onDblClick: () => {
          if (s.type === 'text') startTextEdit(s);
        },
      }}
    />
  ));

  const anchorR = 7 / view.zoom;
  const lineSel = selected && (selected.type === 'arrow' || selected.type === 'line') ? selected : null;
  const uiElements = (
    <>
      <Transformer
        ref={trRef}
        rotateEnabled={false}
        ignoreStroke
        keepRatio={selected?.type === 'text'}
        enabledAnchors={selected?.type === 'text' ? ['top-left', 'top-right', 'bottom-left', 'bottom-right'] : undefined}
        anchorSize={9}
        anchorCornerRadius={5}
        anchorStroke="#7b7bff"
        anchorFill="#fff"
        borderStroke="#7b7bff"
        borderDash={[4, 3]}
        padding={4}
        boundBoxFunc={(oldBox, newBox) => (Math.abs(newBox.width) < 4 || Math.abs(newBox.height) < 4 ? oldBox : newBox)}
      />
      {lineSel &&
        [0, 1].map((i) => (
          <KCircle
            key={i}
            name="anchor"
            x={lineSel.points[i * 2]}
            y={lineSel.points[i * 2 + 1]}
            radius={anchorR}
            fill="#fff"
            stroke="#7b7bff"
            strokeWidth={2 / view.zoom}
            draggable
            onDragStart={beginGesture}
            onDragMove={(e) => {
              const pts = [...lineSel.points] as [number, number, number, number];
              let nx = e.target.x();
              let ny = e.target.y();
              if (e.evt.shiftKey) [nx, ny] = snapAngle(pts[(1 - i) * 2], pts[(1 - i) * 2 + 1], nx, ny);
              pts[i * 2] = nx;
              pts[i * 2 + 1] = ny;
              live(updateShape(docRef.current, lineSel.id, { points: pts }));
            }}
            onDragEnd={endGesture}
            onMouseEnter={(e) => (e.target.getStage()!.container().style.cursor = 'move')}
            onMouseLeave={(e) => (e.target.getStage()!.container().style.cursor = o.cursor ?? 'default')}
          />
        ))}
    </>
  );

  const textBox = useMemo(() => {
    if (!textEdit) return null;
    const fs = textEdit.fontSize ?? fontSizeFor(textEdit.size, k);
    return { left: view.x + textEdit.x * view.zoom, top: view.y + textEdit.y * view.zoom, fs: fs * view.zoom };
  }, [textEdit, view.x, view.y, view.zoom, k]);

  const textArea =
    textEdit && textBox ? (
      <textarea
        autoFocus
        ref={(el) => {
          if (el && document.activeElement !== el) requestAnimationFrame(() => el.focus());
        }}
        value={textEdit.text}
        placeholder="Текст"
        onChange={(e) => setTextEdit({ ...textEdit, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            textRef.current = null;
            setTextEdit(null);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commitText();
          }
          e.stopPropagation();
        }}
        onBlur={commitText}
        rows={Math.max(1, textEdit.text.split('\n').length)}
        className="absolute z-20 resize-none overflow-hidden border border-dashed border-accent/70 bg-black/20 p-0 font-bold outline-none placeholder:text-white/40"
        style={{
          left: textBox.left,
          top: textBox.top,
          fontSize: textBox.fs,
          lineHeight: 1.2,
          fontFamily: FONT_FAMILY,
          color: textEdit.color,
          minWidth: textBox.fs * 4,
          width: Math.max(textBox.fs * 4, ...textEdit.text.split('\n').map((l) => l.length * textBox.fs * 0.62 + textBox.fs)),
          caretColor: textEdit.color,
        }}
      />
    ) : null;

  /** Drops drafts, selection and text editing (new capture). */
  const reset = () => {
    drawStart.current = null;
    textRef.current = null;
    setDraft(null);
    setTextEdit(null);
    setSelectedId(null);
  };

  return {
    doc,
    reset,
    selected,
    selectedId,
    setSelectedId,
    draft,
    textEdit,
    commitText,
    setStyle,
    removeSelected,
    nudgeSelected,
    undo,
    redo,
    apply,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    isDrawing: () => drawStart.current !== null,
    shapeElements,
    uiElements,
    textArea,
  };
}

export type Annotator = ReturnType<typeof useAnnotator>;
