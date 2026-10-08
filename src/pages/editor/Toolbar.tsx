import clsx from 'clsx';
import {
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Download,
  Grid3x3,
  Highlighter,
  Link2,
  Minus,
  MousePointer2,
  MoveUpRight,
  PenLine,
  Plus,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton } from '../../components/ui';
import type { Action } from '../../lib/types';
import { PALETTE, type Tool } from './model';

export const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: 'select', label: 'Выбор и перемещение', key: 'V', icon: <MousePointer2 size={19} /> },
  { id: 'rect', label: 'Прямоугольник', key: 'R', icon: <Square size={19} /> },
  { id: 'ellipse', label: 'Эллипс', key: 'E', icon: <Circle size={19} /> },
  { id: 'arrow', label: 'Стрелка', key: 'A', icon: <MoveUpRight size={20} /> },
  { id: 'line', label: 'Линия', key: 'L', icon: <Minus size={20} className="-rotate-45" /> },
  { id: 'pen', label: 'Карандаш', key: 'P', icon: <PenLine size={19} /> },
  { id: 'marker', label: 'Маркер', key: 'M', icon: <Highlighter size={19} /> },
  { id: 'text', label: 'Текст', key: 'T', icon: <Type size={19} /> },
  {
    id: 'step',
    label: 'Нумерация шагов',
    key: 'N',
    icon: <span className="flex h-[19px] w-[19px] items-center justify-center rounded-full border-2 border-current text-[10px] leading-none font-bold">1</span>,
  },
  { id: 'pixelate', label: 'Скрыть (пикселизация)', key: 'B', icon: <Grid3x3 size={19} /> },
  { id: 'crop', label: 'Обрезка', key: 'C', icon: <Crop size={19} /> },
];

export function Toolbar(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  size: number;
  setSize: (s: number) => void;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  busy: Action | null;
  act: (a: Action) => void;
}) {
  const { tool, setTool, color, setColor, size, setSize, busy, act } = props;
  const width = useWindowWidth();
  return (
    <div className={clsx('flex h-[58px] shrink-0 items-center overflow-x-auto border-b border-border bg-surface px-3', width < 1180 ? 'gap-1.5' : 'gap-2')} data-tauri-drag-region>
      <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-1">
        {TOOLS.map((t) => (
          <IconButton key={t.id} tip={`${t.label} · ${t.key}`} active={tool === t.id} size={width < 1180 ? 33 : 38} onClick={() => setTool(t.id)}>
            {t.icon}
          </IconButton>
        ))}
      </div>

      <Divider />

      <ColorPicker color={color} setColor={setColor} compact={width < 1440} />

      <Divider />

      <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5">
        {[0, 1, 2].map((s) => (
          <button
            key={s}
            data-tip={['Тонко · 1', 'Средне · 2', 'Толсто · 3'][s]}
            onClick={() => setSize(s)}
            className={clsx('flex h-8 w-8 items-center justify-center rounded-full transition-colors', size === s ? 'bg-surface ring-1 ring-inset ring-border-strong' : 'hover:bg-text/6')}
          >
            <span className="rounded-full" style={{ width: [5, 9, 14][s], height: [5, 9, 14][s], background: color }} />
          </button>
        ))}
      </div>

      <Divider />

      <IconButton tip="Отменить · Ctrl+Z" size={width < 1180 ? 32 : 36} disabled={!props.canUndo} onClick={props.undo}>
        <Undo2 size={18} />
      </IconButton>
      <IconButton tip="Повторить · Ctrl+Y" size={width < 1180 ? 32 : 36} disabled={!props.canRedo} onClick={props.redo}>
        <Redo2 size={18} />
      </IconButton>

      <div className="min-w-4 flex-1" data-tauri-drag-region />

      <Button variant="secondary" icon={<Copy size={16} />} loading={busy === 'copy'} tip="Копировать в буфер · Ctrl+C" onClick={() => act('copy')}>
        {width >= 1560 && 'Копировать'}
      </Button>
      <Button variant="secondary" icon={<Save size={16} />} loading={busy === 'save'} tip="Сохранить в папку снимков · Ctrl+S" onClick={() => act('save')}>
        {width >= 1560 && 'Сохранить'}
      </Button>
      <IconButton tip="Сохранить как… · Ctrl+Shift+S" tipPos="left" size={36} onClick={() => act('saveAs')}>
        <Download size={18} />
      </IconButton>
      <Button variant="primary" icon={<Link2 size={17} />} loading={busy === 'upload'} tip="Загрузить в Box и скопировать ссылку · Ctrl+U" tipPos="left" onClick={() => act('upload')}>
        {width >= 1180 ? 'Получить ссылку' : width >= 980 ? 'Ссылка' : null}
      </Button>
    </div>
  );
}

function Divider() {
  return <div className="mx-0.5 h-7 w-px shrink-0 bg-border" />;
}

function useWindowWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

function Swatches({ color, setColor }: { color: string; setColor: (c: string) => void }) {
  const custom = !PALETTE.includes(color.toUpperCase());
  return (
    <>
      {PALETTE.map((c) => (
        <button
          key={c}
          data-tip={c}
          onClick={() => setColor(c)}
          className={clsx(
            'h-[22px] w-[22px] shrink-0 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110',
            color.toUpperCase() === c ? 'ring-2 ring-text' : 'ring-1 ring-text/15',
          )}
          style={{ background: c }}
        />
      ))}
      <label
        data-tip="Свой цвет"
        className={clsx(
          'relative flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-offset-2 ring-offset-surface',
          custom ? 'ring-2 ring-text' : 'ring-1 ring-text/15',
        )}
        style={{ background: custom ? color : 'conic-gradient(#f43, #fc0, #3c6, #09f, #a5d, #f43)' }}
      >
        <Plus size={12} className="text-white drop-shadow" />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </>
  );
}

export function ColorPicker({ color, setColor, compact, up }: { color: string; setColor: (c: string) => void; compact: boolean; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!compact) {
    return (
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Цвет">
        <Swatches color={color} setColor={setColor} />
      </div>
    );
  }
  return (
    <div ref={ref} className="relative">
      <button
        data-tip="Цвет"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-full px-2 transition-colors hover:bg-text/6"
      >
        <span className="h-[22px] w-[22px] rounded-full ring-2 ring-text/80" style={{ background: color }} />
        <ChevronDown size={14} className="text-muted" />
      </button>
      {open && (
        <div
          className="animate-pop-in fixed z-40 mt-2 flex items-center gap-2 rounded-full bg-elevated p-2.5 shadow-(--shadow-pop) ring-1 ring-border"
          // `up`: open above the button (toolbar near the bottom of the screen).
          style={up ? { transform: 'translateY(calc(-100% - 52px))' } : undefined}
        >
          <Swatches
            color={color}
            setColor={(c) => {
              setColor(c);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
