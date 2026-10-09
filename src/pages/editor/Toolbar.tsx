import clsx from 'clsx';
import {
  ChevronDown,
  Circle,
  Copy,
  Crop,
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
import { contrastText, MAX_STEP, PALETTE, type Tool } from './model';

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
  stepNext: number;
  setStepNext: (n: number) => void;
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

      <SizePicker size={size} setSize={setSize} color={color} compact={width < 1440} />

      {tool === 'step' && (
        <>
          <Divider />
          <StepPicker value={props.stepNext} onChange={props.setStepNext} color={color} />
        </>
      )}

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
      <Button variant="secondary" icon={<Save size={16} />} loading={busy === 'saveAs'} tip="Сохранить… (куда и под каким именем) · Ctrl+S" onClick={() => act('saveAs')}>
        {width >= 1560 && 'Сохранить'}
      </Button>
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

/** Button with a pop-up panel (color, stroke size). `up`: open above the button. */
function Dropdown({
  tip,
  face,
  up,
  panelClassName = 'flex items-center gap-2 rounded-full p-2',
  children,
}: {
  tip: string;
  face: ReactNode;
  up?: boolean;
  panelClassName?: string;
  children: (close: () => void) => ReactNode;
}) {
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
  return (
    <div ref={ref} className="relative">
      <button
        aria-label={tip}
        aria-expanded={open}
        data-tip={open ? undefined : tip}
        data-tip-pos={up ? 'top' : undefined}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1 rounded-full pr-1.5 pl-2 transition-colors hover:bg-text/6"
      >
        {face}
        <ChevronDown size={14} className={clsx('text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          className={clsx('animate-pop-in fixed z-40 mt-2 bg-elevated shadow-(--shadow-pop) ring-1 ring-border', panelClassName)}
          // `fixed` escapes the scrolling toolbar; `up`: toolbar near the bottom of the screen.
          // `translate`, not `transform`: the pop-in animation owns `transform`.
          style={up ? { translate: '0 calc(-100% - 52px)' } : undefined}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function ColorPicker({ color, setColor, compact, up }: { color: string; setColor: (c: string) => void; compact: boolean; up?: boolean }) {
  if (!compact) {
    return (
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Цвет">
        <Swatches color={color} setColor={setColor} />
      </div>
    );
  }
  return (
    <Dropdown tip="Цвет" up={up} face={<span className="h-[22px] w-[22px] rounded-full ring-2 ring-text/80" style={{ background: color }} />}>
      {(close) => (
        <div className="flex items-center gap-2 px-0.5">
          <Swatches
            color={color}
            setColor={(c) => {
              setColor(c);
              close();
            }}
          />
        </div>
      )}
    </Dropdown>
  );
}

const SIZES = [
  { label: 'Тонко', key: '1', dot: 5 },
  { label: 'Средне', key: '2', dot: 9 },
  { label: 'Толсто', key: '3', dot: 14 },
];

function SizeDot({ size, color }: { size: number; color: string }) {
  const d = SIZES[size]?.dot ?? 9;
  return <span className="rounded-full" style={{ width: d, height: d, background: color }} />;
}

/** Stroke thickness: three buttons, or (compact) a drop-down like the color. */
export function SizePicker({ size, setSize, color, compact, up }: { size: number; setSize: (s: number) => void; color: string; compact: boolean; up?: boolean }) {
  const options = (onPick?: () => void) =>
    SIZES.map((o, i) => (
      <button
        key={i}
        data-tip={`${o.label} · ${o.key}`}
        data-tip-pos={up ? 'top' : undefined}
        aria-label={o.label}
        onClick={() => {
          setSize(i);
          onPick?.();
        }}
        className={clsx('flex h-8 w-8 items-center justify-center rounded-full transition-colors', size === i ? 'bg-surface ring-1 ring-border-strong ring-inset' : 'hover:bg-text/6')}
      >
        <SizeDot size={i} color={color} />
      </button>
    ));
  if (!compact) return <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5">{options()}</div>;
  return (
    <Dropdown
      tip={`Толщина: ${SIZES[size]?.label.toLowerCase() ?? ''}`}
      up={up}
      face={
        <span className="flex h-[22px] w-[22px] items-center justify-center">
          <SizeDot size={size} color={color} />
        </span>
      }
    >
      {(close) => <div className="flex items-center gap-0.5">{options(close)}</div>}
    </Dropdown>
  );
}

/** Number the step tool places next: a drop-down from the number, like the color —
 *  quick picks and a field for any other number (applied as you type). */
export function StepPicker({ value, onChange, color, up }: { value: number; onChange: (n: number) => void; color: string; up?: boolean }) {
  return (
    <Dropdown
      tip="Следующий номер"
      up={up}
      panelClassName="rounded-[18px] p-2"
      face={
        <span
          className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[11px] leading-none font-bold tabular-nums"
          style={{ background: color, color: contrastText(color) }}
        >
          {value}
        </span>
      }
    >
      {(close) => (
        <div className="flex w-[196px] flex-col gap-2">
          <div className="grid grid-cols-5 gap-1" role="listbox" aria-label="Номер">
            {QUICK_STEPS.map((n) => (
              <button
                key={n}
                role="option"
                aria-selected={n === value}
                onClick={() => {
                  onChange(n);
                  close();
                }}
                className={clsx('h-8 rounded-full text-[13px] font-semibold tabular-nums transition-colors', n === value ? 'bg-primary text-on-primary' : 'text-text hover:bg-text/8')}
              >
                {n}
              </button>
            ))}
          </div>
          <StepInput value={value} onChange={onChange} onDone={close} />
        </div>
      )}
    </Dropdown>
  );
}

const QUICK_STEPS = Array.from({ length: 15 }, (_, i) => i + 1);

function StepInput({ value, onChange, onDone }: { value: number; onChange: (n: number) => void; onDone: () => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const step = (d: number) => onChange(Math.min(MAX_STEP, Math.max(1, value + d)));
  return (
    <div className="flex items-center rounded-full bg-surface-2 p-0.5">
      <button aria-label="Меньше" disabled={value <= 1} onClick={() => step(-1)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/6 hover:text-text disabled:opacity-35">
        <Minus size={14} />
      </button>
      <input
        aria-label="Свой номер"
        inputMode="numeric"
        placeholder="Свой"
        value={text}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 3);
          setText(digits);
          if (digits) onChange(parseInt(digits, 10));
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => setText(String(value))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.key === 'ArrowUp' ? 1 : -1);
          } else if (e.key === 'Enter' || e.key === 'Escape') {
            onDone();
          }
        }}
        onWheel={(e) => step(e.deltaY < 0 ? 1 : -1)}
        className="min-w-0 flex-1 bg-transparent text-center text-[13px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-muted"
      />
      <button aria-label="Больше" disabled={value >= MAX_STEP} onClick={() => step(1)} className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/6 hover:text-text disabled:opacity-35">
        <Plus size={14} />
      </button>
    </div>
  );
}
