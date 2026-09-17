/**
 * Web consumption of the design tokens (ARCHITECTURE §13).
 *
 * - `tokensToCssVariables()` renders every token as a `--earth-*` custom property on `:root`.
 * - `cssVar(name)` references one of those variables with compile-time checked names.
 * - `tailwindTheme` / `tailwindThemeCss()` expose the tokens in the shapes Tailwind 4 expects.
 *   `@theme` only turns variables in Tailwind's own namespaces into utilities: `--color-*`,
 *   `--font-*`, `--font-weight-*`, `--text-*`, `--spacing-*`, `--radius-*`, `--border-width-*`,
 *   `--transition-duration-*` (not `--duration-*`), `--ease-*`, `--z-index-*`.
 */
import {
  avatarSize,
  borderWidth,
  colors,
  fontFamily,
  fontWeight,
  iconSize,
  motion,
  radius,
  shadow,
  space,
  spacing,
  touchTarget,
  typography,
  zIndex,
  type AvatarSizeName,
  type BorderWidthName,
  type ColorName,
  type ColorValue,
  type DurationName,
  type EasingName,
  type FontFamilyName,
  type FontWeightName,
  type IconSizeName,
  type RadiusName,
  type ShadowName,
  type SpaceStep,
  type SpacingName,
  type TypeStyle,
  type TypographyName,
  type ZIndexName,
} from './tokens'

export const CSS_VAR_PREFIX = 'earth' as const

/** `textPrimary` → `text-primary` (type level). */
export type KebabCase<S extends string> = S extends `${infer Head}${infer Tail}`
  ? Tail extends Uncapitalize<Tail>
    ? `${Lowercase<Head>}${KebabCase<Tail>}`
    : `${Lowercase<Head>}-${KebabCase<Tail>}`
  : S

/** `textPrimary` → `text-primary` (runtime twin of `KebabCase`). */
export function kebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

export type CssVariableName =
  | `color-${KebabCase<ColorName>}`
  | `font-family-${FontFamilyName}`
  | `font-weight-${FontWeightName}`
  | `font-size-${TypographyName}`
  | `font-weight-${TypographyName}`
  | `line-height-${TypographyName}`
  | `letter-spacing-${TypographyName}`
  | `font-family-of-${TypographyName}`
  | `space-${SpaceStep}`
  | `space-${KebabCase<SpacingName>}`
  | `radius-${RadiusName}`
  | `shadow-${ShadowName}`
  | `duration-${DurationName}`
  | `easing-${EasingName}`
  | `border-${BorderWidthName}`
  | `z-${ZIndexName}`
  | 'touch-target'
  | `icon-${IconSizeName}`
  | `avatar-${AvatarSizeName}`

export type CssVariableEntry = readonly [name: CssVariableName, value: string]

const px = (n: number): string => `${n}px`
const ms = (n: number): string => `${n}ms`
const em = (n: number): string => `${n}em`

