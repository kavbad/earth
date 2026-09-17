import { describe, expect, it } from 'vitest'

import {
  TAILWIND_THEME_NAMESPACES,
  cssVar,
  cssVarName,
  cssVariableEntries,
  hexToRgba,
  kebabCase,
  shadowCss,
  tailwindTheme,
  tailwindThemeCss,
  tokensToCssVariables,
} from './css'
import {
  COLOR_NAMES,
  TYPOGRAPHY_NAMES,
  colors,
  fontFamily,
  motion,
  radius,
  space,
  spacing,
  typography,
} from './tokens'

describe('tokensToCssVariables', () => {
  const css = tokensToCssVariables()

  it('is a single :root rule', () => {
    expect(css.startsWith(':root{')).toBe(true)
    expect(css.endsWith('}')).toBe(true)
    expect(css).not.toContain('\n')
  })

  it('includes every color with its exact value', () => {
    for (const name of COLOR_NAMES) {
      expect(css).toContain(`--earth-color-${kebabCase(name)}:${colors[name]}`)
    }
    expect(css).toContain('--earth-color-background:#FFFFFF')
    expect(css).toContain('--earth-color-text-primary:#111214')
    expect(css).toContain('--earth-color-text-secondary:#72757A')
    expect(css).toContain('--earth-color-separator:#ECEDEF')
    expect(css).toContain('--earth-color-subtle-fill:#F6F7F8')
    expect(css).toContain('--earth-color-live:#E6463E')
    expect(css).toContain('--earth-color-text-tertiary:#A2A5AA')
    expect(css).toContain('--earth-color-earth-accent:#2F6B4C')
    expect(css).toContain('--earth-color-danger:#FF3B30')
    expect(css).toContain('--earth-color-success:#34C759')
  })

  it('includes typography, spacing, radii and motion with units', () => {
    for (const name of TYPOGRAPHY_NAMES) {
      expect(css).toContain(`--earth-font-size-${name}:${typography[name].size}px`)
      expect(css).toContain(`--earth-font-weight-${name}:${typography[name].weight}`)
      expect(css).toContain(`--earth-line-height-${name}:${typography[name].lineHeight}px`)
      expect(css).toContain(`--earth-font-family-of-${name}:${fontFamily[typography[name].family]}`)
    }
    expect(css).toContain("--earth-font-family-serif:'Newsreader Variable'")
    expect(css).toContain("--earth-font-family-sans:'Instrument Sans Variable'")
    expect(css).toContain('--earth-letter-spacing-display:-0.01em')
    expect(css).toContain('--earth-letter-spacing-meta:0.01em')
    expect(css).not.toContain('--earth-letter-spacing-body')
    expect(css).toContain(`--earth-radius-large:${radius.large}px`)
    expect(css).toContain('--earth-shadow-sheet:0 12px 32px rgba(17, 18, 20, 0.12)')
    expect(css).toContain(`--earth-space-1:${space[1]}px`)
    expect(css).toContain(`--earth-space-screen-margin:${spacing.screenMargin}px`)
    expect(css).toContain(`--earth-space-feed-gap:${spacing.feedGap}px`)
    expect(css).toContain(`--earth-space-feed-gap-min:${spacing.feedGapMin}px`)
    expect(css).toContain(`--earth-space-row-gap:${spacing.rowGap}px`)
    expect(css).toContain(`--earth-radius-small:${radius.small}px`)
    expect(css).toContain('--earth-radius-avatar:999px')
    expect(css).toContain(`--earth-duration-fast:${motion.duration.fast}ms`)
    expect(css).toContain(`--earth-easing-standard:${motion.easing.standard}`)
    expect(css).toContain('--earth-border-hairline:0.5px')
    expect(css).toContain('--earth-z-modal:300')
    expect(css).toContain('--earth-touch-target:44px')
  })

  it('has unique, well-formed variable names in a stable order', () => {
    const names = cssVariableEntries().map(([name]) => name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    expect(names[0]).toBe('color-background')
    expect(cssVariableEntries().map(([name]) => name)).toEqual(names)
  })
})

describe('cssVar', () => {
  it('references the prefixed variable', () => {
    expect(cssVarName('color-background')).toBe('--earth-color-background')
    expect(cssVar('color-background')).toBe('var(--earth-color-background)')
    expect(cssVar('space-4', '16px')).toBe('var(--earth-space-4, 16px)')
  })
})

describe('hexToRgba / shadowCss', () => {
  it('renders the ink at a low opacity', () => {
    expect(hexToRgba('#111214', 0.12)).toBe('rgba(17, 18, 20, 0.12)')
    expect(hexToRgba('FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)')
    expect(shadowCss('sheet')).toBe(`0 12px 32px ${hexToRgba(colors.textPrimary, 0.12)}`)
  })
})

describe('kebabCase', () => {
  it('converts camelCase', () => {
    expect(kebabCase('textPrimary')).toBe('text-primary')
    expect(kebabCase('earthAccent')).toBe('earth-accent')
    expect(kebabCase('feedGapMin')).toBe('feed-gap-min')
    expect(kebabCase('live')).toBe('live')
    expect(kebabCase('space1')).toBe('space1')
  })
})

describe('tailwindTheme', () => {
  it('maps colors, font sizes and spacing', () => {
    expect(tailwindTheme.colors).toEqual({
      background: '#FFFFFF',
      surface: '#FFFFFF',
      'text-primary': '#111214',
      'text-secondary': '#72757A',
      'text-tertiary': '#A2A5AA',
      separator: '#ECEDEF',
      'subtle-fill': '#F6F7F8',
      live: '#E6463E',
      'earth-accent': '#2F6B4C',
      danger: '#FF3B30',
      success: '#34C759',
    })
    expect(tailwindTheme.fontSize.body).toEqual(['16px', { lineHeight: '24px', fontWeight: '400' }])
    expect(tailwindTheme.fontSize.display[1].fontWeight).toBe('500')
    expect(tailwindTheme.fontSize.display[1].letterSpacing).toBe('-0.01em')
    expect(tailwindTheme.fontSize.body[1].letterSpacing).toBeUndefined()
    expect(tailwindTheme.fontFamily.serif.startsWith("'Newsreader Variable'")).toBe(true)
    expect(tailwindTheme.boxShadow.sheet).toBe(shadowCss('sheet'))
    expect(tailwindTheme.spacing['4']).toBe('16px')
    expect(tailwindTheme.spacing['screen-margin']).toBe('16px')
    expect(tailwindTheme.spacing['feed-gap']).toBe('24px')
    expect(tailwindTheme.spacing['row-gap']).toBe('8px')
    expect(tailwindTheme.borderRadius.avatar).toBe('999px')
    expect(tailwindTheme.borderWidth.hairline).toBe('0.5px')
    expect(tailwindTheme.transitionDuration.base).toBe('240ms')
    expect(tailwindTheme.zIndex.modal).toBe('300')
  })

  it('renders a Tailwind 4 @theme block', () => {
    const css = tailwindThemeCss()
    expect(css.startsWith('@theme {\n')).toBe(true)
    expect(css).toContain('  --color-background: #FFFFFF;')
    expect(css).toContain('  --color-text-primary: #111214;')
    expect(css).toContain("  --font-serif: 'Newsreader Variable'")
    expect(css).toContain("  --font-sans: 'Instrument Sans Variable'")
    expect(css).not.toContain('--font-system')
    expect(css).toContain('  --font-weight-semibold: 600;')
    expect(css).toContain('  --text-body: 16px;')
    expect(css).toContain('  --text-body--line-height: 24px;')
    expect(css).toContain('  --text-body--font-weight: 400;')
    expect(css).toContain('  --spacing-screen-margin: 16px;')
    expect(css).toContain('  --radius-medium: 10px;')
    expect(css).toContain('  --radius-large: 16px;')
    expect(css).toContain('  --text-display--letter-spacing: -0.01em;')
    expect(css).toContain('  --shadow-sheet: 0 12px 32px rgba(17, 18, 20, 0.12);')
    expect(css).toContain('  --border-width-hairline: 0.5px;')
    expect(css).toContain('  --ease-standard: cubic-bezier(0.2, 0, 0, 1);')
    expect(css).toContain('  --z-index-modal: 300;')
    expect(css.trimEnd().endsWith('}')).toBe(true)
  })

  it('emits durations under the namespace Tailwind resolves `duration-*` from', () => {
    const css = tailwindThemeCss()
    expect(css).toContain('  --transition-duration-fast: 180ms;')
    expect(css).toContain('  --transition-duration-slow: 300ms;')
    // `--duration-*` is not a Tailwind 4 namespace; it would silently produce no utility.
    expect(css).not.toMatch(/^\s+--duration-/m)
  })

  it('only writes variables in namespaces Tailwind 4 turns into utilities', () => {
    const lines = tailwindThemeCss()
      .split('\n')
      .filter((line) => line.startsWith('  --'))
    expect(lines.length).toBeGreaterThan(30)
    for (const line of lines) {
      const match = /^ {2}--([a-z0-9-]+): .+;$/.exec(line)
      expect(match, line).not.toBeNull()
      const name = match?.[1] ?? ''
      expect(
        TAILWIND_THEME_NAMESPACES.some((ns) => name.startsWith(`${ns}-`)),
        `${name} is outside Tailwind's @theme namespaces`,
      ).toBe(true)
    }
  })
})
