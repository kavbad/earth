/**
 * Every path `vercel.json` schedules, driven the way Vercel Cron actually drives it: a `GET` with
 * `Authorization: Bearer $CRON_SECRET` and no custom header (docs/DEPLOYMENT.md §3.4).
 *
 * The route table declares these three as `POST` + `x-earth-cron-secret`
 * (`packages/server/src/router.ts`), so `lib/server/cron.ts` translates the platform request
 * before the router sees it. This suite is the proof that the translation covers *each* scheduled
 * path — schedule and route are read from the same file, so adding a cron without a handler, or
 * renaming a handler out from under a schedule, fails here — and that an unauthenticated or
 * wrongly-signed cron request never reaches the RPC.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ALLOW_HEADER, CRON_SECRET_HEADER, isErrorBody } from '@earth/server'
import { describe, expect, it } from 'vitest'

import {
  TEST_CRON_SECRET,
  TEST_VERCEL_CRON_SECRET,
  type FakeRpcHandler,
  createTestContext,
  readJson,
  webRequest,
} from '../../../lib/server/fakes'
import { makeRouteHandler } from '../../../lib/server/handler'

interface VercelJson {
  readonly crons?: readonly { readonly path: string; readonly schedule: string }[]
}

const here = dirname(fileURLToPath(import.meta.url))
const vercelJson = JSON.parse(
  readFileSync(join(here, '..', '..', '..', 'vercel.json'), 'utf8'),
) as VercelJson
const crons = vercelJson.crons ?? []

/** The service RPC each scheduled route runs, and a fake result for it. */
const RPC_FOR_PATH: Readonly<Record<string, { readonly name: string; readonly result: unknown }>> =
  {
    '/api/internal/push/dispatch': { name: 'notifications_unsent', result: [] },
    '/api/internal/rooms/sweep': {
      name: 'rooms_sweep',
      result: { roomsEnded: 0, guestsExpired: 0 },
    },
    '/api/internal/metrics/daily': { name: 'metrics_compute_daily', result: { days: 1 } },
  }

function contextFor(path: string) {
  const rpc = RPC_FOR_PATH[path]
  if (rpc === undefined) throw new Error(`no RPC mapped for the scheduled path ${path}`)
  const handler: FakeRpcHandler = () => rpc.result
  return {
    rpcName: rpc.name,
    test: createTestContext({
      env: { CRON_SECRET: TEST_VERCEL_CRON_SECRET },
      rpc: { [rpc.name]: handler },
    }),
  }
}

async function errorCode(response: Response): Promise<string> {
  const body = await readJson(response)
  if (!isErrorBody(body)) throw new Error(`not an error body: ${JSON.stringify(body)}`)
  return body.error.code
}

describe('vercel.json crons', () => {
  it('schedules exactly the internal routes this suite drives', () => {
    expect(crons.map((cron) => cron.path)).toEqual(Object.keys(RPC_FOR_PATH))
    for (const cron of crons) expect(cron.schedule, cron.path).toMatch(/^[\d*,\-/ ]+$/)
  })
})

describe.each(crons.map((cron) => cron.path))('scheduled %s', (path) => {
  it('runs from a Vercel cron GET carrying only the CRON_SECRET bearer', async () => {
    const { rpcName, test } = contextFor(path)
    const response = await makeRouteHandler({ context: () => test.context }).GET(
      // Exactly what Vercel Cron sends: GET, bearer, no x-earth-cron-secret.
      webRequest(path, { bearer: TEST_VERCEL_CRON_SECRET }),
    )
    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toMatchObject({ ok: true })
    expect(test.supabase.callsTo(rpcName)).toHaveLength(1)
    expect(test.supabase.callsTo(rpcName)[0]?.kind).toBe('admin')
  })

  it('refuses the same GET without the secret (405, nothing ran)', async () => {
    const { rpcName, test } = contextFor(path)
    const response = await makeRouteHandler({ context: () => test.context }).GET(webRequest(path))
    expect(response.status).toBe(405)
    expect(response.headers.get(ALLOW_HEADER)).toBe('POST')
    expect(test.supabase.callsTo(rpcName)).toEqual([])
  })

  it('refuses a wrong bearer with 403 (nothing ran)', async () => {
    const { rpcName, test } = contextFor(path)
    const response = await makeRouteHandler({ context: () => test.context }).GET(
      webRequest(path, { bearer: 'not-the-cron-secret' }),
    )
    expect(response.status).toBe(403)
    await expect(errorCode(response)).resolves.toBe('forbidden')
    expect(test.supabase.callsTo(rpcName)).toEqual([])
  })

  it('still accepts the documented POST with x-earth-cron-secret', async () => {
    const { rpcName, test } = contextFor(path)
    const response = await makeRouteHandler({ context: () => test.context }).POST(
      webRequest(path, { method: 'POST', headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET } }),
    )
    expect(response.status).toBe(200)
    expect(test.supabase.callsTo(rpcName)).toHaveLength(1)
  })

  it('answers 401 for a POST with no credential at all', async () => {
    const { rpcName, test } = contextFor(path)
    const response = await makeRouteHandler({ context: () => test.context }).POST(
      webRequest(path, { method: 'POST' }),
    )
    expect(response.status).toBe(401)
    await expect(errorCode(response)).resolves.toBe('not_authenticated')
    expect(test.supabase.callsTo(rpcName)).toEqual([])
  })
})
