/**
 * Integration guard: every screen under `app/` is reachable inside the product (spec §50, §112).
 * A page is either an entry the shell owns — what a typed URL, a deep link or the claim flow
 * lands on — or a destination some other screen links to. A screen only the address bar can
 * reach fails here: `/notifications` (SCREEN 23) was exactly that.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const WEB_DIR = join(__dirname, '..')
const APP_DIR = join(WEB_DIR, 'app')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** `app/(app)/home/page.tsx` → `/home`; `app/page.tsx` → `/`; route groups fold away. */
function routeOf(file: string): string | null {
  const rel = relative(APP_DIR, file).split(sep).join('/')
  if (!/(^|\/)page\.tsx?$/.test(rel)) return null
  const segments = rel
    .replace(/\/?page\.tsx?$/, '')
    .split('/')
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment))
  return `/${segments.join('/')}`
}

const appFiles = walk(APP_DIR)
const screens = [...new Set(appFiles.map(routeOf).filter((r): r is string => r !== null))].sort()

/** The folder a screen lives in — a link from inside it does not make the screen reachable. */
function folderOf(route: string): string {
  const file = appFiles.find((candidate) => routeOf(candidate) === route)
  if (file === undefined) throw new Error(`no page file for ${route}`)
  return file.slice(0, file.lastIndexOf(sep))
}

/** Screens with no in-app link by design: what a URL, a deep link or the claim flow lands on. */
const ENTRY_SCREENS: Readonly<Record<string, string>> = {
  '/': 'the entry that forwards into the shell',
  '/welcome': 'the last step of the claim flow (spec §49)',
  '/claim': 'the claim gate (spec §44)',
  '/claim/start': 'claim step 1 (spec §45)',
  '/claim/join': 'claim from a group invite (spec §46)',
  '/claim/credential': 'claim step 4 (spec §45)',
  '/claim/identity': 'claim step 5 (spec §45)',
  '/claim/human': 'claim step 6 — Human Pass (spec §45, §111)',
  '/g/[token]': 'the group invite deep link (spec §112)',
  '/live/[token]': 'the room invite deep link (spec §112)',
}

/**
 * Every other screen, with the route expression that must appear somewhere else in the product.
 * Route modules (`routes.ts`) declare these; they do not count as navigation, and neither does a
 * link from inside the screen's own folder.
 */
const LINKED_SCREENS: Readonly<Record<string, string>> = {
  '/home': 'TAB_ROUTES',
  '/chats': 'TAB_ROUTES',
  '/live': 'TAB_ROUTES',
  '/earth': 'TAB_ROUTES',
  '/you': 'TAB_ROUTES',
  '/chats/new': 'NEW_CHAT_ROUTE',
  '/chats/[id]': 'conversationRoute',
  '/chats/[id]/info': 'conversationInfoRoute',
  '/compose': 'composeRoute',
  '/notifications': 'NOTIFICATIONS_ROUTE',
  '/search': 'searchRoute',
  '/p/[id]': 'postRoute',
  // `/@handle` is what screens link to; `next.config.ts` rewrites it onto this folder.
  '/u/[handle]': 'profileRoute',
  '/rooms/[id]': 'roomRoute',
  '/you/settings': 'YOU_ROUTES.settings',
  '/you/settings/account': 'YOU_ROUTES.account',
  '/you/settings/privacy': 'YOU_ROUTES.privacy',
  '/you/settings/notifications': 'YOU_ROUTES.notifications',
  '/you/settings/safety': 'YOU_ROUTES.safety',
  '/you/settings/identity': 'YOU_ROUTES.identity',
}

/** Screens and components — never the route modules that declare a path, never the tests. */
const sources = ['app', 'components', 'lib']
  .flatMap((dir) => walk(join(WEB_DIR, dir)))
  .filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !/(^|\/|\\)routes\.tsx?$/.test(file) &&
      !/\.d\.ts$/.test(file),
  )
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }))

function linksTo(expression: string, route: string): string[] {
  const own = `${folderOf(route)}${sep}`
  const use = new RegExp(`(?<![\\w.])${expression.replace('.', '\\.')}\\b`)
  return sources
    .filter(({ file, text }) => !file.startsWith(own) && use.test(text))
    .map(({ file }) => relative(WEB_DIR, file))
}

describe('screens under app/', () => {
  it('every screen declares how it is reached', () => {
    const declared = [...Object.keys(ENTRY_SCREENS), ...Object.keys(LINKED_SCREENS)].sort()
    expect(screens).toEqual(declared)
  })

  it.each(Object.keys(LINKED_SCREENS))('%s is linked from another screen', (route) => {
    const expression = LINKED_SCREENS[route] as string
    expect(
      linksTo(expression, route),
      `${route} has no way in: no screen outside its own folder uses \`${expression}\``,
    ).not.toEqual([])
  })

  /**
   * SCREEN 21 is reachable in principle from anywhere `searchRoute` appears, but the only other
   * link — `AddPeopleRow` — renders solely while a member has no friends. Home's header is the
   * persistent way in, as it is on mobile, so it is pinned here rather than left to the check
   * above.
   */
  it("keeps the persistent way into search (SCREEN 21) in Home's header", () => {
    const home = readFileSync(join(WEB_DIR, 'components', 'feed', 'HomeFeed.tsx'), 'utf8')
    const rendered = home.split('\n').find((line) => line.includes('<SearchButton'))
    expect(rendered, 'Home no longer renders the Search control').toBeDefined()
    // On its own line, with no `?` or `&&` before it: nothing about the viewer can hide it.
    expect(rendered).toMatch(/^\s*<SearchButton \/>$/)
    expect(home.indexOf('<SearchButton'), 'the Search control left the header').toBeLessThan(
      home.indexOf('</ScreenHeader>'),
    )
    const button = readFileSync(join(WEB_DIR, 'components', 'feed', 'SearchButton.tsx'), 'utf8')
    expect(button).toContain('searchRoute()')
  })

  it('keeps the five tabs of the shell, and only those, in the bottom navigation', () => {
    const nav = readFileSync(join(WEB_DIR, 'components', 'shell', 'AppNav.tsx'), 'utf8')
    expect(nav).toContain('TABS.map')
    expect(Object.entries(LINKED_SCREENS).filter(([, e]) => e === 'TAB_ROUTES')).toHaveLength(5)
  })
})
