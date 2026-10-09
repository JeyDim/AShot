// Konva rendering of editor shapes.
import type Konva from 'konva';
import { useEffect, useMemo, useState } from 'react';
import { Arrow, Circle, Ellipse, Group, Image as KImage, Line, Rect, Text } from 'react-konva';
import {
  contrastText,
  markerWidth,
  pixelCell,
  stepRadius,
  strokeWidth,
  textFontSize,
  watermarkTile,
  type BoxShape,
  type Shape,
  type StampShape,
  type WatermarkShape,
} from './model';
import { pixelateCanvas, type PixelSource } from './pixelate';

export const FONT_FAMILY = '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif';

export interface ShapeEvents {
  draggable: boolean;
  visible?: boolean;
  onPointerDown?: (e: Konva.KonvaEventObject<MouseEvent>) => void;
  onDragStart?: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd?: (e: Konva.KonvaEventObject<DragEvent>) => void;
  onTransformEnd?: (e: Konva.KonvaEventObject<Event>) => void;
  onDblClick?: (e: Konva.KonvaEventObject<MouseEvent>) => void;
}

export function ShapeView({ shape, k, source, ev }: { shape: Shape; k: number; source: PixelSource | null; ev: ShapeEvents }) {
  const common = {
    id: shape.id,
    name: 'shape',
    draggable: ev.draggable,
    visible: ev.visible ?? true,
    onMouseDown: ev.onPointerDown,
    onDragStart: ev.onDragStart,
    onDragEnd: ev.onDragEnd,
    onTransformEnd: ev.onTransformEnd,
    onDblClick: ev.onDblClick,
    perfectDrawEnabled: false,
  };
  switch (shape.type) {
    case 'rect': {
      const sw = strokeWidth(shape.size, k);
      return (
        <Rect
          {...common}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          stroke={shape.color}
          strokeWidth={sw}
          cornerRadius={Math.min(sw * 1.5, shape.w / 2, shape.h / 2)}
          fill={shape.fill ? shape.color : undefined}
          strokeScaleEnabled={false}
          hitStrokeWidth={Math.max(14, sw + 10)}
          fillEnabled={!!shape.fill}
          shadowColor="rgba(0,0,0,0.35)"
          shadowBlur={sw * 1.5}
          shadowOffsetY={sw * 0.4}
          shadowForStrokeEnabled
        />
      );
    }
    case 'ellipse': {
      const sw = strokeWidth(shape.size, k);
      return (
        <Ellipse
          {...common}
          x={shape.x + shape.w / 2}
          y={shape.y + shape.h / 2}
          radiusX={shape.w / 2}
          radiusY={shape.h / 2}
          stroke={shape.color}
          strokeWidth={sw}
          strokeScaleEnabled={false}
          hitStrokeWidth={Math.max(14, sw + 10)}
          fillEnabled={false}
          shadowColor="rgba(0,0,0,0.35)"
          shadowBlur={sw * 1.5}
          shadowOffsetY={sw * 0.4}
        />
      );
    }
    case 'arrow': {
      const sw = strokeWidth(shape.size, k);
      const head = Math.max(12 * k, sw * 3.4);
      return (
        <Arrow
          {...common}
          points={shape.points}
          stroke={shape.color}
          fill={shape.color}
          strokeWidth={sw}
          pointerLength={head}
          pointerWidth={head * 0.95}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(16, sw + 12)}
          shadowColor="rgba(0,0,0,0.35)"
          shadowBlur={sw * 1.5}
          shadowOffsetY={sw * 0.4}
        />
      );
    }
    case 'line':
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={strokeWidth(shape.size, k)}
          lineCap="round"
          hitStrokeWidth={Math.max(16, strokeWidth(shape.size, k) + 12)}
          shadowColor="rgba(0,0,0,0.35)"
          shadowBlur={strokeWidth(shape.size, k) * 1.5}
        />
      );
    case 'pen':
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={strokeWidth(shape.size, k)}
          tension={0.35}
          lineCap="round"
          lineJoin="round"
          hitStrokeWidth={Math.max(16, strokeWidth(shape.size, k) + 12)}
        />
      );
    case 'marker':
      return (
        <Line
          {...common}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={markerWidth(shape.size, k)}
          opacity={0.42}
          tension={0.2}
          lineCap="round"
          lineJoin="round"
        />
      );
    case 'text': {
      const fs = textFontSize(shape, k);
      const halo = contrastText(shape.color) === '#111' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)';
      return (
        <Text
          {...common}
          x={shape.x}
          y={shape.y}
          text={shape.text}
          fontSize={fs}
          fontFamily={FONT_FAMILY}
          fontStyle="bold"
          lineHeight={1.2}
          fill={shape.color}
          stroke={halo}
          strokeWidth={Math.max(2, fs * 0.14)}
          fillAfterStrokeEnabled
          lineJoin="round"
        />
      );
    }
    case 'step': {
      const r = stepRadius(shape.size, k);
      const label = String(shape.n);
      return (
        <Group {...common} x={shape.x} y={shape.y}>
          <Circle radius={r} fill={shape.color} stroke="#fff" strokeWidth={Math.max(2, r * 0.14)} shadowColor="rgba(0,0,0,0.45)" shadowBlur={r * 0.6} shadowOffsetY={r * 0.12} />
          <Text
            text={label}
            width={r * 2}
            height={r * 2}
            offsetX={r}
            offsetY={r}
            align="center"
            verticalAlign="middle"
            fontSize={r * (label.length > 1 ? 1.0 : 1.2)}
            fontStyle="bold"
            fontFamily={FONT_FAMILY}
            fill={contrastText(shape.color)}
            listening={false}
          />
        </Group>
      );
    }
    case 'pixelate':
      return <PixelateView shape={shape} k={k} source={source} common={common} />;
    case 'stamp':
      return <StampView shape={shape} common={common} />;
    case 'watermark':
      return <WatermarkView shape={shape} />;
  }
}

