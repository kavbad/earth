/**
 * Design tokens — the only source of colors, type faces and scale, spacing, radii, shadow and
 * motion for both clients (ARCHITECTURE §13). The palette hexes, type scale and motion range are
 * exactly EARTH_V1_SPEC.md PART XV (§89–§95); everything else here is derived from the 8-point
 * baseline.
 *
 * Web consumes these through `css.ts` (CSS variables + Tailwind 4 theme); mobile consumes the
 * TypeScript objects directly. Never hard-code a color, size or duration in a client.
 */

// ---------------------------------------------------------------------------
// §89 Canonical palette
// ---------------------------------------------------------------------------

/**
 * Spec §89. `danger` / `success` are the "semantic system red / green": the platform's own
 * semantic colors (iOS `systemRed` / `systemGreen` in the light appearance), pinned to one hex so
 * web and Android render the same value. They are never the Live red — Earth accent appears
 * sparingly and Live red carries much stronger semantic importance. `earthAccent` is fern green:
 * links, selection, focus and the Earth mark, never a fill behind text. `textTertiary` is the
 * third gray, for timestamps and metadata that must read as furniture, not content.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  textPrimary: '#111214',
  textSecondary: '#72757A',
  textTertiary: '#A2A5AA',
  separator: '#ECEDEF',
  subtleFill: '#F6F7F8',
  live: '#E6463E',
  earthAccent: '#2F6B4C',
  danger: '#FF3B30',
  success: '#34C759',
} as const

export type ColorName = keyof typeof colors
export type ColorValue = (typeof colors)[ColorName]
export const COLOR_NAMES = Object.keys(colors) as readonly ColorName[]

/**
 * Initials avatars carry one of these muted pairs, chosen by `avatarTintIndex(name)` (format.ts)
 * so a person keeps their tint everywhere. Each `fg` on its `bg` reads at ≥ 4.5:1; none of them
 * competes with Live red or the accent for attention.
 */
export const avatarTints = [
  { name: 'moss', bg: '#E3EBE2', fg: '#2F6B4C' },
  { name: 'sky', bg: '#E1EAF3', fg: '#2C4F7C' },
  { name: 'sand', bg: '#EFE9D6', fg: '#6B5A22' },
  { name: 'slate', bg: '#E2E7EC', fg: '#3A4C5C' },
  { name: 'plum', bg: '#EAE2EC', fg: '#5B3D63' },
  { name: 'sea', bg: '#DEEAEA', fg: '#2F5F62' },
  { name: 'rose', bg: '#F1E2E4', fg: '#7A3B44' },
  { name: 'stone', bg: '#EBEBE6', fg: '#4A4C45' },
] as const
export type AvatarTint = (typeof avatarTints)[number]

// ---------------------------------------------------------------------------
// §90 Typography
// ---------------------------------------------------------------------------

/**
 * Two faces (spec §90): a serif for statements — the wordmark, Display and Title, onboarding
 * lines, empty-state headlines — and a quiet grotesk for every functional label. `fontFace` names
 * the faces as the font files register them; web builds its stacks from those names (fontsource,
 * self-hosted), mobile maps a face and weight to the bundled file (`components/ui/text.ts`).
 * No decorative type in functional UI: Section and below are always the sans.
 */
export const fontFace = {
  serif: 'Newsreader Variable',
  sans: 'Instrument Sans Variable',
} as const
export type FontFaceName = keyof typeof fontFace

