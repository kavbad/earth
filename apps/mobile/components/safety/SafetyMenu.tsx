/**
 * The mandatory V1 controls (spec §81) as one sheet per target: every post — Report, Hide,
 * Block author; every Human profile — Block, Report; every room — Leave, Report; every Guest —
 * Remove, Report, block from this room. Report and Block open their own sheets; Hide and Remove
 * act directly. Visitors meet the claim sheet (spec §43) — except a Guest reporting their room.
 * Tracks `guest_removed` and `room_participant_removed` (spec §97).
 */
import type { SourceSurface } from '@earth/analytics'
import type { BlockChangeDto } from '@earth/api'
import type { ReportDto } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { safetyCopy } from '@/features/earth/copy'
import { lightTap } from '@/features/earth/haptics'
import { useEarthShell } from '@/features/earth/shell'
import {
  type SafetyAction,
  type SafetyActionKey,
  type SafetyTarget,
  blockableFor,
  claimEntryFor,
  reportTargetFor,
  safetyActionAllowed,
  safetyActionsFor,
} from '@/features/earth/state/safety'

import { BlockConfirm } from './BlockConfirm'
import { ReportSheet } from './ReportSheet'

export interface SafetyMenuViewProps {
  readonly open: boolean
  readonly title?: string
  readonly actions: readonly SafetyAction[]
  readonly busy?: boolean
  readonly error?: string | null
  readonly onAction: (key: SafetyActionKey) => void
  readonly onClose: () => void
}

/** Presentational menu (no providers), exported for reuse. */
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
      <View style={styles.stack}>
        <View>
          {actions.map((action, index) => (
            <ListRow
              key={action.key}
              flush
              title={action.label}
              destructive={action.destructive}
              disabled={busy}
              separator={index < actions.length - 1}
              onPress={() => onAction(action.key)}
            />
          ))}
        </View>
        {error !== null ? (
          <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
        <Button variant="quiet" fullWidth label={copy.notNow} onPress={onClose} />
      </View>
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
  const { earth, track, roleKind, openClaim, toast } = useEarthShell()
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
      if (safetyActionAllowed(roleKind, key, target.kind)) return true
      openClaim(claimEntryFor(source))
      return false
    },
    [roleKind, target.kind, openClaim, source],
  )

  const hide = useCallback(async () => {
    if (target.kind !== 'post') return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      await earth.posts.hide(target.postId)
      toast(safetyCopy.hidden)
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
    lightTap()
    setBusy(true)
    setError(null)
    try {
      const change = await earth.social.unblock(target.humanId)
      toast(safetyCopy.unblocked(target.displayName))
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
    lightTap()
    setBusy(true)
    setError(null)
    try {
      await earth.rooms.removeParticipant({
        roomId: target.roomId,
        participantId: target.participantId,
        blockFromRoom: removeAndBlock,
      })
      track('guest_removed', { roomId: target.roomId, guestSessionId: target.guestSessionId })
      track('room_participant_removed', { roomId: target.roomId, removedRole: 'participant' })
      toast(safetyCopy.removed(target.displayName))
      props.onRemoved?.(removeAndBlock)
      closeAll()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [earth, track, target, removeAndBlock, toast, props, closeAll])

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
  const blockable = blockableFor(target)

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
          <View style={styles.stack}>
            <Text style={[text.body, text.primary]}>
              {removeAndBlock ? safetyCopy.removeAndBlock : safetyCopy.removeBody}
            </Text>
            {error !== null ? (
              <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button
                variant="destructive"
                fullWidth
                loading={busy}
                label={copy.safety.remove}
                onPress={() => void remove()}
              />
              <Button variant="quiet" fullWidth label={copy.notNow} onPress={closeAll} />
            </View>
          </View>
        </Sheet>
      ) : null}
    </>
  )
}

export type SafetyMenuButtonProps = Omit<SafetyMenuProps, 'open' | 'onClose'> & {
  readonly label?: string
  readonly color?: string
}

/** The three-dots control that opens `SafetyMenu` for its target. */
export function SafetyMenuButton({
  label = copy.profileActions.more,
  color,
  ...menu
}: SafetyMenuButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IconButton
        name="more"
        label={label}
        {...(color === undefined ? {} : { color })}
        onPress={() => setOpen(true)}
      />
      <SafetyMenu {...menu} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

const styles = StyleSheet.create({
  stack: { gap: space[3] },
  actions: { gap: space[2] },
})
