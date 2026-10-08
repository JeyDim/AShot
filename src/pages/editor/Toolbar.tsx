import clsx from 'clsx';
import {
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
import type { ReactNode } from 'react';
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
  return (
    <div className="flex h-[58px] shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface px-3" data-tauri-drag-region>
      <div className="flex items-center gap-0.5 rounded-[12px] bg-surface-2 p-1 ring-1 ring-inset ring-border">
        {TOOLS.map((t) => (
          <IconButton key={t.id} tip={`${t.label} · ${t.key}`} active={tool === t.id} size={38} onClick={() => setTool(t.id)}>
            {t.icon}
          </IconButton>
        ))}
      </div>

      <Divider />

      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Цвет">
        {PALETTE.map((c) => (
          <button
            key={c}
            data-tip={c}
            onClick={() => setColor(c)}
            className={clsx(
              'h-[22px] w-[22px] shrink-0 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110',
              color.toUpperCase() === c ? 'ring-2 ring-white' : 'ring-1 ring-white/15',
            )}
            style={{ background: c }}
          />
        ))}
        <label
          data-tip="Свой цвет"
          className={clsx(
            'relative flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full ring-offset-2 ring-offset-surface',
            PALETTE.includes(color.toUpperCase()) ? 'ring-1 ring-white/15' : 'ring-2 ring-white',
          )}
          style={{ background: PALETTE.includes(color.toUpperCase()) ? 'conic-gradient(#f43, #fc0, #3c6, #09f, #a5d, #f43)' : color }}
        >
          <Plus size={12} className="text-white drop-shadow" />
          <input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>

      <Divider />

      <div className="flex items-center gap-0.5 rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-border">
        {[0, 1, 2].map((s) => (
          <button
            key={s}
            data-tip={['Тонко · 1', 'Средне · 2', 'Толсто · 3'][s]}
            onClick={() => setSize(s)}
            className={clsx('flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors', size === s ? 'bg-surface-3 ring-1 ring-inset ring-white/10' : 'hover:bg-white/5')}
          >
            <span className="rounded-full" style={{ width: [5, 9, 14][s], height: [5, 9, 14][s], background: color }} />
          </button>
        ))}
      </div>

      <Divider />

      <IconButton tip="Отменить · Ctrl+Z" size={36} disabled={!props.canUndo} onClick={props.undo}>
        <Undo2 size={18} />
      </IconButton>
      <IconButton tip="Повторить · Ctrl+Y" size={36} disabled={!props.canRedo} onClick={props.redo}>
        <Redo2 size={18} />
      </IconButton>

      <div className="min-w-4 flex-1" data-tauri-drag-region />

      <Button variant="secondary" icon={<Copy size={16} />} loading={busy === 'copy'} tip="Копировать в буфер · Ctrl+C" onClick={() => act('copy')}>
        <span className="max-[1260px]:hidden">Копировать</span>
      </Button>
      <Button variant="secondary" icon={<Save size={16} />} loading={busy === 'save'} tip="Сохранить в папку снимков · Ctrl+S" onClick={() => act('save')}>
        <span className="max-[1260px]:hidden">Сохранить</span>
      </Button>
      <IconButton tip="Сохранить как… · Ctrl+Shift+S" tipPos="left" size={36} onClick={() => act('saveAs')}>
        <Download size={18} />
      </IconButton>
      <Button variant="primary" icon={<Link2 size={17} />} loading={busy === 'upload'} tip="Загрузить в Box и скопировать ссылку · Ctrl+U" tipPos="left" onClick={() => act('upload')}>
        Получить ссылку
      </Button>
    </div>
  );
}

function Divider() {
  return <div className="mx-0.5 h-7 w-px shrink-0 bg-border" />;
}
