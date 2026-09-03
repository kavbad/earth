/**
 * "Share with Weekend Crew" (spec §75): pick who, how precisely and for how long — 1 hour,
 * Tonight, Custom (bounded, never a day or more) — then the device position is asked for once,
 * right here (when-in-use), and sent with `location_share_create`. No forever. Coordinates
 * never leave for analytics.
 */
import { LOCATION_PRECISION, type LocationPrecision, type LocationShareDto } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { SegmentedText } from '@/components/ui/SegmentedText'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { earthCopy, locationCopy } from '@/features/earth/copy'
import { errorCode } from '@/features/earth/errors'
import { lightTap, selectionTap } from '@/features/earth/haptics'
import { deviceLocation } from '@/features/earth/location'
import { useEarthShell } from '@/features/earth/shell'
import {
  CUSTOM_DURATION_MINUTES,
  DEFAULT_CUSTOM_MINUTES,
  SHARE_DURATION_KINDS,
  type ShareDurationKind,
  durationMinutesFor,
  expiresAtFor,
  formatClock,
  formatMinutes,
} from '@/features/earth/state/duration'
import { messageForFailure, requestPosition } from '@/features/earth/state/location'
import type { ShareAudience } from '@/features/earth/state/you'

export type { ShareAudience }

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
  const { earth } = useEarthShell()
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
    if (target === null || busy) return
    lightTap()
    setBusy(true)
    setError(null)
    const position = await requestPosition(deviceLocation(), {
      precision,
      requestPermission: true,
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
          : earthCopy.somethingWrong,
      )
    } finally {
      setBusy(false)
    }
  }, [busy, earth, target, precision, kind, customMinutes, now, onShared, close])

  const title = target === null ? locationCopy.chooseAudience : copy.shareWith(target.name)

  return (
    <Sheet open={open} onClose={close} title={title} closeButton scroll>
      {target === null ? (
        audiences.length === 0 ? (
          <Text style={[text.body, text.muted]}>{locationCopy.noAudiences}</Text>
        ) : (
          <View>
            {audiences.map((candidate, index) => (
              <ListRow
                key={`${candidate.type}:${candidate.id}`}
                title={candidate.name}
                flush
                separator={index < audiences.length - 1}
                onPress={() => {
                  selectionTap()
                  setPicked(candidate)
                }}
              />
            ))}
          </View>
        )
      ) : (
        <View style={styles.form}>
          <View style={styles.group}>
            <SegmentedText
              label={locationCopy.durationLabel}
              options={SHARE_DURATION_KINDS.map((option) => ({
                key: option,
                label: DURATION_LABELS[option],
              }))}
              value={kind}
              onSelect={(next) => {
                selectionTap()
                setKind(next)
              }}
            />
            {kind === 'custom' ? (
              <View accessibilityRole="radiogroup" accessibilityLabel={locationCopy.customLabel}>
                <Text style={[text.meta, text.muted]}>{locationCopy.customLabel}</Text>
                {CUSTOM_DURATION_MINUTES.map((option, index) => (
                  <ListRow
                    key={option}
                    title={formatMinutes(option)}
                    flush
                    accessibilityRole="radio"
                    selected={option === customMinutes}
                    separator={index < CUSTOM_DURATION_MINUTES.length - 1}
                    trailing={
                      option === customMinutes ? (
                        <Text style={[text.meta, text.primary]}>{copy.done}</Text>
                      ) : undefined
                    }
                    onPress={() => {
                      selectionTap()
                      setCustomMinutes(option)
                    }}
                  />
                ))}
              </View>
            ) : null}
            <Text style={[text.secondary, text.muted]}>
              {formatMinutes(minutes)} · {locationCopy.until(until)}
            </Text>
          </View>
          <View style={styles.group}>
            <SegmentedText
              label={locationCopy.precisionLabel}
              options={LOCATION_PRECISION.map((option) => ({
                key: option,
                label: locationCopy.precision[option],
              }))}
              value={precision}
              onSelect={(next) => {
                selectionTap()
                setPrecision(next)
              }}
            />
            <Text style={[text.secondary, text.muted]}>
              {locationCopy.precisionHint[precision]}
            </Text>
          </View>
          <Text style={[text.secondary, text.muted]}>{locationCopy.boundedNote}</Text>
          {error !== null ? (
            <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              variant="primary"
              fullWidth
              loading={busy}
              label={locationCopy.share}
              onPress={() => void share()}
            />
            <Button variant="quiet" fullWidth label={copy.notNow} onPress={close} />
          </View>
        </View>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[5] },
  group: { gap: space[2] },
  actions: { gap: space[2] },
})