/** `#RRGGBB` + alpha → `rgba(r, g, b, a)`; shadows are the ink at a low opacity. */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace(/^#/, '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** The one `box-shadow` value of a shadow token. */
export function shadowCss(name: ShadowName): string {
  const { y, blur, opacity } = shadow[name]
  return `0 ${px(y)} ${px(blur)} ${hexToRgba(colors.textPrimary, opacity)}`
}

function entriesOf<K extends string, V>(
  record: Readonly<Record<K, V>>,
): ReadonlyArray<readonly [K, V]> {
  return Object.entries(record) as unknown as ReadonlyArray<readonly [K, V]>
}

/**
 * Every token as a `[name, value]` pair, in a stable order (colors first). Values carry their
 * CSS unit (`px`, `ms`) except font weights and z-index, which are unitless.
 */
export function cssVariableEntries(): ReadonlyArray<CssVariableEntry> {
  const out: CssVariableEntry[] = []
  for (const [name, value] of entriesOf(colors)) {
    out.push([`color-${kebabCase(name) as KebabCase<ColorName>}`, value])
  }
  for (const [name, value] of entriesOf(fontFamily)) {
    out.push([`font-family-${name}`, value])
  }
  for (const [name, value] of entriesOf(fontWeight)) {
    out.push([`font-weight-${name}`, String(value)])
  }
  for (const [name, style] of entriesOf<TypographyName, TypeStyle>(typography)) {
    out.push([`font-size-${name}`, px(style.size)])
    out.push([`font-weight-${name}`, String(style.weight)])
    out.push([`line-height-${name}`, px(style.lineHeight)])
    out.push([`font-family-of-${name}`, fontFamily[style.family]])
    if (style.letterSpacing !== undefined) {
      out.push([`letter-spacing-${name}`, em(style.letterSpacing)])
    }
  }
  for (const [step, value] of Object.entries(space)) {
    out.push([`space-${step as `${SpaceStep}`}`, px(value)])
  }
  for (const [name, value] of entriesOf(spacing)) {
    out.push([`space-${kebabCase(name) as KebabCase<SpacingName>}`, px(value)])
  }
  for (const [name, value] of entriesOf(radius)) {
    out.push([`radius-${name}`, px(value)])
  }
  for (const name of Object.keys(shadow) as ShadowName[]) {
    out.push([`shadow-${name}`, shadowCss(name)])
  }
  for (const [name, value] of entriesOf(motion.duration)) {
    out.push([`duration-${name}`, ms(value)])
  }
  for (const [name, value] of entriesOf(motion.easing)) {
    out.push([`easing-${name}`, value])
  }
  for (const [name, value] of entriesOf(borderWidth)) {
    out.push([`border-${name}`, px(value)])
  }
  for (const [name, value] of entriesOf(zIndex)) {
    out.push([`z-${name}`, String(value)])
  }
  out.push(['touch-target', px(touchTarget)])
  for (const [name, value] of entriesOf(iconSize)) {
    out.push([`icon-${name}`, px(value)])
  }
  for (const [name, value] of entriesOf(avatarSize)) {
    out.push([`avatar-${name}`, px(value)])
  }
  return out
}

/** `--earth-color-background` */
export function cssVarName(name: CssVariableName): `--${typeof CSS_VAR_PREFIX}-${CssVariableName}` {
  return `--${CSS_VAR_PREFIX}-${name}`
}

/** `var(--earth-color-background)` — optionally with a fallback value. */
export function cssVar(name: CssVariableName, fallback?: string): string {
  return fallback === undefined
    ? `var(${cssVarName(name)})`
    : `var(${cssVarName(name)}, ${fallback})`
}

/**
 * `:root{--earth-color-background:#FFFFFF;--earth-color-surface:#FFFFFF;...}` — a single
 * minified rule suitable for a global stylesheet or an inline `<style>` in the root layout.
 */
export function tokensToCssVariables(): string {
  const body = cssVariableEntries()
    .map(([name, value]) => `${cssVarName(name)}:${value}`)
    .join(';')
  return `:root{${body}}`
}

// ---------------------------------------------------------------------------
// Tailwind 4
// ---------------------------------------------------------------------------

export type TailwindFontSize = readonly [
  size: string,
  options: {
    readonly lineHeight: string
    readonly fontWeight: string
    readonly letterSpacing?: string
  },
]

type KebabKeys<T extends Record<string, unknown>, V> = {
  readonly [K in keyof T & string as KebabCase<K>]: V
}

function kebabRecord<T extends Record<string, unknown>, V>(
  record: T,
  map: (value: T[keyof T & string]) => V,
): KebabKeys<T, V> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      kebabCase(key),
      map(value as T[keyof T & string]),
    ]),
  ) as KebabKeys<T, V>
}

/**
 * Token → Tailwind theme mapping (also valid as a legacy `@config` theme). Keys are kebab-cased so
 * utilities read naturally: `bg-background`, `text-text-secondary`, `text-body`,
 * `p-screen-margin`, `rounded-medium`, `border-hairline`, `duration-fast`, `ease-standard`,
 * `z-modal`. Use `tailwindThemeCss()` to emit the `@theme` block.
 */
