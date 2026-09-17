'use client'

/**
 * "Share with Weekend Crew" (spec §75): pick who, how precisely and for how long — 1 hour,
 * Tonight, Custom (bounded) — then the device position is asked for once, right here, and sent
 * with `location_share_create`. No forever. Coordinates never leave for analytics.
 */
import type { LocationAudienceType, LocationPrecision, LocationShareDto } from '@earth/domain'
import { LOCATION_PRECISION } from '@earth/domain'
import { copy } from '@earth/ui'
import { useCallback, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { errorCode } from '../../lib/errors'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { SegmentedText } from '../ui/SegmentedText'
import { Sheet } from '../ui/Sheet'
import { locationCopy } from './copy'
import { browserGeolocation, messageForFailure, requestPosition } from './geolocation'
import {
  CUSTOM_DURATION_MINUTES,
  DEFAULT_CUSTOM_MINUTES,
  SHARE_DURATION_KINDS,
  type ShareDurationKind,
  durationMinutesFor,
  expiresAtFor,
  formatClock,
  formatMinutes,
  tonightMinutes,
} from './state/duration'

export interface ShareAudience {
  readonly type: LocationAudienceType
  readonly id: string
  readonly name: string
}

export const DEFAULT_SHARE_PRECISION: LocationPrecision = 'approximate'

export interface ShareLocationSheetProps {
  readonly open: boolean
  /** Preselected audience (`/earth?share=…`), or `null` to pick from `audiences`. */
  readonly audience: ShareAudience | null
  readonly audiences: readonly ShareAudience[]
  readonly onClose: () => void
  readonly onShared: (share: LocationShareDto, audience: ShareAudience) => void
  /** The moment "Tonight" is computed from; defaults to now. */
  readonly now?: () => Date
}

const DURATION_LABELS: Record<ShareDurationKind, string> = {
  oneHour: copy.durations.oneHour,
  tonight: copy.durations.tonight,
  custom: copy.durations.custom,
}

export function ShareLocationSheet({
  open,
  audience,
  audiences,
  onClose,
  onShared,
  now = () => new Date(),
}: ShareLocationSheetProps) {
  const earth = useEarth()
  const [picked, setPicked] = useState<ShareAudience | null>(null)
  const [kind, setKind] = useState<ShareDurationKind>('oneHour')
  const [customMinutes, setCustomMinutes] = useState<number>(DEFAULT_CUSTOM_MINUTES)
  const [precision, setPrecision] = useState<LocationPrecision>(DEFAULT_SHARE_PRECISION)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    setPicked(null)
    setError(null)
    onClose()
  }, [onClose])

  const target = picked ?? audience
  const minutes = durationMinutesFor({ kind, customMinutes }, now())
  const until = formatClock(expiresAtFor(now(), minutes))

  const share = useCallback(async () => {
    if (target === null) return
    setBusy(true)
    setError(null)
    const position = await requestPosition(browserGeolocation(), {
      highAccuracy: precision === 'precise',
    })
    if (!position.ok) {
      setError(messageForFailure(position.failure))
      setBusy(false)
      return
    }
    try {
      const created = await earth.location.share({
        audienceType: target.type,
        audienceId: target.id,
        precision,
        durationMinutes: durationMinutesFor({ kind, customMinutes }, now()),
        position: position.position,
      })
      onShared(created, target)
      close()
    } catch (cause) {
      setError(
        errorCode(cause) === 'location_sharing_disabled'
          ? locationCopy.sharingOff
          : webCopy.somethingWrong,
      )
    } finally {
      setBusy(false)
    }
  }, [earth, target, precision, kind, customMinutes, now, onShared, close])

  const title = target === null ? locationCopy.chooseAudience : copy.shareWith(target.name)

  return (
    <Sheet open={open} onClose={close} title={title} closeButton>
      {target === null ? (
        audiences.length === 0 ? (
          <p className="text-body text-text-secondary">{locationCopy.noAudiences}</p>
        ) : (
          <List>
            {audiences.map((candidate) => (
              <ListRow
                key={`${candidate.type}:${candidate.id}`}
                as="button"
                title={candidate.name}
                onClick={() => setPicked(candidate)}
                className="px-0"
              />
            ))}
          </List>
        )
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <SegmentedText
              role="radiogroup"
              label={locationCopy.durationLabel}
              options={SHARE_DURATION_KINDS.map((option) => ({
                key: option,
                label: DURATION_LABELS[option],
              }))}
              value={kind}
              onSelect={setKind}
            />
            {kind === 'custom' ? (
              <label className="flex flex-col gap-1 text-secondary text-text-secondary">
                {locationCopy.customLabel}
                <select
                  value={customMinutes}
                  onChange={(event) => setCustomMinutes(Number(event.target.value))}
                  className="min-h-touch-target rounded-medium bg-subtle-fill px-4 text-body text-text-primary"
                >
                  {CUSTOM_DURATION_MINUTES.map((option) => (
                    <option key={option} value={option}>
                      {formatMinutes(option)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p className="text-secondary text-text-secondary">
              {kind === 'tonight' ? formatMinutes(tonightMinutes(now())) : formatMinutes(minutes)} ·{' '}
              {locationCopy.until(until)}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <SegmentedText
              role="radiogroup"
              label={locationCopy.precisionLabel}
              options={LOCATION_PRECISION.map((option) => ({
                key: option,
                label: locationCopy.precision[option],
              }))}
              value={precision}
              onSelect={setPrecision}
            />
            <p className="text-secondary text-text-secondary">
              {locationCopy.precisionHint[precision]}
            </p>
          </div>
          <p className="text-secondary text-text-secondary">{locationCopy.boundedNote}</p>
          {error !== null ? (
            <p role="alert" className="text-secondary text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button variant="primary" fullWidth loading={busy} onClick={() => void share()}>
              {locationCopy.share}
            </Button>
            <Button variant="quiet" fullWidth onClick={close}>
              {copy.notNow}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