/** The picture of a data URL, once decoded. */
function useLoadedImage(src: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) return setImg(null);
    let alive = true;
    const image = new Image();
    image.onload = () => alive && setImg(image);
    image.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return img;
}

/** Shadow that keeps a text readable on any background: dark under light colors. */
const halo = (color: string) => (contrastText(color) === '#111' ? '#000' : '#fff');

/** Copyright: a text with a soft contrasting shadow, or the chosen picture. */
function StampView({ shape, common }: { shape: StampShape; common: Record<string, unknown> }) {
  const img = useLoadedImage(shape.src);
  if (shape.src) {
    if (!img) return null;
    return <KImage {...common} image={img} x={shape.x} y={shape.y} width={shape.w ?? img.naturalWidth} height={shape.h ?? img.naturalHeight} opacity={shape.opacity} />;
  }
  const fs = shape.fontSize ?? 24;
  return (
    <Text
      {...common}
      x={shape.x}
      y={shape.y}
      text={shape.text ?? ''}
      fontSize={fs}
      fontFamily={FONT_FAMILY}
      fontStyle="600"
      fill={shape.color}
      opacity={shape.opacity}
      shadowColor={halo(shape.color)}
      shadowOpacity={0.55}
      shadowBlur={Math.max(2, fs * 0.18)}
      shadowOffsetY={Math.max(1, fs * 0.04)}
    />
  );
}

function PixelateView({
  shape,
  k,
  source,
  common,
}: {
  shape: BoxShape;
  k: number;
  source: PixelSource | null;
  common: Record<string, unknown>;
}) {
  // Live position while dragging so the pixelation follows the area under it.
  const [pos, setPos] = useState({ x: shape.x, y: shape.y });
  useEffect(() => setPos({ x: shape.x, y: shape.y }), [shape.x, shape.y]);
  const canvas = useMemo(
    () => (source && shape.w >= 1 && shape.h >= 1 ? pixelateCanvas(source, pos.x, pos.y, shape.w, shape.h, pixelCell(shape.size, k)) : null),
    [source, pos.x, pos.y, shape.w, shape.h, shape.size, k],
  );
  if (!canvas) return null;
  return (
    <KImage
      {...common}
      image={canvas}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      imageSmoothingEnabled={false}
      onDragMove={(e) => {
        const n = e.target;
        requestAnimationFrame(() => setPos({ x: Math.round(n.x()), y: Math.round(n.y()) }));
      }}
    />
  );
}

/** Watermark: one pattern tile (the brick layout of `watermarkTile`) repeated over the whole
 *  picture and turned by the angle; it never takes clicks. */
function WatermarkView({ shape }: { shape: WatermarkShape }) {
  const img = useLoadedImage(shape.src);
  const tile = useMemo(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const fs = shape.fontSize ?? 48;
    const font = `600 ${fs}px ${FONT_FAMILY}`;
    let w: number;
    let h: number;
    if (shape.src) {
      if (!img) return null;
      w = shape.itemW ?? img.naturalWidth;
      h = shape.itemH ?? img.naturalHeight;
    } else {
      if (!shape.text) return null;
      ctx.font = font;
      w = ctx.measureText(shape.text).width;
      h = fs;
    }
    const { tw, th, centers } = watermarkTile(w, h, shape.spacing);
    c.width = tw;
    c.height = th;
    for (const [cx, cy] of centers) {
      if (img && shape.src) {
        ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      } else {
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = halo(shape.color);
        ctx.shadowBlur = Math.max(2, fs * 0.12);
        ctx.fillStyle = shape.color;
        ctx.fillText(shape.text!, cx, cy);
      }
    }
    return c;
  }, [img, shape.src, shape.text, shape.fontSize, shape.itemW, shape.itemH, shape.color, shape.spacing]);
  if (!tile) return null;
  return (
    <Rect
      id={shape.id}
      name="watermark"
      listening={false}
      perfectDrawEnabled={false}
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      // A canvas works as a pattern image too.
      fillPatternImage={tile as unknown as HTMLImageElement}
      fillPatternRepeat="repeat"
      fillPatternRotation={-shape.angle}
      opacity={shape.opacity}
    />
  );
}
