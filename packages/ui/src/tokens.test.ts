import { describe, expect, it } from 'vitest'

import {
  BASELINE,
  COLOR_NAMES,
  HALF_STEP,
  TYPE_LINE_HEIGHT_STEP,
  TYPOGRAPHY_NAMES,
  type TypeStyle,
  avatarTints,
  borderWidth,
  colors,
  fontFace,
  fontFamily,
  fontWeight,
  motion,
  radius,
  shadow,
  space,
  spacing,
  tokens,
  touchTarget,
  typography,
  zIndex,
} from './tokens'

describe('palette (spec §89)', () => {
  it('matches the canonical hex values exactly', () => {
    expect(colors).toEqual({
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
    })
    expect(COLOR_NAMES).toHaveLength(11)
    for (const name of COLOR_NAMES) expect(colors[name]).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('keeps the accent green and quiet, far from Live red', () => {
    const [r, g, b] = rgb(colors.earthAccent)
    expect(g).toBeGreaterThan(r)
    expect(g).toBeGreaterThan(b)
    // Deep enough to carry text on white (links, selected labels).
    expect(contrast(colors.earthAccent, colors.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(colors.textTertiary, colors.background)).toBeLessThan(
      contrast(colors.textSecondary, colors.background),
    )
  })

  it('gives every avatar tint a legible foreground on its own fill', () => {
    expect(avatarTints).toHaveLength(8)
    expect(new Set(avatarTints.map((tint) => tint.name)).size).toBe(8)
    for (const tint of avatarTints) {
      expect(tint.bg).toMatch(/^#[0-9A-F]{6}$/)
      expect(tint.fg).toMatch(/^#[0-9A-F]{6}$/)
      expect(contrast(tint.fg, tint.bg)).toBeGreaterThanOrEqual(4.5)
      // Fills stay close to the page so a face never becomes a badge.
      expect(contrast(tint.bg, colors.background)).toBeLessThan(1.35)
    }
  })

  it('uses the platform semantic red / green, distinct from Live red', () => {
    // iOS `systemRed` / `systemGreen` (light appearance) — "semantic system red / green".
    expect(colors.danger).toBe('#FF3B30')
    expect(colors.success).toBe('#34C759')
    expect(colors.danger).not.toBe(colors.live)
  })
})

describe('typography (spec §90)', () => {
  it('matches the scale exactly', () => {
    expect(TYPOGRAPHY_NAMES).toEqual(['display', 'title', 'section', 'body', 'secondary', 'meta'])
    expect(typography.display).toMatchObject({
      size: 36,
      weight: fontWeight.medium,
      family: 'serif',
    })
    expect(typography.title).toMatchObject({ size: 28, weight: fontWeight.medium, family: 'serif' })
    expect(typography.section).toMatchObject({
      size: 18,
      weight: fontWeight.semibold,
      family: 'sans',
    })
    expect(typography.body).toMatchObject({ size: 16, weight: fontWeight.regular, family: 'sans' })
    expect(typography.secondary).toMatchObject({
      size: 14,
      weight: fontWeight.regular,
      family: 'sans',
    })
    expect(typography.meta).toMatchObject({ size: 12, weight: fontWeight.medium, family: 'sans' })
    expect(fontWeight).toEqual({ regular: 400, medium: 500, semibold: 600 })
  })

  it('tightens the serif sizes a touch and opens the meta line', () => {
    expect(typography.display.letterSpacing).toBeLessThan(0)
    expect(typography.title.letterSpacing).toBeLessThan(0)
    expect(typography.meta.letterSpacing).toBeGreaterThan(0)
    for (const name of TYPOGRAPHY_NAMES) {
      const style: TypeStyle = typography[name]
      const tracking = style.letterSpacing ?? 0
      expect(Math.abs(tracking)).toBeLessThanOrEqual(0.02)
    }
  })

  it('line heights sit on the 4pt half-step and never clip', () => {
    expect(TYPE_LINE_HEIGHT_STEP).toBe(HALF_STEP)
    for (const name of TYPOGRAPHY_NAMES) {
      const { size, lineHeight } = typography[name]
      expect(lineHeight % TYPE_LINE_HEIGHT_STEP).toBe(0)
      expect(lineHeight).toBeGreaterThanOrEqual(size)
      expect(lineHeight / size).toBeLessThanOrEqual(1.5)
    }
  })

  it('is a serif for statements and a sans for everything functional', () => {
    expect(Object.keys(fontFamily)).toEqual(['serif', 'sans'])
    expect(fontFamily.serif.startsWith(`'${fontFace.serif}'`)).toBe(true)
    expect(fontFamily.serif.endsWith('serif')).toBe(true)
    expect(fontFamily.sans.startsWith(`'${fontFace.sans}'`)).toBe(true)
    expect(fontFamily.sans).toContain('system-ui')
    expect(fontFamily.sans.endsWith('sans-serif')).toBe(true)
    expect(fontFamily.sans).not.toMatch(/cursive|fantasy|monospace/)
    // Section and below are the functional labels: never the serif.
    for (const name of ['section', 'body', 'secondary', 'meta'] as const) {
      expect(typography[name].family).toBe('sans')
    }
  })
})

describe('spacing (spec §91)', () => {
  it('sits on the 4/8-point baseline', () => {
    expect(BASELINE).toBe(8)
    expect(HALF_STEP).toBe(4)
    for (const [step, value] of Object.entries(space)) expect(value).toBe(Number(step) * HALF_STEP)
    for (const value of Object.values(spacing)) expect(value % HALF_STEP).toBe(0)
    expect(spacing.screenMargin).toBe(16)
    expect(spacing.screenMargin % BASELINE).toBe(0)
    expect(spacing.feedGap).toBe(24)
    expect(spacing.feedGapMin).toBe(20)
    expect(spacing.feedGapMax).toBe(28)
    expect(spacing.feedGap).toBeGreaterThanOrEqual(spacing.feedGapMin)
    expect(spacing.feedGap).toBeLessThanOrEqual(spacing.feedGapMax)
    expect(spacing.rowGap).toBe(8)
    expect(spacing.rowGapLoose).toBe(12)
  })
})

describe('radii, motion, hairlines, layering', () => {
  it('matches the contract', () => {
    expect(radius).toEqual({ small: 8, medium: 10, large: 16, avatar: 999 })
    expect(shadow.sheet.opacity).toBeGreaterThan(0)
    expect(shadow.sheet.opacity).toBeLessThanOrEqual(0.2)
    expect(shadow.sheet.blur).toBeGreaterThan(shadow.sheet.y)
    expect(motion.duration).toEqual({ fast: 180, base: 240, slow: 300 })
    for (const value of Object.values(motion.duration)) {
      expect(value).toBeGreaterThanOrEqual(180)
      expect(value).toBeLessThanOrEqual(300)
    }
    expect(borderWidth.hairline).toBe(0.5)
    expect(borderWidth.separator).toBe(1)
    expect(borderWidth.indicator).toBeGreaterThanOrEqual(1)
    expect(borderWidth.indicator).toBeLessThanOrEqual(2)
    expect(zIndex.toast).toBeGreaterThan(zIndex.modal)
    expect(zIndex.modal).toBeGreaterThan(zIndex.sheet)
    expect(zIndex.sheet).toBeGreaterThan(zIndex.overlay)
    expect(touchTarget).toBe(44)
    expect(tokens.colors).toBe(colors)
    expect(tokens.typography).toBe(typography)
  })

  it('CSS easing strings and mobile curves are the same control points', () => {
    const names = Object.keys(motion.easing) as ReadonlyArray<keyof typeof motion.easing>
    expect(Object.keys(motion.curve)).toEqual([...names])
    for (const name of names) {
      const match = /^cubic-bezier\(([^)]+)\)$/.exec(motion.easing[name])
      expect(match).not.toBeNull()
      const points = (match?.[1] ?? '').split(',').map((part) => Number(part.trim()))
      expect(points).toEqual([...motion.curve[name]])
      for (const x of [points[0], points[2]]) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(1)
      }
    }
  })
})

// WCAG 2.x relative luminance and contrast ratio, for the palette assertions above.
function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}
