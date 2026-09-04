/**
 * Renders the design tokens of `@earth/ui` (ARCHITECTURE §13) into `app/theme.css`:
 * the `:root { --earth-* }` custom properties from `tokensToCssVariables()` and the Tailwind 4
 * `@theme { ... }` block from `tailwindThemeCss()`. CSS cannot call TypeScript, so the file is
 * generated and committed; `theme.test.ts` fails when it drifts from the tokens.
 *
 * Run from the repository root: `pnpm exec tsx apps/web/lib/theme/generate.ts`
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderThemeCss } from './render'

const here = dirname(fileURLToPath(import.meta.url))
export const THEME_CSS_PATH = join(here, '..', '..', 'app', 'theme.css')

writeFileSync(THEME_CSS_PATH, renderThemeCss())
console.log(`wrote ${THEME_CSS_PATH}`)
