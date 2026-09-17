'use client'

/**
 * Drives the claim flow (spec §44–§49) with the `@earth/auth` state machine. Resumes from
 * `claim_get()` for a person with a credential, from the choices stored on the device for a
 * Visitor, and routes an existing Human straight to their destination (spec §47). Every claim
 * page reads `useClaimFlow()`; the guard here keeps the URL and the step in agreement.
 */
import { CLAIM_FLAG_KEY, type ClaimFlags, type ClaimFlowState } from '@earth/auth'
import { type ClaimIntent, type EarthErrorCode } from '@earth/domain'
import { usePathname, useRouter } from 'next/navigation'
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'

import { useToast } from '../../../components/ui/Toast'
import {
  type ClaimAction,
  type PendingClaim,
  claimRedirectFor,
  claimReducer,
  clearPendingClaim,
  duplicateState,
  pendingFromState,
  readPendingClaim,
  routeAfterAdvance,
  stateFromClaimDto,
  stateFromPending,
  writePendingClaim,
} from '../../../lib/claim/flow'
import { webCopy } from '../../../lib/copy'
import { errorCode } from '../../../lib/errors'
import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../../lib/providers/FlagsProvider'
import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { ROUTES, conversationRoute } from '../../../lib/routes'
import { sessionStore } from '../../../lib/storage'

export type StartClaimResult =
  { readonly ok: true } | { readonly ok: false; readonly code: EarthErrorCode }

export interface ClaimFlowContextValue {
  readonly state: ClaimFlowState
  readonly ready: boolean
  readonly flags: ClaimFlags
  /** Epoch ms when this claim attempt began (`human_claimed.durationMs`). */
  getStartedAt(): number
  dispatch(action: ClaimAction): void
  /** `claim_start` on the server; a `duplicate_human` answer moves the machine to `duplicate`. */
  startOnServer(
    intent: ClaimIntent,
    groupLabel: string | null,
    inviteToken: string | null,
  ): Promise<StartClaimResult>
  /** After a credential exists: existing Humans go to their destination, everyone else to `claim_start`. */
  resolveCredential(): Promise<StartClaimResult>
}

const ClaimFlowContext = createContext<ClaimFlowContextValue | null>(null)

