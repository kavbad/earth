/**
 * Share durations (spec §75: "1 hour, Tonight, custom short period. No 'forever' default"),
 * pure. Bounds are the domain's (`LOCATION_SHARE_MIN_MINUTES` … `LOCATION_SHARE_MAX_MINUTES`),
 * which `earth.location.share` enforces before any round trip.
 */
import {
  LOCATION_SHARE_DEFAULT_MINUTES,
  LOCATION_SHARE_MAX_MINUTES,
  LOCATION_SHARE_MIN_MINUTES,
} from '@earth/domain'

export const SHARE_DURATION_KINDS = ['oneHour', 'tonight', 'custom'] as const
export type ShareDurationKind = (typeof SHARE_DURATION_KINDS)[number]

export const ONE_HOUR_MINUTES = LOCATION_SHARE_DEFAULT_MINUTES

/** "Tonight" ends at this local hour of the next morning. */
export const TONIGHT_END_HOUR = 2

/** Custom lengths offered, in minutes, within the domain bounds. */
export const CUSTOM_DURATION_MINUTES: readonly number[] = [15, 30, 120, 240, 480, 720].filter(
  (minutes) => minutes >= LOCATION_SHARE_MIN_MINUTES && minutes <= LOCATION_SHARE_MAX_MINUTES,
)

export const DEFAULT_CUSTOM_MINUTES =
  CUSTOM_DURATION_MINUTES.find((minutes) => minutes >= 120) ?? LOCATION_SHARE_MIN_MINUTES

export function clampMinutes(minutes: number): number {
  return Math.max(
    LOCATION_SHARE_MIN_MINUTES,
    Math.min(LOCATION_SHARE_MAX_MINUTES, Math.round(minutes)),
  )
}

/** Minutes from `now` to the next `TONIGHT_END_HOUR` (local time), within the bounds. */
export function tonightMinutes(now: Date): number {
  const end = new Date(now.getTime())
  end.setHours(TONIGHT_END_HOUR, 0, 0, 0)
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1)
  return clampMinutes(Math.ceil((end.getTime() - now.getTime()) / 60_000))
}

export type DurationValidation =
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly reason: 'not_a_number' | 'too_short' | 'too_long' }

/** The exact domain rule, reported instead of clamped (for a typed custom value). */
export function validateDurationMinutes(value: number): DurationValidation {
  if (!Number.isFinite(value) || !Number.isInteger(value))
    return { ok: false, reason: 'not_a_number' }
  if (value < LOCATION_SHARE_MIN_MINUTES) return { ok: false, reason: 'too_short' }
  if (value > LOCATION_SHARE_MAX_MINUTES) return { ok: false, reason: 'too_long' }
  return { ok: true, minutes: value }
}

export interface DurationChoice {
  readonly kind: ShareDurationKind
  readonly customMinutes: number
}

/** Minutes for a choice; every path lands inside the bounds. */
export function durationMinutesFor(choice: DurationChoice, now: Date): number {
  switch (choice.kind) {
    case 'oneHour':
      return clampMinutes(ONE_HOUR_MINUTES)
    case 'tonight':
      return tonightMinutes(now)
    case 'custom':
      return clampMinutes(choice.customMinutes)
    default: {
      const exhaustive: never = choice.kind
      throw new Error(`Unknown duration kind: ${String(exhaustive)}`)
    }
  }
}

export function expiresAtFor(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000)
}

/** `2 hours` · `45 min` · `1 hour 30 min` for the custom picker and rows. */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${minutes} min`
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`
  return rest === 0 ? hourPart : `${hourPart} ${rest} min`
}

/** Local clock time for "until 9:30 PM"; UTC option for deterministic tests. */
export function formatClock(date: Date, options: { readonly utc?: boolean } = {}): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.utc === true ? { timeZone: 'UTC' } : {}),
  }).format(date)
}
