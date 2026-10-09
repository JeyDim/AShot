// Watermark and copyright of the editor and of the capture overlay — one button with a
// drop-down. The watermark repeats the text or the picture over the whole screenshot in slanted
// rows (under the drawings); the copyright puts it once, in a corner (it can then be moved and
// resized like any shape). The settings are remembered; the picture lives in the config folder.
import clsx from 'clsx';
import { Copyright, Droplets, ImageIcon, ImagePlus, Type } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, IconButton, Segmented } from '../../components/ui';
import { api, errorText, loadWatermarkLogo } from '../../lib/ipc';
import type { WatermarkPosition, WatermarkSettings } from '../../lib/types';
import {
  DEFAULT_WATERMARK,
  isMark,
  MARK_OPACITY,
  newId,
  placeStamp,
  removeShape,
  stampFontSize,
  stampImageSize,
  watermarkFontSize,
  watermarkItemSize,
  type Crop,
  type Doc,
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

/** Where the mark goes in a document: `area` — the part that is shown (the copyright's corner,
 *  the sizes), `full` — what the watermark covers, `scale` — the "downscale to N px" thickening. */
export interface MarkFrame {
  area: Crop;
  full: Crop;
  scale: number;
}

/** What the mark needs from the drawing (`useAnnotator`). */
interface MarkHost {
  apply: (d: Doc) => void;
  /** A change without an undo step of its own. */
  live: (d: Doc) => void;
  commitText: () => void;
  setSelectedId: (id: string | null) => void;
  beginGesture: () => void;
  endGesture: () => void;
}

/** The watermark / copyright button of a drawing: its settings (remembered), the picture and
 *  the mark in the document. `frame` — where it goes; `null` while there is no picture yet. */
export function useWatermark({ doc, host, frame, onError }: { doc: Doc; host: MarkHost; frame: (d: Doc) => MarkFrame | null; onError: (text: string) => void }) {
  const [settings, setSettings] = useState<WatermarkSettings>(DEFAULT_WATERMARK);
  const [logo, setLogo] = useState<Logo | null>(null);
  const touched = useRef(false);
  const save = useRef<number | undefined>(undefined);
  const mark = doc.shapes.find(isMark) ?? null;

  useEffect(() => {
    let cancelled = false;
    loadWatermarkLogo()
      .then(logoFrom)
      .then((l) => !cancelled && setLogo(l))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** The remembered settings, as they arrive (unless already changed here). */
  const init = (ws: WatermarkSettings | undefined) => {
    if (ws && !touched.current) setSettings(ws);
  };

  /** The document with the mark built from `ws` (replacing the one there); `null` when there is
   *  nothing to put (empty text, no picture). A watermark goes under the drawings, a copyright
   *  on top. */
  const withMark = (d: Doc, ws = settings, lg = logo): Doc | null => {
    const f = frame(d);
    if (!f) return null;
    const old = d.shapes.find(isMark);
    const next = buildMark(ws, f.area, f.full, lg, f.scale, old?.id ?? newId());
    if (!next) return null;
    const rest = d.shapes.filter((sh) => !isMark(sh));
    if (next.type === 'watermark') return { ...d, shapes: [next, ...rest] };
    // A copyright keeps its place among the shapes when only its settings change.
    if (old?.type === 'stamp') return { ...d, shapes: d.shapes.map((sh) => (sh.id === old.id ? next : sh)) };
    return { ...d, shapes: [...rest, next] };
  };

  /** Settings changed in the drop-down: remembered, and the mark is put / updated at once. */
  const change = (ws: WatermarkSettings, typing = false, lg = logo) => {
    touched.current = true;
    setSettings(ws);
    window.clearTimeout(save.current);
    save.current = window.setTimeout(() => api.settingsPatch({ watermark: ws }).catch(() => {}), typing ? 500 : 0);
    if (!frame(doc)) return;
    const next = withMark(doc, ws, lg) ?? (mark ? removeShape(doc, mark.id) : null);
    if (!next) return;
    // While typing the text the mark follows without an undo step per letter.
    if (typing) host.live(next);
    else host.apply(next);
  };

  const pickLogo = async () => {
    try {
      if (!(await api.watermarkPick())) return;
      const lg = await logoFrom(await loadWatermarkLogo());
      setLogo(lg);
      if (lg) change({ ...settings, kind: 'image' }, false, lg);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const clearLogo = async () => {
    await api.watermarkClear().catch(() => {});
    setLogo(null);
    if (mark?.src) host.apply(removeShape(doc, mark.id));
  };

  /** The button: puts the watermark / copyright, or removes it. */
  const toggle = () => {
    if (!frame(doc)) return;
    host.commitText();
    if (mark) {
      host.setSelectedId(null);
      host.apply(removeShape(doc, mark.id));
      return;
    }
    if (settings.kind === 'image' && !logo) {
      pickLogo();
      return;
    }
    const next = withMark(doc);
    if (next) host.apply(next);
    else onError('Впишите текст водяного знака (стрелка рядом с кнопкой)');
  };

  /** The mark follows a new frame (the overlay's selection moved), without an undo step. */
  const refit = (d: Doc) => {
    if (!d.shapes.some(isMark)) return;
    const next = withMark(d);
    if (next) host.live(next);
  };

  /** The button with its drop-down; `up` — it opens upwards, `tipsUp` — hints above the button. */
  const picker = (size: number, up?: boolean, tipsUp?: boolean) => (
    <WatermarkPicker
      value={settings}
      onChange={change}
      logo={logo}
      onPickLogo={pickLogo}
      onClearLogo={clearLogo}
      placed={!!mark}
      onToggle={toggle}
      onTextFocus={host.beginGesture}
      onTextBlur={host.endGesture}
      size={size}
      up={up}
      tipsUp={tipsUp}
    />
  );

  return { settings, init, mark, refit, picker };
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
  up,
  tipsUp,
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
  /** The drop-down opens upwards (the overlay's bar at the bottom of the screen). */
  up?: boolean;
  tipsUp?: boolean;
}) {
  const set = (patch: Partial<WatermarkSettings>) => onChange({ ...value, ...patch });
  const tile = value.layout === 'tile';
  const name = tile ? 'водяной знак' : 'копирайт';
  return (
    <Dropdown
      tip="Водяной знак или копирайт"
      face={null}
      up={up}
      panelClassName="rounded-[18px] p-3"
      toggleClassName="flex w-[15px] items-center justify-center self-stretch rounded-full text-muted transition-colors hover:bg-text/6 hover:text-text"
      chevronSize={12}
      before={
        <IconButton tip={placed ? `Убрать ${name}` : `Поставить ${name}`} tipPos={tipsUp ? 'top' : undefined} active={placed} size={size} onClick={onToggle}>
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