export function ClaimFlowProvider({ children }: { readonly children: ReactNode }) {
  const earth = useEarth()
  const session = useSession()
  const flags = useFlags()
  const analytics = useAnalytics()
  const toast = useToast()
  const router = useRouter()
  const pathname = usePathname()

  const claimFlags = useMemo<ClaimFlags>(
    () => ({ [CLAIM_FLAG_KEY]: flags[CLAIM_FLAG_KEY] }),
    [flags],
  )
  const [state, rawDispatch] = useReducer(claimReducer, claimFlags, (initial) =>
    stateFromPending(null, initial),
  )
  const [ready, setReady] = useState(false)
  const startedAt = useRef(0)
  const resolved = useRef(false)
  // The latest state and page as the dispatcher sees them between renders (several events may
  // be dispatched in one handler), plus whether the flow is resolved.
  const latest = useRef(state)
  const readyRef = useRef(ready)
  const pathnameRef = useRef(pathname)
  useEffect(() => {
    latest.current = state
    readyRef.current = ready
    pathnameRef.current = pathname
  }, [state, ready, pathname])

  /**
   * Dispatches to the machine and, once the flow is resolved, opens the page of a step the event
   * moved forward to (`routeAfterAdvance`); the URL guard below never navigates forward itself,
   * so a person could otherwise choose "Start a group" and stay on the gate.
   */
  const dispatch = useCallback(
    (action: ClaimAction) => {
      const previous = latest.current
      const next = claimReducer(previous, action)
      latest.current = next
      rawDispatch(action)
      if (!readyRef.current) return
      const to = routeAfterAdvance(previous, next)
      if (to !== null && to !== pathnameRef.current) router.push(to)
    },
    [router],
  )

  const startOnServer = useCallback(
    async (
      intent: ClaimIntent,
      groupLabel: string | null,
      inviteToken: string | null,
    ): Promise<StartClaimResult> => {
      try {
        const dto = await earth.claim.start({ intent, groupLabel, inviteToken })
        dispatch({ type: 'reset', state: stateFromClaimDto(dto, claimFlags) })
        return { ok: true }
      } catch (cause) {
        const code = errorCode(cause)
        if (code === 'duplicate_human') {
          dispatch({ type: 'reset', state: duplicateState(intent, claimFlags) })
          return { ok: true }
        }
        return { ok: false, code }
      }
    },
    [earth, claimFlags, dispatch],
  )

  /** Spec §47: an existing Human never re-claims; the stored intent is honoured and the flow ends. */
  const continueAsHuman = useCallback(
    async (pending: PendingClaim | null): Promise<void> => {
      clearPendingClaim(sessionStore())
      try {
        if (pending?.intent === 'join_group' && pending.inviteToken !== null) {
          const joined = await earth.groups.invites.join(pending.inviteToken)
          analytics.track('group_invite_opened', { groupId: joined.groupId, viewerState: 'human' })
          if (!joined.alreadyMember) {
            analytics.track('group_joined', {
              groupId: joined.groupId,
              viaInvite: true,
              duringClaim: false,
              memberGroupCount: joined.isSecondGroup ? 2 : 1,
            })
          }
          router.replace(conversationRoute(joined.conversationId))
          return
        }
        if (pending?.intent === 'start_group') {
          const group = await earth.groups.create({ name: pending.groupLabel })
          analytics.track('group_created', {
            groupId: group.id,
            kind: group.kind,
            duringClaim: false,
          })
          router.replace(conversationRoute(group.conversationId))
          return
        }
      } catch (cause) {
        const code = errorCode(cause)
        toast.show(code.startsWith('invite_') ? webCopy.inviteInvalid : webCopy.somethingWrong)
      }
      router.replace(ROUTES.home)
    },
    [earth, analytics, router, toast],
  )

  const resolveCredential = useCallback(async (): Promise<StartClaimResult> => {
    const snapshot = await session.refresh()
    const pending = readPendingClaim(sessionStore())
    if (snapshot.roleKind === 'human') {
      await continueAsHuman(pending)
      return { ok: true }
    }
    const intent = state.intent ?? pending?.intent ?? null
    if (intent === null) {
      // Nothing chosen yet (a credential from a link): the gate comes first (spec §44).
      dispatch({ type: 'reset', state: stateFromPending(null, claimFlags) })
      return { ok: true }
    }
    return startOnServer(
      intent,
      state.groupLabel ?? pending?.groupLabel ?? null,
      state.inviteToken ?? pending?.inviteToken ?? null,
    )
  }, [
    session,
    state.intent,
    state.groupLabel,
    state.inviteToken,
    claimFlags,
    continueAsHuman,
    startOnServer,
    dispatch,
  ])

  // Resolve once per mount, as soon as the session is known.
  useEffect(() => {
    if (session.status !== 'ready' || resolved.current) return
    resolved.current = true
    const pending = readPendingClaim(sessionStore())
    startedAt.current = pending?.startedAt ?? Date.now()
    const run = async () => {
      if (session.roleKind === 'human') {
        await continueAsHuman(pending)
        return
      }
      if (session.roleKind === 'claiming') {
        try {
          const dto = await earth.claim.get()
          if (dto.status === 'claimed') {
            router.replace(ROUTES.home)
            return
          }
          dispatch({ type: 'reset', state: stateFromClaimDto(dto, claimFlags) })
        } catch (cause) {
          if (errorCode(cause) === 'claim_not_pending' && pending?.intent) {
            const result = await startOnServer(
              pending.intent,
              pending.groupLabel,
              pending.inviteToken,
            )
            if (!result.ok) dispatch({ type: 'reset', state: stateFromPending(null, claimFlags) })
          } else {
            dispatch({ type: 'reset', state: stateFromPending(pending, claimFlags) })
          }
        }
        setReady(true)
        return
      }
      dispatch({ type: 'reset', state: stateFromPending(pending, claimFlags) })
      setReady(true)
    }
    void run()
  }, [
    session.status,
    session.roleKind,
    earth,
    claimFlags,
    continueAsHuman,
    startOnServer,
    router,
    dispatch,
  ])

  // Remember a Visitor's choices so a reload (or the OTP link) resumes where they were.
  useEffect(() => {
    if (!ready || state.intent === null || state.authenticated) return
    writePendingClaim(sessionStore(), pendingFromState(state, startedAt.current))
  }, [ready, state])

  // The URL follows the step: nobody skips ahead, nobody goes back past the credential.
  useEffect(() => {
    if (!ready) return
    const to = claimRedirectFor(state, pathname)
    if (to !== null && to !== pathname) router.replace(to)
  }, [ready, state, pathname, router])

  const value = useMemo<ClaimFlowContextValue>(
    () => ({
      state,
      ready,
      flags: claimFlags,
      getStartedAt: () => startedAt.current,
      dispatch,
      startOnServer,
      resolveCredential,
    }),
    [state, ready, claimFlags, dispatch, startOnServer, resolveCredential],
  )

  return <ClaimFlowContext.Provider value={value}>{children}</ClaimFlowContext.Provider>
}

export function useClaimFlow(): ClaimFlowContextValue {
  const value = useContext(ClaimFlowContext)
  if (value === null) throw new Error('useClaimFlow must be used within <ClaimFlowProvider>')
  return value
}
