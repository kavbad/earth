/**
 * Formatters shared verbatim by both clients (ARCHITECTURE §1 rule-home table: relative time and
 * participant naming strings live here). Pure, deterministic, English-only in V1.
 *
 * `@earth/ui` is a leaf package: it imports no other workspace package. The naming rules below
 * mirror `@earth/domain`'s `formatNameList` (spec §59 / §86) so server-rendered push copy and
 * client-rendered rows agree character for character; both sides pin the same spec examples.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Weekday names are shown for up to six days so the label never equals today's weekday. */
const WEEKDAY_WINDOW_MS = 6 * DAY_MS

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/** Names spelled out before the rest collapses into a count: `Xavier, Maya + 2` (spec §86). */
export const SPELLED_NAMES_MAX = 2

/** Separator between a row's primary label and its detail: `College — Maya + 2 live` (SCREEN 08). */
export const EM_DASH_SEPARATOR = ' — '

export type DateInput = Date | string | number

export interface RelativeTimeOptions {
  /** Format calendar parts in UTC instead of the device time zone. */
  readonly utc?: boolean
}

function toMs(input: DateInput): number {
  return input instanceof Date ? input.getTime() : new Date(input).getTime()
}

function calendarParts(
  date: Date,
  utc: boolean,
): { weekday: number; month: number; day: number; year: number } {
  return utc
    ? {
        weekday: date.getUTCDay(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        year: date.getUTCFullYear(),
      }
    : {
        weekday: date.getDay(),
        month: date.getMonth(),
        day: date.getDate(),
        year: date.getFullYear(),
      }
}

/**
 * Compact relative timestamp for rows and metadata:
 * `now` (< 1 min) · `3m` · `2h` · `Tue` (< 6 days) · `Mar 4` · `Mar 4, 2025` (other year).
 * Future dates (clock skew) render as `now`. Invalid dates render as an empty string.
 */
export function relativeTime(
  date: DateInput,
  now: DateInput = new Date(),
  options: RelativeTimeOptions = {},
): string {
  const dateMs = toMs(date)
  const nowMs = toMs(now)
  if (!Number.isFinite(dateMs) || !Number.isFinite(nowMs)) return ''
  const diff = nowMs - dateMs
  if (diff < MINUTE_MS) return 'now'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`
  const utc = options.utc === true
  const then = calendarParts(new Date(dateMs), utc)
  if (diff < WEEKDAY_WINDOW_MS) return WEEKDAYS[then.weekday] ?? ''
  const current = calendarParts(new Date(nowMs), utc)
  const monthDay = `${MONTHS[then.month] ?? ''} ${then.day}`
  return then.year === current.year ? monthDay : `${monthDay}, ${then.year}`
}

// ---------------------------------------------------------------------------
// Plurals and counts
// ---------------------------------------------------------------------------

/** `pluralWord(1, 'room')` → `room`; `pluralWord(3, 'room')` → `rooms`; custom plural allowed. */
export function pluralWord(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return Math.abs(count) === 1 ? singular : plural
}

/** `pluralize(3, 'room')` → `3 rooms`. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralWord(count, singular, plural)}`
}

/**
 * `999` → `999` · `1200` → `1.2k` · `15300` → `15k` · `1_200_000` → `1.2M`. Follower numbers are
 * visually secondary (SCREEN 22), so precision beyond one significant decimal is dropped.
 */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const truncated = Math.trunc(value)
  const abs = Math.abs(truncated)
  // Sign from the truncated value so `-0.5` renders `0`, never `-0`.
  const sign = truncated < 0 ? '-' : ''
  const oneDecimal = (n: number): string => String(Math.floor(n * 10) / 10)
  if (abs < 1_000) return `${sign}${abs}`
  if (abs < 10_000) return `${sign}${oneDecimal(abs / 1_000)}k`
  if (abs < 1_000_000) return `${sign}${Math.floor(abs / 1_000)}k`
  if (abs < 10_000_000) return `${sign}${oneDecimal(abs / 1_000_000)}M`
  return `${sign}${Math.floor(abs / 1_000_000)}M`
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export interface NameListOptions {
  /** Maximum names spelled out before collapsing the rest into a count. */
  readonly max?: number
  /** Total number of people when `names` is only a sample. Defaults to the number of names. */
  readonly total?: number
}

/** Trimmed, non-blank names — a blank display name is never a person. */
export function cleanNames(names: readonly string[]): string[] {
  return names.map((name) => name.trim()).filter((name) => name.length > 0)
}

function collapse(
  names: readonly string[],
  options: NameListOptions,
  defaultMax: number,
): { shown: string[]; rest: number } {
  const max = Math.max(0, Math.floor(options.max ?? defaultMax))
  const clean = cleanNames(names)
  const shown = clean.slice(0, max)
  const total = Math.max(options.total ?? clean.length, shown.length)
  return { shown, rest: total - shown.length }
}

/**
 * Comma list with a trailing `+ N others` — the invite-preview style (spec §46):
 * `joinNames(['Maya', 'Xavier', 'A', 'B', 'C', 'D', 'E'], 2)` → `Maya, Xavier + 5 others`.
 */
export function joinNames(
  names: readonly string[],
  max: number = SPELLED_NAMES_MAX,
  total?: number,
): string {
  const { shown, rest } = collapse(names, total === undefined ? { max } : { max, total }, max)
  if (shown.length === 0) return rest > 0 ? pluralize(rest, 'person', 'people') : ''
  const list = shown.join(', ')
  return rest > 0 ? `${list} + ${pluralize(rest, 'other')}` : list
}

/**
 * Live / room title style (spec §59, §86, SCREEN 08/14):
 * `Xavier` · `Xavier + Kavon` · `Xavier, Maya + 2` · `Maya + 2` (one visible name, three people).
 * At most `max` (default `SPELLED_NAMES_MAX`) names are spelled out; the remainder is a bare
 * count. Empty string when there is nobody to name.
 */
export function namesWithPlus(names: readonly string[], options: NameListOptions = {}): string {
  const { shown, rest } = collapse(names, options, SPELLED_NAMES_MAX)
  if (shown.length === 0) return rest > 0 ? pluralize(rest, 'person', 'people') : ''
  if (rest > 0) return `${shown.join(', ')} + ${rest}`
  if (shown.length === 1) return shown[0] ?? ''
  const last = shown[shown.length - 1] ?? ''
  return `${shown.slice(0, -1).join(', ')} + ${last}`
}

/**
 * Group invite preview participants (spec §46): sample members plus the remaining count —
 * `Maya, Xavier + 5 others`. The spec's example spells out two names, so `max` defaults to
 * `SPELLED_NAMES_MAX` even when the server sends a larger sample (the extra names feed avatars).
 */
export function participantSummary(
  sampleNames: readonly string[],
  totalCount: number,
  max: number = SPELLED_NAMES_MAX,
): string {
  return joinNames(sampleNames, max, totalCount)
}

/**
 * `joinWithDash('Weekend Crew', 'Maya, Xavier + 5 others')` → `Weekend Crew — Maya, Xavier + 5 others`
 * (spec §46, SCREEN 08/21/23). A blank side is dropped so the dash never dangles.
 */
export function joinWithDash(primary: string, detail: string): string {
  const head = primary.trim()
  const tail = detail.trim()
  if (head.length === 0) return tail
  if (tail.length === 0) return head
  return `${head}${EM_DASH_SEPARATOR}${tail}`
}

/** SCREEN 21/22: `8 mutual friends · San Francisco`. Omits empty parts; empty string if none. */
export function mutualLine(mutualCount: number, city?: string | null): string {
  const parts: string[] = []
  if (mutualCount > 0) parts.push(pluralize(mutualCount, 'mutual friend'))
  const trimmedCity = city?.trim() ?? ''
  if (trimmedCity.length > 0) parts.push(trimmedCity)
  return parts.join(' · ')
}

/** `Kavon Badie` → `KB` · `Xavier` → `X` · `@maya` → `M`. At most two characters. */
export function initials(displayName: string): string {
  const words = displayName
    .trim()
    .replace(/^@+/, '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
  if (words.length === 0) return ''
  const first = Array.from(words[0] ?? '')[0] ?? ''
  const lastWord = words.length > 1 ? (words[words.length - 1] ?? '') : ''
  const last = Array.from(lastWord)[0] ?? ''
  return `${first}${last}`.toUpperCase()
}

/** `maya` → `@maya`; an already-prefixed handle is returned unchanged; blank → empty string. */
export function formatHandle(handle: string): string {
  const bare = handle.trim().replace(/^@+/, '')
  return bare.length === 0 ? '' : `@${bare}`
}
