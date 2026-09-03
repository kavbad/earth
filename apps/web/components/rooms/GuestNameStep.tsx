'use client'

import { GUEST_DISPLAY_NAME_MAX } from '@earth/domain'
import { copy } from '@earth/ui'
import type { FormEvent } from 'react'

import { Button } from '../ui/Button'
import { TextField } from '../ui/TextField'
import { CameraPreview } from './CameraPreview'
import { roomCopy } from './copy'
import type { GuestFlowError } from './state/guestFlow'

export interface GuestNameStepProps {
  readonly name: string
  readonly wantsCamera: boolean
  readonly joining: boolean
  readonly error: GuestFlowError | null
  readonly onName: (name: string) => void
  readonly onCamera: (on: boolean) => void
  readonly onSubmit: () => void
}

/** SCREEN 17 second step: "Your name", an optional camera preview, "Join". Nothing else. */
export function GuestNameStep(props: GuestNameStepProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    props.onSubmit()
  }
  const errorLine =
    props.error === 'name_missing'
      ? roomCopy.guestNameMissing
      : props.error === 'join_failed'
        ? roomCopy.guestJoinFailed
        : null
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField
        label={copy.yourName}
        hint={roomCopy.guestNameHint}
        error={errorLine}
        value={props.name}
        onChange={(event) => props.onName(event.target.value)}
        maxLength={GUEST_DISPLAY_NAME_MAX}
        autoComplete="name"
        autoFocus
        enterKeyHint="go"
      />
      <CameraPreview on={props.wantsCamera} onUnavailable={() => props.onCamera(false)} />
      <div className="flex flex-col gap-2">
        <Button type="submit" variant="primary" fullWidth loading={props.joining}>
          {copy.join}
        </Button>
        <Button
          variant="quiet"
          fullWidth
          aria-pressed={props.wantsCamera}
          onClick={() => props.onCamera(!props.wantsCamera)}
        >
          {props.wantsCamera ? roomCopy.cameraPreviewOff : roomCopy.cameraPreview}
        </Button>
      </div>
    </form>
  )
}
