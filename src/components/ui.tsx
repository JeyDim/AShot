// Small design-system primitives. Visual style comes from the tokens in styles.css.
import clsx from 'clsx';
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { hotkeyParts } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'accent';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  tip?: string;
  tipPos?: 'top' | 'bottom' | 'left' | 'right' | 'top-left';
  loading?: boolean;
}

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary font-medium hover:opacity-90 active:opacity-80',
  secondary: 'bg-surface-2 text-text font-medium hover:bg-surface-3',
  outline: 'text-text ring-1 ring-inset ring-border-strong hover:bg-text/5 active:bg-text/10',
  ghost: 'text-muted hover:text-text hover:bg-text/6 active:bg-text/10',
  danger: 'text-danger ring-1 ring-inset ring-border-strong hover:bg-danger/8',
  accent: 'bg-lime text-on-lime font-medium hover:brightness-105 active:brightness-95',
};

const sizes: Record<Size, string> = {
  sm: 'h-[30px] px-3.5 text-[13px] gap-1.5',
  md: 'h-[34px] px-3.5 text-[13px] gap-1.5',
  lg: 'h-[38px] px-4 text-[13px] gap-1.5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, tip, tipPos, loading, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      data-tip={tip}
      data-tip-pos={tipPos}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full whitespace-nowrap transition-[background,opacity,filter,color] duration-100 disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={15} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tip?: string;
  tipPos?: 'top' | 'bottom' | 'left' | 'right' | 'top-left';
  active?: boolean;
  size?: number;
  tone?: 'default' | 'danger' | 'solid';
}

/** Round icon button. `solid` sits on a picture (surface-colored disc). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { tip, tipPos, active, size = 36, tone = 'default', className, children, style, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      data-tip={tip}
      data-tip-pos={tipPos}
      aria-label={tip}
      style={{ width: size, height: size, ...style }}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'bg-primary text-on-primary'
          : tone === 'danger'
            ? 'text-muted hover:bg-danger/12 hover:text-danger'
            : tone === 'solid'
              ? 'bg-surface text-text shadow-(--shadow-soft) hover:bg-surface-2'
              : 'text-muted hover:bg-text/7 hover:text-text active:bg-text/10',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={clsx('animate-spin-slow', className)} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-40',
        checked ? 'bg-lime' : 'bg-toggle-off',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full transition-transform duration-150',
          checked ? 'translate-x-4 bg-on-lime' : 'bg-knob shadow-sm',
        )}
      />
    </button>
  );
}

export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const parts = hotkeyParts(keys);
  if (!parts.length) return null;
  return (
    <span className={clsx('inline-flex items-center gap-0.5', className)}>
      {parts.map((p, i) => (
        <span key={i} className="kbd">
          {p}
        </span>
      ))}
    </span>
  );
}

/** `accent` — the selected option in the lime accent (settings). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
  accent,
}: {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  className?: string;
  accent?: boolean;
}) {
  return (
    <div role="radiogroup" className={clsx('inline-flex shrink-0 rounded-full bg-surface-2 p-[3px] text-[12px]', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={clsx(
            'inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-1.5 whitespace-nowrap transition-colors',
            value === o.value ? (accent ? 'bg-lime font-medium text-on-lime' : 'bg-primary text-on-primary') : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const fieldClass =
  'h-9 rounded-(--radius-control) bg-surface-2 px-3 text-[13px] text-text outline-none ring-1 ring-inset ring-transparent transition-shadow placeholder:text-subtle focus:ring-2 focus:ring-lime disabled:opacity-50';

/** Text field; give it a width via `className`. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(fieldClass, className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={clsx('relative', className)}>
      <select className={clsx(fieldClass, 'w-full appearance-none pr-9')} {...rest}>
        {children}
      </select>
      <ChevronDown size={18} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted" />
    </div>
  );
}

/** Slider: `onChange` while dragging, `onCommit` once released (expensive changes). */
export function Range({
  value,
  min,
  max,
  onChange,
  onCommit,
  className,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  className?: string;
  label?: string;
}) {
  const commit = (e: { currentTarget: HTMLInputElement }) => onCommit?.(Number(e.currentTarget.value));
  return (
    <div className={clsx('flex shrink-0 items-center gap-3', className)}>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="range w-[180px]"
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
      <span className="w-7 text-right font-mono text-[13px] tabular-nums">{value}</span>
    </div>
  );
}

/** "DEV · PR #12": this is AShot Dev, the build of a pull request (installed next to AShot). */
export function DevBadge({ channel, className }: { channel: string; className?: string }) {
  return (
    <span
      className={clsx('inline-flex h-[20px] items-center rounded-full bg-lime px-2 font-sans text-[11px] font-semibold tracking-wide whitespace-nowrap text-on-lime', className)}
      data-tip="Dev-сборка из pull request: ставится рядом с AShot, свои настройки и история"
    >
      DEV · {channel}
    </span>
  );
}

/** App logo (icon 1b «Лаймовая плашка»): a dark A in four crop corners on a lime tile, the same
 *  in both themes. Same drawing as assets/logo.svg (the master for 24 px and up), on a 48-unit
 *  grid; `radius` in 1024ths of the size. */
export function Logo({ size = 28, className, radius }: { size?: number; className?: string; radius?: number }) {
  const r = ((radius ?? 213) * 48) / 1024;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={clsx('shrink-0', className)} aria-hidden>
      <rect width="48" height="48" rx={r} fill="#B5F000" />
      <path d="M6 6H13V8.5H8.5V13H6Z M42 6H35V8.5H39.5V13H42Z M6 42H13V39.5H8.5V35H6Z M42 42H35V39.5H39.5V35H42Z" fill="#111111" />
      <path d="M20.5 12H27.5L34 35H29L27.6 30.5H20.4L19 35H14Z M21.6 26H26.4L24.6 18H23.4Z" fill="#111111" fillRule="evenodd" />
    </svg>
  );
}
