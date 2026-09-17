'use client'

import type { MediaState } from '@earth/domain'
import { copy } from '@earth/ui'
import { useState } from 'react'

import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'

export type JoinMediaState = Exclude<MediaState, 'watching'>

export interface ViewerJoinProps {
  /** Opens the audio / camera choice; the choice is reported through `onJoin`. */
  readonly onJoin: (mediaState: JoinMediaState) => void
  /** Visitors: the tap opens the claim sheet instead (spec §43). */
  readonly onTap?: (() => boolean) | undefined
  readonly busy?: boolean
  readonly error?: string | null
}

/** SCREEN 14 viewer state: "Join them" → "Join audio" / "Join on camera". */
export function ViewerJoin({ onJoin, onTap, busy = false, error = null }: ViewerJoinProps) {
  const [choosing, setChoosing] = useState(false)
  const open = () => {
    if (onTap !== undefined && !onTap()) return
    setChoosing(true)
  }
  const choose = (mediaState: JoinMediaState) => {
    setChoosing(false)
    onJoin(mediaState)
  }
  return (
    <div className="flex flex-col items-center gap-2 px-screen-margin py-3">
      <Button variant="primary" fullWidth loading={busy} onClick={open}>
        {copy.joinThem}
      </Button>
      {error !== null ? (
        <p role="alert" className="text-secondary text-danger">
          {error}
        </p>
      ) : null}
      <Sheet open={choosing} onClose={() => setChoosing(false)} title={copy.joinThem}>
        <div className="flex flex-col gap-2">
          <Button variant="primary" fullWidth onClick={() => choose('audio')}>
            {copy.joinAudio}
          </Button>
          <Button variant="secondary" fullWidth onClick={() => choose('camera')}>
            {copy.joinOnCamera}
          </Button>
        </div>
      </Sheet>
    </div>
  )
}
