/**
 * The exact text of `app/theme.css` (see `generate.ts`). Pure so the test can compare the
 * committed file with a fresh render. The output is written the way Prettier formats CSS
 * (expanded blocks, lower-case hex) so `pnpm format:check` and the generator agree.
 */
import { cssVarName, cssVariableEntries, tailwindThemeCss } from '@earth/ui'

export const THEME_CSS_HEADER = `/* GENERATED from @earth/ui tokens by lib/theme/generate.ts — do not edit by hand. */`

/**
 * Tailwind's own palette, type scale and font families are reset so only the spec's tokens
 * (PART XV) produce utilities: `bg-background`, `text-text-secondary`, `text-body`, ... The
 * default spacing multiplier is kept — Tailwind's `0.25rem` step is exactly the 4pt half-step
 * of the 8-point baseline (§91), so `p-4` is 16px and the named `spacing-*` tokens agree.
 */
export const TAILWIND_RESET_THEME = `@theme {
  --color-*: initial;
  --font-*: initial;
  --text-*: initial;
}`

/** Prettier prints hex colors in lower case. */
export function lowercaseHex(css: string): string {
  return css.replace(/#([0-9A-Fa-f]{3,8})\b/g, (match) => match.toLowerCase())
}

/** `:root { --earth-...: ...; }` — the same variables as `tokensToCssVariables()`, one per line. */
export function rootVariablesCss(): string {
  const lines = cssVariableEntries().map(([name, value]) => `  ${cssVarName(name)}: ${value};`)
  return `:root {\n${lines.join('\n')}\n}`
}

export function renderThemeCss(): string {
  return lowercaseHex(
    [THEME_CSS_HEADER, TAILWIND_RESET_THEME, tailwindThemeCss().trim(), rootVariablesCss()]
      .join('\n\n')
      .concat('\n'),
  )
}
