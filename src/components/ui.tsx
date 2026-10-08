// Small design-system primitives. Visual style comes from the tokens in styles.css.
import clsx from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { forwardRef } from 'react';
import { hotkeyParts } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
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
  primary: 'brand-gradient text-white shadow-[0_6px_20px_-6px_rgb(107_107_255/0.7)] hover:brightness-110 active:brightness-95',
  secondary: 'bg-surface-3 text-text hover:bg-border-strong/70 active:bg-surface-2 ring-1 ring-inset ring-white/5',
  ghost: 'text-muted hover:text-text hover:bg-white/6 active:bg-white/10',
  danger: 'bg-danger/12 text-danger hover:bg-danger/20',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[8px]',
  md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-(--radius-control)',
  lg: 'h-11 px-5 text-[14.5px] gap-2 rounded-[12px]',
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
        'inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-[background,filter,color] duration-100 disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tip?: string;
  tipPos?: 'top' | 'bottom' | 'left' | 'right' | 'top-left';
  active?: boolean;
  size?: number;
  tone?: 'default' | 'danger' | 'accent';
}

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
        'inline-flex shrink-0 items-center justify-center rounded-[10px] transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40',
        active
          ? 'bg-accent-soft text-[#b9b9ff] ring-1 ring-inset ring-accent/40'
          : tone === 'danger'
            ? 'text-muted hover:bg-danger/15 hover:text-danger'
            : tone === 'accent'
              ? 'text-[#b9b9ff] hover:bg-accent-soft'
              : 'text-muted hover:bg-white/7 hover:text-text active:bg-white/10',
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
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-40',
        checked ? 'brand-gradient' : 'bg-surface-3 ring-1 ring-inset ring-border-strong',
      )}
    >
      <span
        className={clsx(
          'absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150',
          checked ? 'translate-x-[19px]' : 'translate-x-[3px] bg-[#c9cedb]',
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

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={clsx('inline-flex rounded-[10px] bg-surface-2 p-0.5 ring-1 ring-inset ring-border', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
          className={clsx(
            'inline-flex h-7 min-w-8 items-center justify-center gap-1.5 rounded-[8px] px-2.5 text-[13px] transition-colors',
            value === o.value ? 'bg-surface-3 text-text shadow-sm ring-1 ring-inset ring-white/8' : 'text-muted hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={clsx(
        'h-9 w-full rounded-(--radius-control) bg-surface-2 px-3 text-[13.5px] text-text ring-1 ring-inset ring-border outline-none transition-shadow placeholder:text-subtle focus:ring-2 focus:ring-accent/70',
        className,
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={clsx(
        'h-9 w-full appearance-none rounded-(--radius-control) bg-surface-2 bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 fill=%27none%27 stroke=%27%23a1a9b8%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m4 6 4 4 4-4%27/%3E%3C/svg%3E")] bg-[length:16px] bg-[right_10px_center] bg-no-repeat pr-9 pl-3 text-[13.5px] text-text ring-1 ring-inset ring-border outline-none focus:ring-2 focus:ring-accent/70',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" className={className} aria-hidden>
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5B6CFF" />
          <stop offset="1" stopColor="#A24BFF" />
        </linearGradient>
      </defs>
      <rect x="48" y="48" width="928" height="928" rx="220" fill="url(#logo-bg)" />
      <g fill="none" stroke="#fff" strokeWidth="92" strokeLinecap="round" strokeLinejoin="round">
        <path d="M262 420 V330 a68 68 0 0 1 68 -68 H420" />
        <path d="M604 262 H694 a68 68 0 0 1 68 68 V420" />
        <path d="M762 604 V694 a68 68 0 0 1 -68 68 H604" />
        <path d="M420 762 H330 a68 68 0 0 1 -68 -68 V604" />
      </g>
      <circle cx="512" cy="512" r="104" fill="#fff" />
    </svg>
  );
}
