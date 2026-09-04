import { describe, expect, it } from 'vitest'

import {
  BASELINE,
  COLOR_NAMES,
  HALF_STEP,
  TYPE_LINE_HEIGHT_STEP,
  TYPOGRAPHY_NAMES,
  borderWidth,
  colors,
  fontFamily,
  fontWeight,
  motion,
  radius,
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
      separator: '#ECEDEF',
      subtleFill: '#F6F7F8',
      live: '#E6463E',
      earthAccent: '#2459D3',
      danger: '#FF3B30',
      success: '#34C759',
    })
    expect(COLOR_NAMES).toHaveLength(10)
    for (const name of COLOR_NAMES) expect(colors[name]).toMatch(/^#[0-9A-F]{6}$/)
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
    expect(typography.display).toMatchObject({ size: 32, weight: fontWeight.semibold })
    expect(typography.title).toMatchObject({ size: 24, weight: fontWeight.semibold })
    expect(typography.section).toMatchObject({ size: 18, weight: fontWeight.semibold })
    expect(typography.body).toMatchObject({ size: 16, weight: fontWeight.regular })
    expect(typography.secondary).toMatchObject({ size: 14, weight: fontWeight.regular })
    expect(typography.meta).toMatchObject({ size: 12, weight: fontWeight.medium })
    expect(fontWeight).toEqual({ regular: 400, medium: 500, semibold: 600 })
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

  it('is system typography first, nothing decorative', () => {
    expect(fontFamily.system.startsWith('-apple-system')).toBe(true)
    expect(fontFamily.system).toContain('system-ui')
    expect(fontFamily.system.endsWith('sans-serif')).toBe(true)
    expect(fontFamily.system).not.toMatch(/serif,|cursive|fantasy|monospace/)
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
    expect(radius).toEqual({ small: 8, medium: 12, avatar: 999 })
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
