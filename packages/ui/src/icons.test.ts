import { describe, expect, it } from 'vitest'

import { TABS } from './copy'
import {
  ICON_LINECAP,
  ICON_LINEJOIN,
  ICON_NAMES,
  ICON_STROKE_WIDTH,
  ICON_VIEWBOX,
  TAB_ICONS,
  iconToSvg,
  icons,
} from './icons'

const REQUIRED = [
  'home',
  'chats',
  'live',
  'earth',
  'you',
  'plus',
  'mic',
  'micOff',
  'camera',
  'cameraOff',
  'flip',
  'participants',
  'more',
  'leave',
  'search',
  'back',
  'close',
  'send',
  'chevron',
  'share',
  'block',
  'report',
  'location',
  'check',
] as const

// ---------------------------------------------------------------------------
// A small SVG path-data interpreter: validates grammar (command arity, arc flags/radii) and
// traces every point (end points and control points) so bounds are checked in absolute space.
// ---------------------------------------------------------------------------

const ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
}

interface Point {
  readonly x: number
  readonly y: number
}

interface Trace {
  readonly points: Point[]
  readonly commands: string[]
}

function tokenize(d: string): Array<string | number> {
  const tokenRe = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+))/g
  const leftovers = d.replace(tokenRe, '').replace(/[\s,]/g, '')
  if (leftovers.length > 0) throw new Error(`unexpected "${leftovers}" in "${d}"`)
  const tokens: Array<string | number> = []
  for (const match of d.matchAll(tokenRe)) {
    tokens.push(match[1] !== undefined ? match[1] : Number(match[2]))
  }
  return tokens
}

function tracePath(d: string): Trace {
  const tokens = tokenize(d)
  if (tokens[0] !== 'M' && tokens[0] !== 'm') throw new Error(`"${d}" must start with a moveto`)
  const points: Point[] = []
  const commands: string[] = []
  let cur: Point = { x: 0, y: 0 }
  let start: Point = cur
  let index = 0
  while (index < tokens.length) {
    const command = tokens[index]
    if (typeof command !== 'string')
      throw new Error(`number where a command was expected in "${d}"`)
    index += 1
    const args: number[] = []
    while (index < tokens.length && typeof tokens[index] === 'number') {
      args.push(tokens[index] as number)
      index += 1
    }
    const upper = command.toUpperCase()
    const relative = command !== upper
    const arity = ARITY[upper]
    if (arity === undefined) throw new Error(`unknown command ${command} in "${d}"`)
    if (arity === 0 && args.length !== 0) throw new Error(`Z takes no arguments in "${d}"`)
    if (arity > 0 && (args.length === 0 || args.length % arity !== 0)) {
      throw new Error(
        `${command} expects multiples of ${arity} numbers, got ${args.length} in "${d}"`,
      )
    }
    commands.push(command)
    if (arity === 0) {
      // Z draws the closing segment back to the subpath start.
      cur = start
      points.push(cur)
      continue
    }
    for (let offset = 0; offset < args.length; offset += arity) {
      const chunk = args.slice(offset, offset + arity)
      const abs = (dx: number, dy: number): Point =>
        relative ? { x: cur.x + dx, y: cur.y + dy } : { x: dx, y: dy }
      switch (upper) {
        case 'M': {
          cur = abs(chunk[0] ?? 0, chunk[1] ?? 0)
          if (offset === 0) start = cur
          break
        }
        case 'L':
        case 'T':
          cur = abs(chunk[0] ?? 0, chunk[1] ?? 0)
          break
        case 'H':
          cur = relative ? { x: cur.x + (chunk[0] ?? 0), y: cur.y } : { x: chunk[0] ?? 0, y: cur.y }
          break
        case 'V':
          cur = relative ? { x: cur.x, y: cur.y + (chunk[0] ?? 0) } : { x: cur.x, y: chunk[0] ?? 0 }
          break
        case 'C':
          points.push(abs(chunk[0] ?? 0, chunk[1] ?? 0), abs(chunk[2] ?? 0, chunk[3] ?? 0))
          cur = abs(chunk[4] ?? 0, chunk[5] ?? 0)
          break
        case 'S':
        case 'Q':
          points.push(abs(chunk[0] ?? 0, chunk[1] ?? 0))
          cur = abs(chunk[2] ?? 0, chunk[3] ?? 0)
          break
        case 'A': {
          const [rx, ry, , largeArc, sweep, x, y] = chunk
          if (!(rx !== undefined && rx > 0 && ry !== undefined && ry > 0)) {
            throw new Error(`arc radii must be positive in "${d}"`)
          }
          if (![0, 1].includes(largeArc ?? -1) || ![0, 1].includes(sweep ?? -1)) {
            throw new Error(`arc flags must be 0 or 1 in "${d}"`)
          }
          cur = abs(x ?? 0, y ?? 0)
          break
        }
        default:
          throw new Error(`unhandled ${command}`)
      }
      points.push(cur)
    }
  }
  return { points, commands }
}

