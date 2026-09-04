import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { colors, typography } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { lowercaseHex, renderThemeCss } from './render'

const here = dirname(fileURLToPath(import.meta.url))
const committed = readFileSync(join(here, '..', '..', 'app', 'theme.css'), 'utf8')

describe('app/theme.css', () => {
  it('is exactly what the @earth/ui tokens render (run lib/theme/generate.ts after a token change)', () => {
    expect(committed).toBe(renderThemeCss())
  })

  it('carries the spec palette as Tailwind colors and root variables', () => {
    expect(committed).toContain(`--color-background: ${lowercaseHex(colors.background)};`)
    expect(committed).toContain(`--color-text-primary: ${lowercaseHex(colors.textPrimary)};`)
    expect(committed).toContain(`--color-live: ${lowercaseHex(colors.live)};`)
    expect(committed).toContain(`--earth-color-earth-accent: ${lowercaseHex(colors.earthAccent)};`)
  })

  it('exposes the type scale with line height and weight', () => {
    expect(committed).toContain(`--text-body: ${typography.body.size}px;`)
    expect(committed).toContain(`--text-body--line-height: ${typography.body.lineHeight}px;`)
    expect(committed).toContain(`--text-meta--font-weight: ${typography.meta.weight};`)
  })

  it('resets the Tailwind palette and type scale so only tokens produce utilities', () => {
    expect(committed).toContain('--color-*: initial;')
    expect(committed).toContain('--text-*: initial;')
  })
})
