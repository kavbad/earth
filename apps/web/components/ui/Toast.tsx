'use client'

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export const TOAST_DURATION_MS = 4_000

interface ToastItem {
  readonly id: number
  readonly message: string
}

export interface ToastContextValue {
  show(message: string): void
}

const ToastContext = createContext<ToastContextValue>({ show: () => undefined })

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])
  const counter = useRef(0)
  const show = useCallback((message: string) => {
    counter.current += 1
    const id = counter.current
    setToasts((current) => [...current, { id, message }])
  }, [])
  const value = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport
        toasts={toasts}
        onDone={(id) => setToasts((c) => c.filter((t) => t.id !== id))}
      />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  toasts,
  onDone,
}: {
  readonly toasts: readonly ToastItem[]
  readonly onDone: (id: number) => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--earth-space-16)+var(--earth-space-4)+env(safe-area-inset-bottom))] z-toast flex flex-col items-center gap-2 px-screen-margin rail:bottom-4"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDone={onDone} />
      ))}
    </div>
  )
}

function ToastCard({ toast, onDone }: { toast: ToastItem; onDone: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone(toast.id), TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDone])
  return (
    <div className="fade-in max-w-[680px] rounded-medium bg-text-primary px-4 py-3 text-secondary text-background">
      {toast.message}
    </div>
  )
}

/** `useToast().show("You're keeping the room open.")` — one short line, never a stack of alerts. */
export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}