export const fontFamily = {
  serif: `'${fontFace.serif}', 'Iowan Old Style', Georgia, 'Times New Roman', serif`,
  sans: `'${fontFace.sans}', -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
} as const satisfies Record<FontFaceName, string>
export type FontFamilyName = keyof typeof fontFamily

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
} as const
export type FontWeightName = keyof typeof fontWeight
export type FontWeight = (typeof fontWeight)[FontWeightName]

export interface TypeStyle {
  /** Font size in points / CSS px. */
  readonly size: number
  readonly weight: FontWeight
  /** Absolute line height in points / CSS px — always a multiple of the 4pt half-step (§91). */
  readonly lineHeight: number
  readonly family: FontFamilyName
  /** Tracking in em; display sizes tighten a touch, meta opens up. Omitted means the face's own. */
  readonly letterSpacing?: number
}

/**
 * Spec §90 scale (size / weight are exact). Line heights are fixed multiples of the 4pt half-step
 * so stacked text sits on the 8pt baseline (§91) — `TYPE_LINE_HEIGHT_STEP` is asserted in tests.
 */
export const TYPE_LINE_HEIGHT_STEP = 4
export const typography = {
  display: {
    size: 36,
    weight: fontWeight.medium,
    lineHeight: 44,
    family: 'serif',
    letterSpacing: -0.01,
  },
  title: {
    size: 28,
    weight: fontWeight.medium,
    lineHeight: 36,
    family: 'serif',
    letterSpacing: -0.005,
  },
  section: { size: 18, weight: fontWeight.semibold, lineHeight: 24, family: 'sans' },
  body: { size: 16, weight: fontWeight.regular, lineHeight: 24, family: 'sans' },
  secondary: { size: 14, weight: fontWeight.regular, lineHeight: 20, family: 'sans' },
  meta: {
    size: 12,
    weight: fontWeight.medium,
    lineHeight: 16,
    family: 'sans',
    letterSpacing: 0.01,
  },
} as const satisfies Record<string, TypeStyle>

export type TypographyName = keyof typeof typography
export const TYPOGRAPHY_NAMES = Object.keys(typography) as readonly TypographyName[]

// ---------------------------------------------------------------------------
// §91 Spacing — 8-point baseline
// ---------------------------------------------------------------------------

/** The 8-point baseline (§91) and its 4pt half-step. */
export const BASELINE = 8
export const HALF_STEP = 4

/** Spacing steps: `space[n]` = 4n. Use named `spacing` for layout decisions the spec names. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const
export type SpaceStep = keyof typeof space

/**
 * Spec §91: screen horizontal margin 16; feed object spacing 20–28 (24 default); compact row gap
 * 8–12 (8 default). Do not over-card the interface.
 */
export const spacing = {
  screenMargin: 16,
  feedGap: 24,
  feedGapMin: 20,
  feedGapMax: 28,
  rowGap: 8,
  rowGapLoose: 12,
} as const
export type SpacingName = keyof typeof spacing

// ---------------------------------------------------------------------------
// Radii
// ---------------------------------------------------------------------------

/**
 * `small` for chips and skeletons, `medium` for buttons, fields and bubbles, `large` for sheets
 * and media, `avatar` is "fully round" (any value ≥ half the box). No thick rounded cards around
 * posts (§92).
 */
export const radius = {
  small: 8,
  medium: 10,
  large: 16,
  avatar: 999,
} as const
export type RadiusName = keyof typeof radius

// ---------------------------------------------------------------------------
// §95 Motion — restrained 180–300 ms transitions
// ---------------------------------------------------------------------------

/** Cubic-bezier control points `[x1, y1, x2, y2]` — for RN `Easing.bezier(...)`. */
export type BezierCurve = readonly [number, number, number, number]

export const motion = {
  /** Milliseconds. */
  duration: {
    fast: 180,
    base: 240,
    slow: 300,
  },
  /** CSS timing functions. */
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    enter: 'cubic-bezier(0, 0, 0.2, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
  },
  /** The same curves as control points (mobile). */
  curve: {
    standard: [0.2, 0, 0, 1],
    enter: [0, 0, 0.2, 1],
    exit: [0.4, 0, 1, 1],
  },
} as const satisfies {
  duration: Record<string, number>
  easing: Record<string, string>
  curve: Record<string, BezierCurve>
}
export type DurationName = keyof typeof motion.duration
export type EasingName = keyof typeof motion.easing

// ---------------------------------------------------------------------------
// Hairlines, layering, hit targets, fixed sizes
// ---------------------------------------------------------------------------

/**
 * `hairline` is the thinnest line a device draws (RN `StyleSheet.hairlineWidth` ≈ 0.5 on 2×/3×);
 * `separator` is the 1 px list separator; `indicator` is the 1–2 px selected-scope underline (§93).
 */
export const borderWidth = {
  hairline: 0.5,
  separator: 1,
  indicator: 1.5,
} as const
export type BorderWidthName = keyof typeof borderWidth

/**
 * The one shadow: sheets, dialogs, toasts and map pills lift off the page with it. Ink at a low
 * opacity, never a colored glow. Web renders it as `box-shadow`; mobile derives `shadowOffset` /
 * `elevation` from the same numbers.
 */
export const shadow = {
  sheet: { y: 12, blur: 32, opacity: 0.12 },
} as const satisfies Record<string, { y: number; blur: number; opacity: number }>
export type ShadowName = keyof typeof shadow

export const zIndex = {
  base: 0,
  raised: 1,
  sticky: 10,
  overlay: 100,
  sheet: 200,
  modal: 300,
  toast: 400,
} as const
export type ZIndexName = keyof typeof zIndex

/** Minimum interactive hit target, in points. */
export const touchTarget = 44

export const iconSize = {
  small: 16,
  base: 24,
  large: 32,
} as const
export type IconSizeName = keyof typeof iconSize

export const avatarSize = {
  small: 32,
  medium: 40,
  large: 64,
  profile: 96,
} as const
export type AvatarSizeName = keyof typeof avatarSize

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const tokens = {
  colors,
  avatarTints,
  fontFace,
  fontFamily,
  fontWeight,
  typography,
  space,
  spacing,
  radius,
  shadow,
  motion,
  borderWidth,
  zIndex,
  touchTarget,
  iconSize,
  avatarSize,
} as const

export type Tokens = typeof tokens
