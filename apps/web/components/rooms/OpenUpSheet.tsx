'use client'

/**
 * SCREEN 15 — Open up. Shows the current visibility, the options the context and flags allow,
 * "Who can join" underneath with explanatory microcopy, and the pending state while an outward
 * change waits for everyone on camera (ARCHITECTURE §10). Options come from `state/openUp.ts`.
 */
import type { FeatureFlags } from '@earth/config'
import { type RoomDto, type RoomJoinPolicy, type RoomVisibility, requiresConsent } from '@earth/domain'
import { copy } from '@earth/ui'
import { useId, useState } from 'react'

import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { cx } from '../ui/cx'
import { roomCopy } from './copy'
import { isPublishing } from './state/consent'
import { defaultJoinPolicyFor, openUpJoinPolicyOptions, openUpVisibilityOptions } from './state/openUp'

export interface OpenUpSheetProps {
  readonly open: boolean
  readonly room: Pick<RoomDto, 'contextType' | 'visibility' | 'joinPolicy' | 'pendingVisibility' | 'participants'>
  readonly flags: FeatureFlags
  readonly busy?: boolean
  readonly error?: string | null
  readonly onApply: (visibility: RoomVisibility, joinPolicy: RoomJoinPolicy) => void
  readonly onClose: () => void
}

/** Publishing Humans whose consent does not yet cover the pending visibility. */
export function pendingConsentCount(room: OpenUpSheetProps['room']): number {
  const pending = room.pendingVisibility
  if (pending === null) return 0
  return room.participants.filter(
    (p) =>
      isPublishing(p) &&
      !p.isGuest &&
      requiresConsent({ roomVisibility: pending, myConsentLevel: p.audienceConsentLevel, mediaState: p.mediaState }),
  ).length
}

interface OptionRowProps<K extends string> {
  readonly name: string
  readonly value: K
  readonly label: string
  readonly description: string
  readonly checked: boolean
  readonly current?: boolean
  readonly onSelect: (value: K) => void
}

function OptionRow<K extends string>({ name, value, label, description, checked, current = false, onSelect }: OptionRowProps<K>) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className={cx(
        'flex min-h-touch-target cursor-pointer items-start gap-3 rounded-medium px-2 py-2 transition-colors duration-fast ease-standard hover:bg-subtle-fill',
        checked && 'bg-subtle-fill',
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-1.5 size-4 shrink-0 accent-(color:--earth-color-text-primary)"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-text-primary">
          {label}
          {current ? <span className="ml-2 text-meta text-text-secondary">{roomCopy.currentVisibility}</span> : null}
        </span>
        <span className="text-secondary text-text-secondary">{description}</span>
      </span>
    </label>
  )
}

function OpenUpForm({ room, flags, busy = false, error = null, onApply, onClose }: Omit<OpenUpSheetProps, 'open'>) {
  const [visibility, setVisibility] = useState<RoomVisibility>(room.pendingVisibility ?? room.visibility)
  const [joinPolicy, setJoinPolicy] = useState<RoomJoinPolicy>(room.joinPolicy)
  const visibilityOptions = openUpVisibilityOptions(room.contextType, flags, room.visibility)
  const policyOptions = openUpJoinPolicyOptions(visibility, room.contextType)
  const effectivePolicy = defaultJoinPolicyFor(visibility, room.contextType, joinPolicy)
  const pendingCount = pendingConsentCount(room)
  const unchanged = visibility === room.visibility && effectivePolicy === room.joinPolicy
  const visibilityGroup = useId()
  const policyGroup = useId()

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onApply(visibility, effectivePolicy)
      }}
      className="flex flex-col gap-5"
    >
      {room.pendingVisibility !== null ? (
        <p role="status" className="text-secondary text-text-secondary">
          {roomCopy.pendingVisibility(copy.visibility[room.pendingVisibility])}{' '}
          {pendingCount > 0 ? roomCopy.pendingCount(pendingCount) : null}
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-1">
        <legend id={visibilityGroup} className="mb-1 text-meta text-text-secondary">
          {copy.openUp}
        </legend>
        {visibilityOptions.map((option) => (
          <OptionRow
            key={option.visibility}
            name={visibilityGroup}
            value={option.visibility}
            label={option.label}
            description={option.description}
            checked={option.visibility === visibility}
            current={option.visibility === room.visibility}
            onSelect={(next) => {
              setVisibility(next)
              setJoinPolicy(defaultJoinPolicyFor(next, room.contextType, joinPolicy))
            }}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend id={policyGroup} className="mb-1 text-meta text-text-secondary">
          {copy.whoCanJoin}
        </legend>
        {policyOptions.map((option) => (
          <OptionRow
            key={option.joinPolicy}
            name={policyGroup}
            value={option.joinPolicy}
            label={option.label}
            description={option.description}
            checked={option.joinPolicy === effectivePolicy}
            onSelect={setJoinPolicy}
          />
        ))}
      </fieldset>
      <p className="text-meta text-text-secondary">{roomCopy.consentAllRequired}</p>
      {error !== null ? (
        <p role="alert" className="text-secondary text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        <Button type="submit" variant="primary" fullWidth loading={busy} disabled={unchanged}>
          {roomCopy.applyVisibility}
        </Button>
        <Button variant="quiet" fullWidth onClick={onClose}>
          {copy.notNow}
        </Button>
      </div>
    </form>
  )
}

export function OpenUpSheet(props: OpenUpSheetProps) {
  const { open, onClose } = props
  return (
    <Sheet open={open} onClose={onClose} title={copy.openUp} closeButton>
      {open ? <OpenUpForm {...props} /> : null}
    </Sheet>
  )
}
