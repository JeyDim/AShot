import clsx from 'clsx';
import {
  Check,
  ChevronDown,
  Circle,
  Copy,
  Crop,
  Grid3x3,
  Highlighter,
  Link2,
  Maximize2,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveUpRight,
  MoveVertical,
  PenLine,
  Plus,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton, Segmented } from '../../components/ui';
import type { Action, ResizeSettings, ResizeSide } from '../../lib/types';
import { contrastText, MAX_RESIZE, MAX_STEP, MIN_RESIZE, outputSize, PALETTE, type Tool } from './model';

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

/** Tools sharing one toolbar button with a drop-down; the first one is the default. The
 *  button shows the variant picked last (remembered), the keys still pick each tool. */
export const TOOL_GROUPS: { tools: Tool[]; label: string }[] = [
  { tools: ['rect', 'ellipse'], label: 'Прямоугольник или эллипс' },
  { tools: ['pen', 'marker'], label: 'Карандаш или маркер' },
];

const groupStorageKey = (tools: Tool[]) => `tools.group.${tools.join('-')}`;

function storedVariant(tools: Tool[]): Tool {
  try {
    const t = localStorage.getItem(groupStorageKey(tools)) as Tool | null;
    return t && tools.includes(t) ? t : tools[0];
  } catch {
    return tools[0];
  }
}

type ToolDef = (typeof TOOLS)[number];

/** Tool buttons of the editor and the capture overlay: single tools as icon buttons, groups
 *  (rectangle / ellipse, pen / marker) as an icon button plus a narrow drop-down arrow. */
export function ToolButtons({
  tools,
  tool,
  setTool,
  size,
  up,
  tipsUp,
}: {
  tools: ToolDef[];
  tool: Tool;
  setTool: (t: Tool) => void;
  size: number;
  /** Drop-downs open upwards (the overlay bar near the bottom of the screen). */
  up?: boolean;
  /** Tips above the buttons. */
  tipsUp?: boolean;
}) {
  const [variants, setVariants] = useState<Record<string, Tool>>(() =>
    Object.fromEntries(TOOL_GROUPS.map((g) => [groupStorageKey(g.tools), storedVariant(g.tools)])),
  );
  // Whatever picked a grouped tool (button, drop-down, key), the group shows it from now on.
  useEffect(() => {
    const g = TOOL_GROUPS.find((x) => x.tools.includes(tool));
    if (!g) return;
    const key = groupStorageKey(g.tools);
    setVariants((v) => (v[key] === tool ? v : { ...v, [key]: tool }));
    try {
      localStorage.setItem(key, tool);
    } catch {
      /* storage unavailable */
    }
  }, [tool]);

  const tipPos = tipsUp ? 'top' : undefined;
  const items: ReactNode[] = [];
  for (const t of tools) {
    const g = TOOL_GROUPS.find((x) => x.tools.includes(t.id));
    if (!g) {
      items.push(
        <IconButton key={t.id} tip={`${t.label} · ${t.key}`} tipPos={tipPos} active={tool === t.id} size={size} onClick={() => setTool(t.id)}>
          {t.icon}
        </IconButton>,
      );
      continue;
    }
    // The group takes the place of its first tool.
    if (g.tools[0] !== t.id) continue;
    const members = g.tools.map((id) => tools.find((x) => x.id === id)).filter((x): x is ToolDef => !!x);
    const activeIn = g.tools.includes(tool);
    const shown = members.find((m) => m.id === (activeIn ? tool : variants[groupStorageKey(g.tools)])) ?? members[0];
    items.push(
      <Dropdown
        key={t.id}
        tip={g.label}
        up={up}
        face={null}
        panelClassName="rounded-[14px] p-1"
        toggleClassName="flex w-[15px] items-center justify-center self-stretch rounded-full text-muted transition-colors hover:bg-text/6 hover:text-text"
        chevronSize={12}
        before={
          <IconButton tip={`${shown.label} · ${shown.key}`} tipPos={tipPos} active={activeIn} size={size} onClick={() => setTool(shown.id)}>
            {shown.icon}
          </IconButton>
        }
      >
        {(close) => (
          <div className="flex min-w-[196px] flex-col gap-0.5" role="menu" aria-label={g.label}>
            {members.map((m) => (
              <button
                key={m.id}
                role="menuitemradio"
                aria-checked={tool === m.id}
                onClick={() => {
                  setTool(m.id);
                  close();
                }}
                className={clsx(
                  'flex h-9 items-center gap-2.5 rounded-[10px] px-2.5 text-[13px] transition-colors',
                  tool === m.id ? 'bg-primary text-on-primary' : 'text-text hover:bg-text/6',
                )}
              >
                {m.icon}
                <span className="flex-1 text-left">{m.label}</span>
                <span className="font-mono text-[11px] opacity-60">{m.key}</span>
              </button>
            ))}
          </div>
        )}
      </Dropdown>,
    );
  }
  return <>{items}</>;
}

