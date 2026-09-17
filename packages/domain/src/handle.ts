/**
 * Handle normalization, validation and deterministic suggestion (spec §45: "handle
 * auto-suggested, editable"). Uniqueness is enforced by the database (`handle_taken`).
 */
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH, HANDLE_REGEX } from './constants'

const FALLBACK_HANDLE_BASE = 'human'

/**
 * Lowercases, strips a leading `@`, folds diacritics, converts separators to `_`, drops every
 * other character and collapses runs of underscores. Does not guarantee validity — check with
 * `isValidHandle` afterwards.
 */
export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/^@+/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_REGEX.test(handle)
}

export type HandleValidationError = 'too_short' | 'too_long' | 'invalid_start' | 'invalid_chars'

/** Explains why a handle is invalid, or `null` when it is valid. */
export function handleValidationError(handle: string): HandleValidationError | null {
  if (isValidHandle(handle)) return null
  if (!/^[a-z0-9_]*$/.test(handle)) return 'invalid_chars'
  if (handle.length < HANDLE_MIN_LENGTH) return 'too_short'
  if (handle.length > HANDLE_MAX_LENGTH) return 'too_long'
  return 'invalid_start'
}

/**
 * Deterministic handle base for a display name: normalized, leading non-letters removed,
 * padded to the minimum length with `_` when too short, truncated to the maximum length.
 * Falls back to `human` when nothing usable remains (for example an all-emoji name).
 */
export function handleBaseFor(displayName: string): string {
  let base = normalizeHandle(displayName).replace(/^[^a-z]+/, '')
  if (base.length === 0) base = FALLBACK_HANDLE_BASE
  if (base.length < HANDLE_MIN_LENGTH) base = base.padEnd(HANDLE_MIN_LENGTH, '_')
  if (base.length > HANDLE_MAX_LENGTH) base = base.slice(0, HANDLE_MAX_LENGTH).replace(/_+$/, '')
  if (base.length < HANDLE_MIN_LENGTH) base = base.padEnd(HANDLE_MIN_LENGTH, '_')
  return base
}

/**
 * Suggests a handle for a display name. `attempt` 0 returns the base (`maya`); attempt `n` appends
 * the numeric suffix `n + 1` (`maya2`, `maya3`, ...), trimming the base so the result stays within
 * the maximum length. Always returns a valid handle.
 */
export function suggestHandle(displayName: string, attempt = 0): string {
  const base = handleBaseFor(displayName)
  if (attempt <= 0) return base
  const suffix = String(attempt + 1)
  const room = HANDLE_MAX_LENGTH - suffix.length
  const trimmed = base.slice(0, room).replace(/_+$/, '')
  const stem = trimmed.length >= HANDLE_MIN_LENGTH ? trimmed : FALLBACK_HANDLE_BASE.slice(0, room)
  return `${stem}${suffix}`
}

/** The first `count` suggestions for a display name, in attempt order. */
export function handleCandidates(displayName: string, count: number): string[] {
  const out: string[] = []
  for (let attempt = 0; attempt < count; attempt += 1) {
    out.push(suggestHandle(displayName, attempt))
  }
  return out
}

/**
 * Walks suggestions until `isTaken` returns false. `maxAttempts` bounds the walk; returns `null`
 * when every candidate was taken (callers then ask the Human to pick one).
 */
export function firstAvailableHandle(
  displayName: string,
  isTaken: (handle: string) => boolean,
  maxAttempts = 50,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = suggestHandle(displayName, attempt)
    if (!isTaken(candidate)) return candidate
  }
  return null
}
