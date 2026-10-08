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
  type BoxShape,
  type Shape,
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
  }
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