describe('icons', () => {
  it('defines every required icon on a 24×24 grid at 1.75 stroke', () => {
    expect(ICON_VIEWBOX).toBe('0 0 24 24')
    expect(ICON_STROKE_WIDTH).toBe(1.75)
    expect(ICON_LINECAP).toBe('round')
    expect(ICON_LINEJOIN).toBe('round')
    for (const name of REQUIRED) {
      const def = icons[name]
      expect(def.viewBox).toBe(ICON_VIEWBOX)
      expect(def.strokeWidth).toBe(ICON_STROKE_WIDTH)
      expect(def.paths.length).toBeGreaterThan(0)
      for (const path of def.paths) expect(['stroke', 'fill']).toContain(path.kind)
    }
    expect(ICON_NAMES).toEqual(expect.arrayContaining([...REQUIRED]))
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length)
  })

  it('every path is grammatically valid SVG path data', () => {
    for (const name of ICON_NAMES) {
      for (const path of icons[name].paths) {
        expect(() => tracePath(path.d), `${name}: ${path.d}`).not.toThrow()
        expect(path.d, `${name}: ${path.d}`).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/)
        expect(path.d).not.toMatch(/\s{2}|,\s|\s,|\s$/)
      }
    }
  })

  it('every traced point stays inside the viewBox', () => {
    const EPSILON = 1e-9
    for (const name of ICON_NAMES) {
      for (const path of icons[name].paths) {
        const { points } = tracePath(path.d)
        expect(points.length, `${name}: ${path.d}`).toBeGreaterThan(0)
        for (const point of points) {
          expect(point.x, `${name}: ${path.d} → x`).toBeGreaterThanOrEqual(-EPSILON)
          expect(point.x, `${name}: ${path.d} → x`).toBeLessThanOrEqual(24 + EPSILON)
          expect(point.y, `${name}: ${path.d} → y`).toBeGreaterThanOrEqual(-EPSILON)
          expect(point.y, `${name}: ${path.d} → y`).toBeLessThanOrEqual(24 + EPSILON)
        }
      }
    }
  })

  it('two-arc circles and ellipses return to their start point before closing', () => {
    let rings = 0
    for (const name of ICON_NAMES) {
      for (const path of icons[name].paths) {
        const { commands, points } = tracePath(path.d)
        if (commands.join('') !== 'Maaz') continue
        rings += 1
        // points: [move-to, end of arc 1, end of arc 2, Z]. Arc 2 must land exactly on the start.
        expect(points[2], `${name}: ${path.d}`).toEqual(points[0])
        expect(points[1], `${name}: ${path.d}`).not.toEqual(points[0])
      }
    }
    expect(rings).toBeGreaterThanOrEqual(9)
    expect(icons.live.paths[0]?.d).toBe('M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0 -17z')
    expect(icons.more.paths[0]?.d).toBe('M5 10.25a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0 -3.5z')
  })

  it('live is a ring around a filled point, not a plus', () => {
    const kinds = icons.live.paths.map((p) => p.kind)
    expect(kinds).toEqual(['stroke', 'fill'])
    expect(icons.live.paths[0]?.d).toContain('a8.5 8.5')
    expect(icons.live.paths[1]?.d).toContain('a3.5 3.5')
    expect(icons.live).not.toEqual(icons.plus)
    for (const path of icons.live.paths) expect(path.d).not.toMatch(/[hvl]/i)
  })

  it('off variants add a slash to the on variant', () => {
    expect(icons.micOff.paths.slice(0, -1)).toEqual(icons.mic.paths)
    expect(icons.cameraOff.paths.slice(0, -1)).toEqual(icons.camera.paths)
    expect(icons.micOff.paths.at(-1)?.d).toBe('M4 4l16 16')
    expect(icons.cameraOff.paths.at(-1)?.d).toBe('M4 4l16 16')
  })

  it('maps every tab to an icon, in tab order', () => {
    expect(TAB_ICONS).toEqual({
      home: 'home',
      chats: 'chats',
      live: 'live',
      earth: 'earth',
      you: 'you',
    })
    expect(Object.keys(TAB_ICONS)).toEqual([...TABS])
    for (const tab of TABS) expect(ICON_NAMES).toContain(TAB_ICONS[tab])
  })

  it('renders SVG strings', () => {
    const svg = iconToSvg('live', { size: 32, color: '#E6463E', title: 'Live' })
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"')).toBe(true)
    expect(svg).toContain('width="32" height="32"')
    expect(svg).toContain('role="img" aria-label="Live"')
    expect(svg).toContain('stroke="#E6463E" stroke-width="1.75"')
    expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"')
    expect(svg).toContain('fill="#E6463E" stroke="none"')
    expect(svg.match(/<path /g)).toHaveLength(icons.live.paths.length)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(iconToSvg('check')).toContain('aria-hidden="true"')
    expect(iconToSvg('check')).toContain('stroke="currentColor"')
    expect(iconToSvg('check')).toContain('width="24" height="24"')
  })

  it('escapes attribute text', () => {
    const svg = iconToSvg('check', { title: 'a"b<c>&d', color: 'var(--x)"' })
    expect(svg).toContain('aria-label="a&quot;b&lt;c&gt;&amp;d"')
    expect(svg).toContain('stroke="var(--x)&quot;"')
  })
})
