import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { Spinner } from './Spinner'
import { cx } from './cx'

export const BUTTON_VARIANTS = ['primary', 'secondary', 'quiet', 'destructive'] as const
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number]

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant
  readonly fullWidth?: boolean
  /** Shows a spinner and disables the control; the label stays for width stability. */
  readonly loading?: boolean
  readonly children: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-text-primary text-background hover:opacity-90 active:opacity-80',
  secondary: 'bg-subtle-fill text-text-primary hover:opacity-90 active:opacity-80',
  quiet: 'bg-transparent text-text-primary hover:bg-subtle-fill',
  destructive: 'bg-transparent text-danger hover:bg-subtle-fill',
}

/**
 * The one button (spec §88: calm, physical). Primary is text-primary fill with white text; no
 * gradients, no pills, 44pt minimum hit target, 180 ms color transition.
 */
export function Button({
  variant = 'primary',
  fullWidth = false,
  loading = false,
  className,
  disabled,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex min-h-touch-target items-center justify-center gap-2 rounded-medium px-5 text-body font-medium transition-[background-color,opacity] duration-fast ease-standard disabled:cursor-default disabled:opacity-50',
        VARIANT_CLASS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner
          className={
            variant === 'primary'
              ? 'border-(color:--earth-color-background)/40 border-t-(color:--earth-color-background)'
              : undefined
          }
        />
      ) : null}
      <span>{children}</span>
    </button>
  )
}
