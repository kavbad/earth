'use client'

import { type IconName, copy } from '@earth/ui'

import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'

export const ROOM_CONTROL_MODES = ['visitor', 'viewer', 'participant', 'guest'] as const
export type RoomControlMode = (typeof ROOM_CONTROL_MODES)[number]

export interface RoomControlsProps {
  readonly mode: RoomControlMode
  readonly micOn: boolean
  readonly cameraOn: boolean
  /** Initiator / moderator only (spec §58): the Open up control. */
  readonly canOpenUp: boolean
  readonly busy?: boolean | undefined
  readonly onMic: () => void
  readonly onCamera: () => void
  readonly onFlip: () => void
  readonly onParticipants: () => void
  readonly onOpenUp: () => void
  readonly onMore: () => void
  readonly onLeave: () => void
}

function ControlButton({
  icon,
  label,
  pressed,
  onClick,
  disabled,
  className,
}: {
  icon: IconName
  label: string
  pressed?: boolean
  onClick: () => void
  disabled?: boolean | undefined
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex size-touch-target items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill disabled:opacity-50',
        pressed === false && 'text-text-secondary',
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  )
}

/**
 * Bottom controls (SCREEN 14): microphone, camera, flip camera, participants, Open up, more,
 * leave. Leave is one quiet control among the others — never a giant red centre button.
 */
export function RoomControls(props: RoomControlsProps) {
  const publishing = props.mode === 'participant' || props.mode === 'guest'
  return (
    <div className="flex items-center justify-between gap-1 px-screen-margin pt-2 pb-[calc(var(--earth-space-2)+env(safe-area-inset-bottom))] hairline-t">
      {publishing ? (
        <>
          <ControlButton
            icon={props.micOn ? 'mic' : 'micOff'}
            label={copy.roomControls.microphone}
            pressed={props.micOn}
            onClick={props.onMic}
            disabled={props.busy}
          />
          <ControlButton
            icon={props.cameraOn ? 'camera' : 'cameraOff'}
            label={copy.roomControls.camera}
            pressed={props.cameraOn}
            onClick={props.onCamera}
            disabled={props.busy}
          />
          {props.cameraOn ? (
            <ControlButton icon="flip" label={copy.roomControls.flipCamera} onClick={props.onFlip} />
          ) : null}
        </>
      ) : null}
      {props.mode !== 'visitor' ? (
        <ControlButton
          icon="participants"
          label={copy.roomControls.participants}
          onClick={props.onParticipants}
        />
      ) : null}
      {props.canOpenUp ? (
        <button
          type="button"
          onClick={props.onOpenUp}
          className="min-h-touch-target rounded-medium px-3 text-body font-medium text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill"
        >
          {copy.openUp}
        </button>
      ) : null}
      {props.mode !== 'visitor' ? (
        <ControlButton icon="more" label={copy.roomControls.more} onClick={props.onMore} />
      ) : null}
      <ControlButton icon="leave" label={copy.roomControls.leave} onClick={props.onLeave} />
    </div>
  )
}
