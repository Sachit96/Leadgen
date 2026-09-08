'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import { cn } from './primitives';

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

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button className={cn(buttonClass(variant, size), className)} {...props}>
      {children}
    </button>
  );
}

/**
 * A submit button wired to the enclosing form's pending state.
 *
 * Every mutation in the app goes through a server action, and every one of them
 * disables its own trigger while in flight — double-submitting a send is not a
 * recoverable mistake.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={cn(buttonClass(variant, size), className)}
      {...props}
    >
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}
