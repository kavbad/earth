/**
 * Integration guard: every destination the app navigates to exists as an expo-router file under
 * `app/`, the five tabs live in the `(tabs)` group, no destination is defined twice across
 * groups, and an unmatched path lands on the app's own `+not-found` screen rather than
 * expo-router's default one.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ROUTES, TAB_ROUTES } from './routes'

const APP_DIR = join(__dirname, '..', 'app')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** `app/(tabs)/chats.tsx` → `/chats`; `app/chats/[id]/info.tsx` → `/chats/[id]/info`; `index` folds. */
function routeOf(file: string): string | null {
  const rel = relative(APP_DIR, file).replace(/\\/g, '/')
  if (!/\.tsx?$/.test(rel)) return null
  const base = rel.replace(/\.tsx?$/, '')
  if (base.startsWith('+') || /(^|\/)_layout$/.test(base)) return null
  const segments = base.split('/').filter((segment) => !/^\(.*\)$/.test(segment))
  if (segments[segments.length - 1] === 'index') segments.pop()
  return `/${segments.join('/')}`
}

const files = walk(APP_DIR)
const routes = new Set(files.map(routeOf).filter((r): r is string => r !== null))

/** Destinations the shell itself owns or forwards to (tabs, claim, welcome, the deep links). */
const SHELL_ROUTES = [
  ...Object.values(TAB_ROUTES),
  ROUTES.claim,
  ROUTES.claimStart,
  ROUTES.claimJoin,
  ROUTES.claimCredential,
  ROUTES.claimIdentity,
  ROUTES.claimHuman,
  ROUTES.welcome,
  '/g/[token]',
  '/live/[token]',
] as const

/** Destinations the feature screens navigate to (spec §112, SCREEN 06–25). */
const FEATURE_ROUTES = [
  ROUTES.notifications,
  '/compose',
  '/search',
  '/chats/new',
  '/chats/[id]',
  '/chats/[id]/info',
  '/rooms/[id]',
  '/rooms/join',
  '/p/[id]',
  '/u/[handle]',
  '/you/settings',
  '/you/settings/account',
  '/you/settings/privacy',
  '/you/settings/notifications',
  '/you/settings/safety',
  '/you/settings/identity',
] as const

describe('shell routes', () => {
  it.each(SHELL_ROUTES)('%s exists under app/', (route) => {
    expect(routes.has(route)).toBe(true)
  })

  it('keeps the five tabs inside the (tabs) group', () => {
    const tabFiles = readdirSync(join(APP_DIR, '(tabs)'))
      .map((name) => name.replace(/\.tsx?$/, ''))
      .filter((name) => name !== '_layout')
    expect([...tabFiles].sort()).toEqual(['chats', 'earth', 'home', 'live', 'you'])
  })

  it('has one file per route (no duplicate destinations across groups)', () => {
    const seen = new Map<string, number>()
    for (const file of files) {
      const route = routeOf(file)
      if (route === null) continue
      seen.set(route, (seen.get(route) ?? 0) + 1)
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([route]) => route)
    expect(duplicates).toEqual([])
  })
})

describe('feature routes (feed, chats, rooms and Earth)', () => {
  it.each(FEATURE_ROUTES)('%s exists under app/', (route) => {
    expect(routes.has(route)).toBe(true)
  })
})

describe('unmatched paths', () => {
  it('land on the app’s own +not-found screen', () => {
    expect(existsSync(join(APP_DIR, '+not-found.tsx'))).toBe(true)
  })
})