export function Toolbar(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  size: number;
  setSize: (s: number) => void;
  stepNext: number;
  setStepNext: (n: number) => void;
  resize: ResizeSettings;
  setResize: (r: ResizeSettings) => void;
  /** Size of the picture being exported (crop), for the downscaling preview. */
  source: { w: number; h: number } | null;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  busy: Action | null;
  act: (a: Action) => void;
  /** Extra control at the end of the tools (watermark / copyright), for the tools' button size. */
  extra?: (size: number) => ReactNode;
}) {
  const { tool, setTool, color, setColor, size, setSize, busy, act } = props;
  const width = useWindowWidth();
  // The bar never scrolls or wraps: it gets more compact as the window narrows (the widths are
  // what it needs with the widest tool set — the step tool adds its number), and the window is
  // never narrower than the most compact bar (`EDITOR_MIN` in ui.rs).
  const roomy = width >= 1220;
  const pickers = width >= 1460;
  const labels = width >= 1610;
  return (
    <div className={clsx('flex h-[58px] shrink-0 items-center border-b border-border bg-surface px-3', roomy ? 'gap-2' : 'gap-1.5')} data-tauri-drag-region>
      <div className="flex items-center gap-0.5 rounded-full bg-surface-2 p-1" role="toolbar" aria-label="Инструменты">
        <ToolButtons tools={TOOLS} tool={tool} setTool={setTool} size={roomy ? 38 : 33} />
        {props.extra && (
          <>
            <div className="mx-0.5 h-5 w-px shrink-0 bg-border-strong" />
            {props.extra(roomy ? 38 : 33)}
          </>
        )}
      </div>

      <Divider />

      <ColorPicker color={color} setColor={setColor} compact={!pickers} />

      <Divider />

      <SizePicker size={size} setSize={setSize} color={color} compact={!pickers} />

      {tool === 'step' && (
        <>
          <Divider />
          <StepPicker value={props.stepNext} onChange={props.setStepNext} color={color} />
        </>
      )}

      <Divider />

      <IconButton tip="Отменить · Ctrl+Z" size={roomy ? 36 : 32} disabled={!props.canUndo} onClick={props.undo}>
        <Undo2 size={18} />
      </IconButton>
      <IconButton tip="Повторить · Ctrl+Y" size={roomy ? 36 : 32} disabled={!props.canRedo} onClick={props.redo}>
        <Redo2 size={18} />
      </IconButton>

      <div className="min-w-4 flex-1" data-tauri-drag-region />

      <ResizePicker value={props.resize} onChange={props.setResize} source={props.source} />

      <Button variant="secondary" icon={<Copy size={16} />} loading={busy === 'copy'} tip="Копировать в буфер · Ctrl+C" tipPos="left" onClick={() => act('copy')}>
        {labels && 'Копировать'}
      </Button>
      <Button variant="secondary" icon={<Save size={16} />} loading={busy === 'saveAs'} tip="Сохранить… (куда и под каким именем) · Ctrl+S" tipPos="left" onClick={() => act('saveAs')}>
        {labels && 'Сохранить'}
      </Button>
      <Button variant="primary" icon={<Link2 size={17} />} loading={busy === 'upload'} tip="Загрузить в Box и скопировать ссылку · Ctrl+U" tipPos="left" onClick={() => act('upload')}>
        {roomy ? 'Получить ссылку' : width >= 1075 ? 'Ссылка' : null}
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

export function Swatches({ color, setColor }: { color: string; setColor: (c: string) => void }) {
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

/** Button with a pop-up panel (color, stroke size, step number, downscaling). The panel
 *  lives in <body>, so neither a scrolling toolbar nor a blurred bar clips or shifts it;
 *  it stays on screen and prefers to open above the button when `up`. `before` — a control
 *  in front of the button (the downscaling check box). */
export function Dropdown({
  tip,
  face,
  up,
  before,
  panelClassName = 'flex items-center gap-2 rounded-full p-2',
  toggleClassName,
  chevronSize = 14,
  children,
}: {
  tip: string;
  face: ReactNode;
  up?: boolean;
  before?: ReactNode;
  panelClassName?: string;
  /** Replaces the classes of the button that opens the panel. */
  toggleClassName?: string;
  chevronSize?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    // Esc closes the panel only (in the overlay it would cancel the whole capture).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const anchor = ref.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;
    const gap = 8;
    const left = Math.max(gap, Math.min(anchor.left, window.innerWidth - panel.width - gap));
    const below = anchor.bottom + gap;
    const above = anchor.top - gap - panel.height;
    const fitsBelow = below + panel.height <= window.innerHeight - gap;
    setPos({ left, top: Math.max(gap, (up || !fitsBelow) && above >= gap ? above : below) });
  }, [open, up]);
  return (
    <div ref={ref} className="relative flex items-center">
      {before}
      <button
        aria-label={tip}
        aria-expanded={open}
        data-tip={open ? undefined : tip}
        data-tip-pos={up ? 'top' : undefined}
        onClick={() => setOpen((o) => !o)}
        className={toggleClassName ?? clsx('flex h-9 items-center gap-1 rounded-full pr-1.5 transition-colors hover:bg-text/6', before ? 'pl-1.5' : 'pl-2')}
      >
        {face}
        <ChevronDown size={chevronSize} className={clsx('transition-transform', !toggleClassName && 'text-muted', open && 'rotate-180')} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={clsx('animate-pop-in fixed z-50 bg-elevated text-text shadow-(--shadow-pop) ring-1 ring-border', panelClassName)}
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
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

const SIDES: { value: ResizeSide; label: string; short: string; icon: ReactNode }[] = [
  { value: 'width', label: 'по ширине', short: 'Ширина', icon: <MoveHorizontal size={14} /> },
  { value: 'height', label: 'по высоте', short: 'Высота', icon: <MoveVertical size={14} /> },
  { value: 'longest', label: 'по длинной стороне', short: 'Длинная', icon: <Maximize2 size={13} /> },
];
const RESIZE_PRESETS = [640, 740, 1024, 1280, 1920];

function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={clsx(
        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] transition-colors',
        checked ? 'bg-primary text-on-primary' : 'ring-1 ring-border-strong ring-inset',
      )}
    >
      {checked && <Check size={13} strokeWidth={3} />}
    </span>
  );
}

/** "Downscale to N px": a check box on the toolbar plus a drop-down with the side, the size
 *  and "thicken drawings". `source` — the size of the picture being made (for the preview). */
export function ResizePicker({
  value,
  onChange,
  source,
  up,
}: {
  value: ResizeSettings;
  onChange: (r: ResizeSettings) => void;
  source: { w: number; h: number } | null;
  up?: boolean;
}) {
  const side = SIDES.find((x) => x.value === value.side) ?? SIDES[0];
  const set = (patch: Partial<ResizeSettings>) => onChange({ ...value, ...patch });
  const summary = `Уменьшать до ${value.size} px ${side.label}`;
  const out = source ? outputSize({ ...value, enabled: true }, source.w, source.h) : null;
  return (
    <Dropdown
      tip={summary}
      up={up}
      panelClassName="rounded-[18px] p-3"
      before={
        <button
          role="checkbox"
          aria-checked={value.enabled}
          aria-label="Уменьшать картинку"
          data-tip={value.enabled ? `${summary} — включено` : summary}
          data-tip-pos={up ? 'top' : undefined}
          onClick={() => set({ enabled: !value.enabled })}
          className="flex h-9 items-center rounded-full pr-0.5 pl-2"
        >
          <CheckMark checked={value.enabled} />
        </button>
      }
      face={
        <span className={clsx('flex items-center gap-1 text-[12.5px] font-semibold tabular-nums', !value.enabled && 'text-muted')}>
          {side.icon}
          {value.size}
        </span>
      }
    >
      {() => (
        <div className="flex w-[292px] flex-col gap-3 text-[13px]">
          <button role="checkbox" aria-checked={value.enabled} onClick={() => set({ enabled: !value.enabled })} className="flex items-center gap-2.5 text-left font-medium">
            <CheckMark checked={value.enabled} />
            Уменьшать картинку
          </button>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">По стороне</span>
            <Segmented
              value={value.side}
              onChange={(v) => set({ side: v })}
              options={SIDES.map((x) => ({
                value: x.value,
                label: (
                  <>
                    {x.icon}
                    {x.short}
                  </>
                ),
              }))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">Не больше, px</span>
            <div className="flex items-center gap-1">
              <ResizeInput value={value.size} onChange={(size) => set({ size })} />
              {RESIZE_PRESETS.map((n) => (
                <button
                  key={n}
                  onClick={() => set({ size: n })}
                  className={clsx(
                    'h-7 rounded-full px-1.5 text-[12px] tabular-nums transition-colors',
                    value.size === n ? 'bg-primary text-on-primary' : 'text-muted hover:bg-text/8 hover:text-text',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
          <button role="checkbox" aria-checked={value.thicken} onClick={() => set({ thicken: !value.thicken })} className="flex items-start gap-2.5 text-left">
            <CheckMark checked={value.thicken} />
            <span>
              Утолщать линии и текст
              <span className="block text-[12px] text-muted">чтобы после уменьшения они не стали тонкими</span>
            </span>
          </button>
          {source && out && (
            <div className="rounded-[10px] bg-surface-2 px-2.5 py-1.5 text-[12px] text-muted tabular-nums">
              {out.w === source.w && out.h === source.h
                ? `${source.w} × ${source.h} — меньше ${value.size} px, останется как есть`
                : `${source.w} × ${source.h} → ${out.w} × ${out.h}`}
              {!value.enabled && ' (выключено)'}
            </div>
          )}
        </div>
      )}
    </Dropdown>
  );
}

/** Size limit field: applied as you type once the number is big enough. */
function ResizeInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setText(String(value));
  }, [value]);
  return (
    <input
      ref={ref}
      aria-label="Не больше, px"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const digits = e.target.value.replace(/\D/g, '').slice(0, 5);
        setText(digits);
        const n = parseInt(digits, 10);
        if (n >= MIN_RESIZE) onChange(Math.min(MAX_RESIZE, n));
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setText(String(value))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="h-7 w-[58px] shrink-0 rounded-full bg-surface-2 text-center text-[13px] font-semibold tabular-nums outline-none focus:ring-1 focus:ring-border-strong"
    />
  );
}
