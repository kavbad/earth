/**
 * Icon path data for both clients. Every icon is a 24×24 stroke outline at 1.75 width with round
 * caps/joins; `fill` parts (used sparingly) are painted with the current color instead.
 *
 * Spec §50: the central Live icon represents a destination/state — a small filled point inside a
 * ring — and must not look like a create (plus) button.
 */

import type { Tab } from './copy'

export const ICON_VIEWBOX = '0 0 24 24' as const
export const ICON_STROKE_WIDTH = 1.75 as const
export const ICON_LINECAP = 'round' as const
export const ICON_LINEJOIN = 'round' as const

export type IconPathKind = 'stroke' | 'fill'

export interface IconPath {
  /** SVG path `d` attribute. */
  readonly d: string
  readonly kind: IconPathKind
}

export interface IconDefinition {
  readonly viewBox: typeof ICON_VIEWBOX
  readonly strokeWidth: typeof ICON_STROKE_WIDTH
  readonly paths: readonly IconPath[]
}

const stroke = (d: string): IconPath => ({ d, kind: 'stroke' })
const fill = (d: string): IconPath => ({ d, kind: 'fill' })
const icon = (...paths: IconPath[]): IconDefinition => ({
  viewBox: ICON_VIEWBOX,
  strokeWidth: ICON_STROKE_WIDTH,
  paths,
})

/** Circle path centered at (cx, cy) with radius r — two arcs, closed. */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${r * 2}a${r} ${r} 0 0 0 0 -${r * 2}z`

const SLASH = 'M4 4l16 16'

export const icons = {
  /** Tab: Home. */
  home: icon(stroke('M4 10.5L12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z')),
  /** Tab: Chats. */
  chats: icon(
    stroke(
      'M4.5 6.5A2.5 2.5 0 0 1 7 4h10a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 17 16h-6l-4.5 3.5V16H7a2.5 2.5 0 0 1-2.5-2.5z',
    ),
  ),
  /** Tab: Live — a ring with a filled point inside. Deliberately not a plus. */
  live: icon(stroke(circle(12, 12, 8.5)), fill(circle(12, 12, 3.5))),
  /** Tab: Earth — globe. */
  earth: icon(
    stroke(circle(12, 12, 9)),
    stroke('M3 12h18'),
    stroke('M12 3a4.2 9 0 1 0 0 18a4.2 9 0 0 0 0-18z'),
  ),
  /** Tab: You. */
  you: icon(stroke(circle(12, 8, 4)), stroke('M4.5 20.5c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6')),
  /** Composer / new chat. */
  plus: icon(stroke('M12 5v14'), stroke('M5 12h14')),
  mic: icon(
    stroke('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z'),
    stroke('M5.5 11.5a6.5 6.5 0 0 0 13 0'),
    stroke('M12 18v3'),
    stroke('M9 21h6'),
  ),
  micOff: icon(
    stroke('M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z'),
    stroke('M5.5 11.5a6.5 6.5 0 0 0 13 0'),
    stroke('M12 18v3'),
    stroke('M9 21h6'),
    stroke(SLASH),
  ),
  camera: icon(
    stroke(
      'M3.5 8A1.5 1.5 0 0 1 5 6.5h9A1.5 1.5 0 0 1 15.5 8v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16z',
    ),
    stroke('M15.5 10.5l5-2.5v8l-5-2.5'),
  ),
  cameraOff: icon(
    stroke(
      'M3.5 8A1.5 1.5 0 0 1 5 6.5h9A1.5 1.5 0 0 1 15.5 8v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 16z',
    ),
    stroke('M15.5 10.5l5-2.5v8l-5-2.5'),
    stroke(SLASH),
  ),
  /** Flip camera — two rotating arrows. */
  flip: icon(
    stroke('M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9'),
    stroke('M19.5 4.5V9H15'),
    stroke('M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15'),
    stroke('M4.5 19.5V15H9'),
  ),
  participants: icon(
    stroke(circle(9, 8, 3.5)),
    stroke('M2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5'),
    stroke('M16 4.7a3.5 3.5 0 0 1 0 6.6'),
    stroke('M17.5 14.7c2.4.6 4 2.5 4 5.3'),
  ),
  /** Three dots. */
  more: icon(fill(circle(5, 12, 1.75)), fill(circle(12, 12, 1.75)), fill(circle(19, 12, 1.75))),
  /** Leave — arrow out of a door. */
  leave: icon(
    stroke('M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14'),
    stroke('M9 8l-4 4 4 4'),
    stroke('M5 12h10'),
  ),
  search: icon(stroke(circle(10.5, 10.5, 6.5)), stroke('M15.5 15.5L20 20')),
  back: icon(stroke('M15 5l-7 7 7 7')),
  close: icon(stroke('M6 6l12 12'), stroke('M18 6L6 18')),
  send: icon(stroke('M20.5 3.5L3.5 10.5l7.5 2.5 2.5 7.5z'), stroke('M11 13l9.5-9.5')),
  chevron: icon(stroke('M9 5l7 7-7 7')),
  share: icon(
    stroke('M12 3v12'),
    stroke('M8 7l4-4 4 4'),
    stroke('M6 11.5H5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7.5a1 1 0 0 0-1-1h-1'),
  ),
  block: icon(stroke(circle(12, 12, 9)), stroke('M5.6 5.6l12.8 12.8')),
  /** Report — flag. */
  report: icon(stroke('M5 21V4'), stroke('M5 4h12l-2.5 4 2.5 4H5')),
  location: icon(
    stroke('M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z'),
    stroke(circle(12, 10, 2.5)),
  ),
  check: icon(stroke('M5 12.5l4.5 4.5L19 7')),
} as const satisfies Record<string, IconDefinition>

export type IconName = keyof typeof icons
export const ICON_NAMES = Object.keys(icons) as readonly IconName[]

/** Bottom navigation icon per tab (spec §50). */
export const TAB_ICONS = {
  home: 'home',
  chats: 'chats',
  live: 'live',
  earth: 'earth',
  you: 'you',
} as const satisfies Record<Tab, IconName>

export interface IconSvgOptions {
  /** Rendered width/height in px. Defaults to 24. */
  readonly size?: number
  /** Any CSS color; defaults to `currentColor`. */
  readonly color?: string
  /** Accessible name; when omitted the SVG is `aria-hidden`. */
  readonly title?: string
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Renders an icon as an inline SVG string (web, tests, email). */
export function iconToSvg(name: IconName, options: IconSvgOptions = {}): string {
  const def = icons[name]
  const size = options.size ?? 24
  const color = options.color ?? 'currentColor'
  const label =
    options.title === undefined
      ? 'aria-hidden="true"'
      : `role="img" aria-label="${escapeXml(options.title)}"`
  const paths = def.paths
    .map((path) =>
      path.kind === 'fill'
        ? `<path d="${path.d}" fill="${escapeXml(color)}" stroke="none"/>`
        : `<path d="${path.d}" fill="none" stroke="${escapeXml(color)}" stroke-width="${def.strokeWidth}" stroke-linecap="${ICON_LINECAP}" stroke-linejoin="${ICON_LINEJOIN}"/>`,
    )
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${def.viewBox}" width="${size}" height="${size}" ${label}>${paths}</svg>`
}
