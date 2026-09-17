'use client'

/**
 * The mandatory V1 controls (spec §81) as one sheet per target: every post — Report, Hide,
 * Block author; every Human profile — Block, Report; every room — Leave, Report; every Guest —
 * Remove, Report, block from this room. Report and Block open their own sheets; Hide and Remove
 * act directly. Visitors meet the claim sheet (spec §43) — except a Guest reporting their room.
 */
import type { ClaimEntryPoint, SourceSurface } from '@earth/analytics'
import type { BlockChangeDto } from '@earth/api'
import type {
  GuestSessionId,
  HumanId,
  PostId,
  ReportDto,
  ReportTargetType,
  RoomId,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { useCallback, useState } from 'react'

import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { useClaimGate } from '../shell/ClaimSheet'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { useToast } from '../ui/Toast'
import { cx } from '../ui/cx'
import { BlockConfirm } from './BlockConfirm'
import { ReportSheet } from './ReportSheet'
import { safetyCopy } from './copy'

export type SafetyTarget =
  | {
      readonly kind: 'post'
      readonly postId: PostId
      readonly authorHumanId: HumanId
      readonly authorDisplayName: string
      /** Own posts get Report only from elsewhere (delete lives with the post); nothing here. */
      readonly isOwn?: boolean
    }
  | {
      readonly kind: 'profile'
      readonly humanId: HumanId
      readonly displayName: string
      readonly isBlocked: boolean
    }
  | {
      readonly kind: 'room'
      readonly roomId: RoomId
      readonly title: string
      /** `false` while the person is not in the room (a card, a preview). */
      readonly canLeave: boolean
    }
  | {
      readonly kind: 'guest'
      readonly roomId: RoomId
      readonly participantId: string
      readonly guestSessionId: GuestSessionId
      readonly displayName: string
      /** Only moderators remove; everyone may report. */
      readonly canModerate: boolean
    }

export const SAFETY_ACTION_KEYS = [
  'report',
  'hide',
  'block',
  'unblock',
  'leave',
  'remove',
  'removeAndBlock',
] as const
export type SafetyActionKey = (typeof SAFETY_ACTION_KEYS)[number]

export interface SafetyAction {
  readonly key: SafetyActionKey
  readonly label: string
  readonly destructive: boolean
}

/** Spec §81, in the spec's order per target. Pure so the menu is tested without providers. */
export function safetyActionsFor(target: SafetyTarget): readonly SafetyAction[] {
  switch (target.kind) {
    case 'post':
      if (target.isOwn === true) return []
      return [
        { key: 'report', label: copy.safety.report, destructive: false },
        { key: 'hide', label: copy.safety.hide, destructive: false },
        { key: 'block', label: copy.safety.blockAuthor, destructive: true },
      ]
    case 'profile':
      return [
        target.isBlocked
          ? { key: 'unblock', label: copy.safety.unblock, destructive: false }
          : { key: 'block', label: copy.safety.block, destructive: true },
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    case 'room':
      return [
        ...(target.canLeave
          ? [{ key: 'leave', label: copy.safety.leave, destructive: false } as const]
          : []),
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    case 'guest':
      return [
        ...(target.canModerate
          ? ([
              { key: 'remove', label: copy.safety.remove, destructive: true },
              { key: 'removeAndBlock', label: safetyCopy.removeAndBlock, destructive: true },
            ] as const)
          : []),
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    default: {
      const exhaustive: never = target
      throw new Error(`Unknown safety target: ${String(exhaustive)}`)
    }
  }
}

/** What the target's Report sends (`report_create.target_type`). */
export function reportTargetFor(target: SafetyTarget): {
  readonly type: ReportTargetType
  readonly id: string
} {
  switch (target.kind) {
    case 'post':
      return { type: 'post', id: target.postId }
    case 'profile':
      return { type: 'human', id: target.humanId }
    case 'room':
      return { type: 'room', id: target.roomId }
    case 'guest':
      return { type: 'guest', id: target.guestSessionId }
    default: {
      const exhaustive: never = target
      throw new Error(`Unknown safety target: ${String(exhaustive)}`)
    }
  }
}

export function claimEntryFor(source: SourceSurface): ClaimEntryPoint {
  switch (source) {
    case 'post':
      return 'post'
    case 'profile':
      return 'profile'
    default:
      return 'public_world'
  }
}

export interface SafetyMenuViewProps {
  readonly open: boolean
  readonly title?: string
  readonly actions: readonly SafetyAction[]
  readonly busy?: boolean
  readonly error?: string | null
  readonly onAction: (key: SafetyActionKey) => void
  readonly onClose: () => void
}

/** Presentational menu (no providers), exported for tests and reuse. */
export function SafetyMenuView({
  open,
  title = safetyCopy.menuTitle,
  actions,
  busy = false,
  error = null,
  onAction,
  onClose,
}: SafetyMenuViewProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton>
      <div className="flex flex-col gap-3">
        <List>
          {actions.map((action) => (
            <ListRow
              key={action.key}
              as="button"
              title={
                <span className={cx(action.destructive && 'text-danger')}>{action.label}</span>
              }
              disabled={busy}
              onClick={() => onAction(action.key)}
              className="px-0"
            />
          ))}
        </List>
        {error !== null ? (
          <p role="alert" className="text-secondary text-danger">
            {error}
          </p>
        ) : null}
        <Button variant="quiet" fullWidth onClick={onClose}>
          {copy.notNow}
        </Button>
      </div>
    </Sheet>
  )
}

type SubSheet = 'none' | 'report' | 'block' | 'remove'

export interface SafetyMenuProps {
  readonly open: boolean
  readonly target: SafetyTarget
  readonly source: SourceSurface
  readonly onClose: () => void
  /** Called after `post_hide` succeeded; the caller tracks `post_hidden` with its feed position. */
  readonly onHide?: (() => void) | undefined
  /** Rooms own their connection lifecycle: Leave is handed back to the room screen. */
  readonly onLeave?: (() => void) | undefined
  readonly onRemoved?: ((blockedFromRoom: boolean) => void) | undefined
  readonly onBlocked?: ((change: BlockChangeDto) => void) | undefined
  readonly onUnblocked?: ((change: BlockChangeDto) => void) | undefined
  readonly onReported?: ((report: ReportDto) => void) | undefined
}

export function SafetyMenu(props: SafetyMenuProps) {
  const { open, target, source, onClose } = props
  const earth = useEarth()
  const analytics = useAnalytics()
  const session = useSession()
  const gate = useClaimGate()
  const toast = useToast()
  const [sub, setSub] = useState<SubSheet>('none')
  const [removeAndBlock, setRemoveAndBlock] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const closeAll = useCallback(() => {
    setSub('none')
    setError(null)
    onClose()
  }, [onClose])

  const allowed = useCallback(
    (key: SafetyActionKey): boolean => {
      if (session.roleKind === 'human') return true
      // A Guest may report the room they are in (DB_API §7); everyone else claims first.
      if (
        session.roleKind === 'guest' &&
        key === 'report' &&
        (target.kind === 'room' || target.kind === 'guest')
      )
        return true
      gate.open(claimEntryFor(source))
      return false
    },
    [session.roleKind, target.kind, gate, source],
  )

  const hide = useCallback(async () => {
    if (target.kind !== 'post') return
    setBusy(true)
    setError(null)
    try {
      await earth.posts.hide(target.postId)
      toast.show(safetyCopy.hidden)
      props.onHide?.()
      closeAll()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [earth, target, toast, props, closeAll])

  const unblock = useCallback(async () => {
    if (target.kind !== 'profile') return
    setBusy(true)
    setError(null)
    try {
      const change = await earth.social.unblock(target.humanId)
      toast.show(safetyCopy.unblocked(target.displayName))
      props.onUnblocked?.(change)
      closeAll()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [earth, target, toast, props, closeAll])

  const remove = useCallback(async () => {
    if (target.kind !== 'guest') return
    setBusy(true)
    setError(null)
    try {
      await earth.rooms.removeParticipant({
        roomId: target.roomId,
        participantId: target.participantId,
        blockFromRoom: removeAndBlock,
      })
      analytics.track('guest_removed', {
        roomId: target.roomId,
        guestSessionId: target.guestSessionId,
      })
      analytics.track('room_participant_removed', {
        roomId: target.roomId,
        removedRole: 'participant',
      })
      toast.show(safetyCopy.removed(target.displayName))
      props.onRemoved?.(removeAndBlock)
      closeAll()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [earth, analytics, target, removeAndBlock, toast, props, closeAll])

  const onAction = (key: SafetyActionKey) => {
    if (!allowed(key)) return
    switch (key) {
      case 'report':
        setSub('report')
        return
      case 'block':
        setSub('block')
        return
      case 'hide':
        void hide()
        return
      case 'unblock':
        void unblock()
        return
      case 'leave':
        props.onLeave?.()
        closeAll()
        return
      case 'remove':
        setRemoveAndBlock(false)
        setSub('remove')
        return
      case 'removeAndBlock':
        setRemoveAndBlock(true)
        setSub('remove')
        return
      default: {
        const exhaustive: never = key
        throw new Error(`Unknown safety action: ${String(exhaustive)}`)
      }
    }
  }

  const report = reportTargetFor(target)
  const blockable =
    target.kind === 'post'
      ? { humanId: target.authorHumanId, displayName: target.authorDisplayName }
      : target.kind === 'profile'
        ? { humanId: target.humanId, displayName: target.displayName }
        : null

  return (
    <>
      <SafetyMenuView
        open={open && sub === 'none'}
        actions={safetyActionsFor(target)}
        busy={busy}
        error={error}
        onAction={onAction}
        onClose={closeAll}
      />
      <ReportSheet
        open={open && sub === 'report'}
        targetType={report.type}
        targetId={report.id}
        onClose={closeAll}
        onReported={props.onReported}
      />
      {blockable !== null ? (
        <BlockConfirm
          open={open && sub === 'block'}
          humanId={blockable.humanId}
          displayName={blockable.displayName}
          source={source}
          onClose={closeAll}
          onBlocked={props.onBlocked}
        />
      ) : null}
      {target.kind === 'guest' ? (
        <Sheet
          open={open && sub === 'remove'}
          onClose={closeAll}
          title={safetyCopy.removeTitle(target.displayName)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-body">
              {removeAndBlock ? safetyCopy.removeAndBlock : safetyCopy.removeBody}
            </p>
            {error !== null ? (
              <p role="alert" className="text-secondary text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Button variant="primary" fullWidth loading={busy} onClick={() => void remove()}>
                {copy.safety.remove}
              </Button>
              <Button variant="quiet" fullWidth onClick={closeAll}>
                {copy.notNow}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  )
}

export type SafetyMenuButtonProps = Omit<SafetyMenuProps, 'open' | 'onClose'> & {
  readonly className?: string | undefined
  readonly label?: string
}

/** The three-dots control that opens `SafetyMenu` for its target. */
export function SafetyMenuButton({
  className,
  label = copy.profileActions.more,
  ...menu
}: SafetyMenuButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={cx(
          'flex size-touch-target items-center justify-center rounded-avatar text-text-secondary transition-colors duration-fast ease-standard hover:bg-subtle-fill',
          className,
        )}
      >
        <Icon name="more" />
      </button>
      <SafetyMenu {...menu} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
