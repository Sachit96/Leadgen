import { cn } from './primitives';

/**
 * Button styling, kept out of the client module.
 *
 * Server components style `<Link>` and `<a>` elements with `buttonClass`, and a
 * function exported from a `'use client'` module cannot be called on the
 * server — so the pure part lives here and `buttons.tsx` imports it.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-500 disabled:bg-accent-600/50',
  secondary: 'border border-ink-600 bg-ink-800 text-ink-200 hover:border-ink-500 hover:bg-ink-750',
  ghost: 'text-ink-300 hover:bg-ink-800 hover:text-ink-100',
  danger: 'border border-danger-500/40 bg-danger-500/10 text-danger-400 hover:bg-danger-500/20',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md'): string {
  return cn(
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    VARIANTS[variant],
    SIZES[size],
  );
}
