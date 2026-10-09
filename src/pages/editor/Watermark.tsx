// Watermark and copyright of the editor — one button with a drop-down. The watermark repeats
// the text or the picture over the whole screenshot in slanted rows (under the drawings);
// the copyright puts it once, in a corner (it can then be moved and resized like any shape).
// The settings are remembered; the picture lives in the config folder.
import clsx from 'clsx';
import { Copyright, Droplets, ImageIcon, ImagePlus, Type } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Button, IconButton, Segmented } from '../../components/ui';
import type { WatermarkPosition, WatermarkSettings } from '../../lib/types';
import {
  MARK_OPACITY,
  placeStamp,
  stampFontSize,
  stampImageSize,
  watermarkFontSize,
  watermarkItemSize,
  type Crop,
  type StampShape,
  type WatermarkShape,
} from './model';
import { FONT_FAMILY } from './ShapeView';
import { Dropdown, Swatches } from './Toolbar';

/** The chosen picture, decoded. */
export interface Logo {
  src: string;
  width: number;
  height: number;
}

export async function logoFrom(src: string | null): Promise<Logo | null> {
  if (!src) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return { src, width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  }
}

let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(text: string, fontSize: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * fontSize * 0.6;
  measureCtx.font = `600 ${fontSize}px ${FONT_FAMILY}`;
  return measureCtx.measureText(text).width;
}

/** The watermark (over `full`, the whole image) or the copyright (placed in `area`, the visible
 *  part) for the settings; sizes follow `area`, × `scale` for "downscale to N px".
 *  `null` — nothing to put (empty text, no picture). */
export function buildMark(
  ws: WatermarkSettings,
  area: Crop,
  full: Crop,
  logo: Logo | null,
  scale: number,
  id: string,
): StampShape | WatermarkShape | null {
  const text = ws.text.trim();
  if (ws.kind === 'image' ? !logo : !text) return null;
  const common = { id, color: ws.color, size: ws.size, opacity: ws.opacity / 100 };
  if (ws.layout === 'tile') {
    const base = { ...common, type: 'watermark' as const, x: full.x, y: full.y, w: full.w, h: full.h, angle: ws.angle, spacing: ws.spacing };
    if (logo && ws.kind === 'image') {
      const { w, h } = watermarkItemSize(area, ws.size, logo.width, logo.height, scale);
      return { ...base, src: logo.src, itemW: w, itemH: h };
    }
    return { ...base, text, fontSize: Math.round(watermarkFontSize(area, ws.size) * scale) };
  }
  const base = { ...common, type: 'stamp' as const };
  if (logo && ws.kind === 'image') {
    const { w, h } = stampImageSize(area, ws.size, logo.width, logo.height, scale);
    return { ...base, ...placeStamp(area, w, h, ws.position), src: logo.src, w, h };
  }
  const fontSize = Math.round(stampFontSize(area, ws.size) * scale);
  const w = Math.min(textWidth(text, fontSize), area.w);
  return { ...base, ...placeStamp(area, w, fontSize, ws.position), text, fontSize };
}

const POSITIONS: { value: WatermarkPosition; label: string }[] = [
  { value: 'topLeft', label: 'Слева вверху' },
  { value: 'top', label: 'Вверху' },
  { value: 'topRight', label: 'Справа вверху' },
  { value: 'left', label: 'Слева' },
  { value: 'center', label: 'В центре' },
  { value: 'right', label: 'Справа' },
  { value: 'bottomLeft', label: 'Слева внизу' },
  { value: 'bottom', label: 'Внизу' },
  { value: 'bottomRight', label: 'Справа внизу' },
];

const SIZES = [
  { value: 0, label: 'Мелко', px: 10 },
  { value: 1, label: 'Средне', px: 13 },
  { value: 2, label: 'Крупно', px: 16 },
];

const ANGLES = [0, 30, 45];

const SPACINGS = [
  { value: 0, label: 'Часто' },
  { value: 1, label: 'Средне' },
  { value: 2, label: 'Редко' },
];

const LAYOUTS: { value: WatermarkSettings['layout']; label: string; icon: ReactNode }[] = [
  { value: 'tile', label: 'Водяной знак', icon: <Droplets size={13} /> },
  { value: 'corner', label: 'Копирайт', icon: <Copyright size={13} /> },
];

const checker = 'repeating-conic-gradient(var(--color-surface-3) 0 25%, var(--color-surface-2) 0 50%) 0 0 / 12px 12px';

function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-[12px] text-muted">{label}</span>
      {children}
    </div>
  );
}

