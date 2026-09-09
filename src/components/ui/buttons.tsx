'use client';

import { useFormStatus } from 'react-dom';
import type { ReactNode } from 'react';
import { cn } from './primitives';
import { buttonClass, type ButtonSize, type ButtonVariant } from './button-styles';

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
