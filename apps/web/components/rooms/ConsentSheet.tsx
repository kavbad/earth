'use client'

import type { MediaState, RoomVisibility } from '@earth/domain'
import { CONSENT_CHOICES, copy } from '@earth/ui'

import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { roomCopy } from './copy'

export interface ConsentSheetProps {
  readonly open: boolean
  /** `Xavier` — the room's initiator; `null` falls back to "Someone". */
  readonly initiatorName: string | null
  /** The (pending) visibility the person is asked to accept. */
  readonly level: RoomVisibility
  readonly busy?: boolean
  readonly onChoose: (mediaState: MediaState) => void
  readonly onClose: () => void
}

/**
 * SCREEN 16 — exact copy from `@earth/ui`: "Xavier's room is visible to World. If you join on
 * camera, people on Earth may see that you're here." Buttons: Join on camera / Join audio only /
 * Just watch. No hidden audience inheritance.
 */
export function ConsentSheet({ open, initiatorName, level, busy = false, onChoose, onClose }: ConsentSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={copy.consent(initiatorName ?? roomCopy.someone, level)}>
      <div className="flex flex-col gap-2">
        {CONSENT_CHOICES.map((choice, index) => (
          <Button
            key={choice.mediaState}
            variant={index === 0 ? 'primary' : index === 1 ? 'secondary' : 'quiet'}
            fullWidth
            loading={busy && index === 0}
            disabled={busy}
            onClick={() => onChoose(choice.mediaState)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </Sheet>
  )
}