export const tailwindTheme = {
  colors: kebabRecord(colors, (value): ColorValue => value),
  fontFamily: kebabRecord(fontFamily, (value) => value),
  fontWeight: kebabRecord(fontWeight, (value) => String(value)),
  fontSize: kebabRecord(typography, (style: TypeStyle): TailwindFontSize => [
    px(style.size),
    style.letterSpacing === undefined
      ? { lineHeight: px(style.lineHeight), fontWeight: String(style.weight) }
      : {
          lineHeight: px(style.lineHeight),
          fontWeight: String(style.weight),
          letterSpacing: em(style.letterSpacing),
        },
  ]),
  spacing: {
    ...(Object.fromEntries(Object.entries(space).map(([k, v]) => [k, px(v)])) as {
      readonly [K in SpaceStep as `${K}`]: string
    }),
    ...kebabRecord(spacing, px),
    'touch-target': px(touchTarget),
  },
  borderRadius: kebabRecord(radius, px),
  boxShadow: Object.fromEntries(
    (Object.keys(shadow) as ShadowName[]).map((name) => [name, shadowCss(name)]),
  ) as Record<ShadowName, string>,
  borderWidth: kebabRecord(borderWidth, px),
  transitionDuration: kebabRecord(motion.duration, ms),
  transitionTimingFunction: kebabRecord(motion.easing, (value) => value),
  zIndex: kebabRecord(zIndex, (value) => String(value)),
} as const

export type TailwindTheme = typeof tailwindTheme

/** The Tailwind 4 `@theme` namespaces `tailwindThemeCss()` writes into — every emitted variable
 * starts with one of these, so every token becomes a utility (verified in tests). */
export const TAILWIND_THEME_NAMESPACES = [
  'color',
  'font',
  'font-weight',
  'text',
  'spacing',
  'radius',
  'shadow',
  'border-width',
  'transition-duration',
  'ease',
  'z-index',
] as const

/**
 * Renders `tailwindTheme` as a Tailwind 4 `@theme { ... }` block using the framework's variable
 * namespaces. Write the output to a `.css` file that `globals.css` imports after `tailwindcss`.
 */
export function tailwindThemeCss(): string {
  const lines: string[] = []
  const add = (name: string, value: string): void => {
    lines.push(`  --${name}: ${value};`)
  }
  for (const [name, value] of Object.entries(tailwindTheme.colors)) add(`color-${name}`, value)
  for (const [name, value] of Object.entries(tailwindTheme.fontFamily)) add(`font-${name}`, value)
  for (const [name, value] of Object.entries(tailwindTheme.fontWeight)) {
    add(`font-weight-${name}`, value)
  }
  for (const [name, [size, options]] of Object.entries(tailwindTheme.fontSize)) {
    add(`text-${name}`, size)
    add(`text-${name}--line-height`, options.lineHeight)
    add(`text-${name}--font-weight`, options.fontWeight)
    if (options.letterSpacing !== undefined) {
      add(`text-${name}--letter-spacing`, options.letterSpacing)
    }
  }
  for (const [name, value] of Object.entries(tailwindTheme.spacing)) add(`spacing-${name}`, value)
  for (const [name, value] of Object.entries(tailwindTheme.borderRadius)) {
    add(`radius-${name}`, value)
  }
  for (const [name, value] of Object.entries(tailwindTheme.boxShadow)) add(`shadow-${name}`, value)
  for (const [name, value] of Object.entries(tailwindTheme.borderWidth)) {
    add(`border-width-${name}`, value)
  }
  for (const [name, value] of Object.entries(tailwindTheme.transitionDuration)) {
    // Tailwind resolves `duration-*` from `--transition-duration-*`; `--duration-*` is inert.
    add(`transition-duration-${name}`, value)
  }
  for (const [name, value] of Object.entries(tailwindTheme.transitionTimingFunction)) {
    add(`ease-${name}`, value)
  }
  for (const [name, value] of Object.entries(tailwindTheme.zIndex)) add(`z-index-${name}`, value)
  return `@theme {\n${lines.join('\n')}\n}\n`
}
