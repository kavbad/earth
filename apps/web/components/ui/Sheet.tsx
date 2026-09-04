'use client'

import { type ReactNode, useEffect, useId, useRef } from 'react'

import { webCopy } from '../../lib/copy'
import { Icon } from './Icon'
import { cx } from './cx'

export interface SheetProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Rendered as the dialog's heading and accessible name. */
  readonly title?: string
  readonly children: ReactNode
  /** Show the close control in the corner (sheets with explicit actions usually don't need it). */
  readonly closeButton?: boolean
  readonly className?: string | undefined
}

/**
 * A native `<dialog>`: bottom sheet on phones, centered dialog from the rail breakpoint up.
 * `showModal()` gives the focus trap, Escape and the inert background for free; closing
 * returns focus to what opened it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  closeButton = false,
  className,
}: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const onCancel = (event: Event) => {
      event.preventDefault()
      onClose()
    }
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) onClose()
    }
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('click', onClick)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('click', onClick)
    }
  }, [onClose])

  return (
    <dialog
      ref={ref}
      aria-labelledby={title === undefined ? undefined : titleId}
      className={cx(
        'fixed inset-x-0 top-auto bottom-0 m-0 max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-medium border-0 bg-background p-0 text-text-primary shadow-none',
        'open:animate-[earth-sheet-up_var(--earth-duration-base)_var(--earth-easing-enter)]',
        'backdrop:bg-text-primary/40',
        'rail:inset-auto rail:top-1/2 rail:left-1/2 rail:w-[420px] rail:-translate-x-1/2 rail:-translate-y-1/2 rail:rounded-medium',
        className,
      )}
    >
      <div className="p-screen-margin pb-[calc(var(--earth-space-4)+env(safe-area-inset-bottom))]">
        {closeButton ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={webCopy.close}
            className="absolute top-2 right-2 flex size-touch-target items-center justify-center rounded-avatar text-text-secondary"
          >
            <Icon name="close" />
          </button>
        ) : null}
        {title !== undefined ? (
          <h2 id={titleId} className="mb-4 pr-8 text-section">
            {title}
          </h2>
        ) : null}
        {children}
      </div>
    </dialog>
  )
}