export function WatermarkPicker({
  value,
  onChange,
  logo,
  onPickLogo,
  onClearLogo,
  placed,
  onToggle,
  onTextFocus,
  onTextBlur,
  size,
}: {
  value: WatermarkSettings;
  /** `typing` — the text is being typed (no undo step per letter). */
  onChange: (v: WatermarkSettings, typing?: boolean) => void;
  logo: Logo | null;
  onPickLogo: () => void;
  onClearLogo: () => void;
  /** The picture has the watermark / copyright. */
  placed: boolean;
  onToggle: () => void;
  onTextFocus: () => void;
  onTextBlur: () => void;
  size: number;
}) {
  const set = (patch: Partial<WatermarkSettings>) => onChange({ ...value, ...patch });
  const tile = value.layout === 'tile';
  const name = tile ? 'водяной знак' : 'копирайт';
  return (
    <Dropdown
      tip="Водяной знак или копирайт"
      face={null}
      panelClassName="rounded-[18px] p-3"
      toggleClassName="flex w-[15px] items-center justify-center self-stretch rounded-full text-muted transition-colors hover:bg-text/6 hover:text-text"
      chevronSize={12}
      before={
        <IconButton tip={placed ? `Убрать ${name}` : `Поставить ${name}`} active={placed} size={size} onClick={onToggle}>
          {tile ? <Droplets size={19} /> : <Copyright size={19} />}
        </IconButton>
      }
    >
      {() => (
        <div className="flex w-[320px] flex-col gap-3 text-[13px]" role="group" aria-label="Водяной знак или копирайт">
          <Segmented
            value={value.layout}
            // Each layout starts with its own opacity: a watermark is faint, a copyright is not.
            onChange={(layout) => set({ layout, opacity: MARK_OPACITY[layout] })}
            className="w-full [&>button]:flex-1"
            options={LAYOUTS.map((l) => ({
              value: l.value,
              label: (
                <>
                  {l.icon}
                  {l.label}
                </>
              ),
            }))}
          />
          <p className="-mt-1 px-1 text-[12px] leading-snug text-muted">
            {tile ? 'Повторяется по всей картинке, под рисунками' : 'Один раз — в выбранном месте, можно двигать'}
          </p>

          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">Что ставить</span>
            <Segmented
              value={value.kind}
              onChange={(kind) => set({ kind })}
              options={[
                {
                  value: 'text',
                  label: (
                    <>
                      <Type size={13} />
                      Текст
                    </>
                  ),
                },
                {
                  value: 'image',
                  label: (
                    <>
                      <ImageIcon size={13} />
                      Картинка
                    </>
                  ),
                },
              ]}
            />
          </div>

          {value.kind === 'text' ? (
            <div className="flex flex-col gap-2">
              <input
                aria-label="Текст водяного знака"
                value={value.text}
                placeholder="© Компания"
                maxLength={200}
                onChange={(e) => onChange({ ...value, text: e.target.value }, true)}
                onFocus={onTextFocus}
                onBlur={onTextBlur}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="h-9 rounded-[10px] bg-surface-2 px-3 text-[13px] outline-none ring-inset placeholder:text-subtle focus:ring-2 focus:ring-lime"
              />
              <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Цвет текста">
                <Swatches color={value.color} setColor={(color) => set({ color })} />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex h-[64px] w-[96px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] ring-1 ring-border ring-inset" style={{ background: checker }}>
                {logo ? <img src={logo.src} alt="" className="max-h-[56px] max-w-[88px] object-contain" /> : <ImageIcon size={22} className="text-muted" />}
              </div>
              <div className="flex min-w-0 flex-col items-start gap-1.5">
                <Button size="sm" variant={logo ? 'secondary' : 'primary'} icon={<ImagePlus size={15} />} onClick={onPickLogo}>
                  {logo ? 'Другая картинка…' : 'Выбрать картинку…'}
                </Button>
                {logo ? (
                  <button onClick={onClearLogo} className="px-1 text-[12px] text-muted transition-colors hover:text-danger">
                    Удалить картинку
                  </button>
                ) : (
                  <span className="px-1 text-[12px] leading-snug text-muted">PNG с прозрачностью, JPG, WebP</span>
                )}
              </div>
            </div>
          )}

          {tile ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Наклон">
                <Segmented value={value.angle} onChange={(angle) => set({ angle })} options={ANGLES.map((a) => ({ value: a, label: `${a}°` }))} className="self-start" />
              </Field>
              <Field label="Размер">
                <SizeChoice value={value.size} onChange={(s) => set({ size: s })} />
              </Field>
              <Field label="Повторы" className="col-span-2">
                <Segmented value={value.spacing} onChange={(spacing) => set({ spacing })} options={SPACINGS} className="self-start" />
              </Field>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <Field label="Где">
                <div className="grid grid-cols-3 gap-0.5 rounded-[10px] bg-surface-2 p-1" role="radiogroup" aria-label="Положение">
                  {POSITIONS.map((p) => (
                    <button
                      key={p.value}
                      role="radio"
                      aria-checked={value.position === p.value}
                      aria-label={p.label}
                      data-tip={p.label}
                      onClick={() => set({ position: p.value })}
                      className="flex h-[22px] w-[30px] items-center justify-center rounded-[6px] transition-colors hover:bg-text/8"
                    >
                      <span className={clsx('rounded-full transition-all', value.position === p.value ? 'h-2.5 w-2.5 bg-primary' : 'h-1.5 w-1.5 bg-text/30')} />
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Размер">
                <SizeChoice value={value.size} onChange={(s) => set({ size: s })} />
              </Field>
            </div>
          )}

          <Field label={`Непрозрачность · ${value.opacity}%`}>
            <input
              type="range"
              aria-label="Непрозрачность"
              min={5}
              max={100}
              step={5}
              value={value.opacity}
              onChange={(e) => set({ opacity: Number(e.target.value) })}
              className="range w-full"
              style={{ '--fill': `${((value.opacity - 5) / 95) * 100}%` } as CSSProperties}
            />
          </Field>

          <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
            <span className="text-[12px] leading-snug text-muted">{placed ? 'Уже на картинке — изменения видны сразу' : 'Изменения здесь сразу ставят его на картинку'}</span>
            <Button size="sm" variant={placed ? 'outline' : 'primary'} onClick={onToggle}>
              {placed ? 'Убрать' : 'Поставить'}
            </Button>
          </div>
        </div>
      )}
    </Dropdown>
  );
}

function SizeChoice({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Segmented
      value={value}
      onChange={onChange}
      className="self-start"
      options={SIZES.map((s) => ({ value: s.value, tip: s.label, label: <span style={{ fontSize: s.px, lineHeight: 1 }}>А</span> }))}
    />
  );
}
