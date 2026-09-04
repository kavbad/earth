'use client'

/**
 * SCREEN 01: when a Visitor tries to react, reply, follow or change radius, the bottom sheet
 * "Claim your place to join the conversation." with "Claim your place" / "Not now".
 * `useClaimGate().requireHuman()` is the one call every action makes before acting.
 */
import { type ClaimEntryPoint } from '@earth/analytics'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react'

import { markClaimTracked } from '../../lib/claim/tracking'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { ROUTES } from '../../lib/routes'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

export interface ClaimGate {
  /** Opens the sheet (Visitors and Guests) and returns `false`; Humans pass with `true`. */
  requireHuman(entry?: ClaimEntryPoint): boolean
  open(entry?: ClaimEntryPoint): void
  close(): void
  readonly isOpen: boolean
}

const ClaimGateContext = createContext<ClaimGate | null>(null)

export interface ClaimSheetViewProps {
  readonly open: boolean
  readonly onClaim: () => void
  readonly onDismiss: () => void
}

/** The sheet itself (rendered by the provider; exported for tests). */
export function ClaimSheetView({ open, onClaim, onDismiss }: ClaimSheetViewProps) {
  return (
    <Sheet open={open} onClose={onDismiss} title={copy.claimToJoinConversation}>
      <div className="flex flex-col gap-2">
        <Button variant="primary" fullWidth onClick={onClaim}>
          {copy.claimYourPlace}
        </Button>
        <Button variant="quiet" fullWidth onClick={onDismiss}>
          {copy.notNow}
        </Button>
      </div>
    </Sheet>
  )
}

export function ClaimSheetProvider({ children }: { readonly children: ReactNode }) {
  const session = useSession()
  const analytics = useAnalytics()
  const router = useRouter()
  const [entry, setEntry] = useState<ClaimEntryPoint | null>(null)

  const open = useCallback((from: ClaimEntryPoint = 'public_world') => setEntry(from), [])
  const close = useCallback(() => setEntry(null), [])
  const requireHuman = useCallback(
    (from: ClaimEntryPoint = 'public_world') => {
      if (session.roleKind === 'human') return true
      setEntry(from)
      return false
    },
    [session.roleKind],
  )
  const onClaim = useCallback(() => {
    analytics.track('claim_started', { entry: entry ?? 'public_world', hasGroupInvite: false })
    markClaimTracked()
    setEntry(null)
    router.push(ROUTES.claim)
  }, [analytics, entry, router])

  const value = useMemo<ClaimGate>(
    () => ({ requireHuman, open, close, isOpen: entry !== null }),
    [requireHuman, open, close, entry],
  )

  return (
    <ClaimGateContext.Provider value={value}>
      {children}
      <ClaimSheetView open={entry !== null} onClaim={onClaim} onDismiss={close} />
    </ClaimGateContext.Provider>
  )
}

export function useClaimGate(): ClaimGate {
  const value = useContext(ClaimGateContext)
  if (value === null) throw new Error('useClaimGate must be used within <EarthProviders>')
  return value
}
