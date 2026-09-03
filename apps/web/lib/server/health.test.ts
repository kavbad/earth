import { EnvError } from '@earth/config'
import { createLogger, createMemorySink } from '@earth/observability'
import { JSON_CONTENT_TYPE } from '@earth/server'
import { describe, expect, it } from 'vitest'

import { createTestContext, readJson } from './fakes'
import { CONTEXT_FAILED_LOG_MESSAGE } from './handler'
import {
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  SERVICE_NAME,
  ServerTierStates,
  healthResponse,
  makeHealthHandler,
} from './health'

describe('healthResponse', () => {
  it('reports ready with the release when the context builds', () => {
    const { context } = createTestContext({ env: { VERCEL_GIT_COMMIT_SHA: 'abc1234' } })
    const logs = createMemorySink()
    const response = healthResponse(() => context, {}, createLogger({ sink: logs.sink }))
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      service: SERVICE_NAME,
      release: context.env.release,
      serverTier: ServerTierStates.ready,
    })
    expect(context.env.release).toMatch(/\+abc1234$/)
    expect(logs.records).toEqual([])
  })

  it('answers 503 naming the offending variables (never values) and logs the cause', () => {
    const logs = createMemorySink()
    const failure = new EnvError('server', [
      { variable: 'SUPABASE_SERVICE_ROLE_KEY', message: 'missing' },
      { variable: 'NEXT_PUBLIC_MAP_STYLE_URL', message: 'missing' },
      { variable: 'SUPABASE_SERVICE_ROLE_KEY', message: 'also this' },
    ])
    const response = healthResponse(
      () => {
        throw failure
      },
      { VERCEL_GIT_COMMIT_SHA: 'abc1234' },
      createLogger({ sink: logs.sink }),
    )
    expect(response.status).toBe(HTTP_STATUS_SERVICE_UNAVAILABLE)
    expect(response.body).toEqual({
      ok: false,
      service: SERVICE_NAME,
      release: expect.stringMatching(/^earth-web@.+\+abc1234$/) as string,
      serverTier: ServerTierStates.misconfigured,
      issues: ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_MAP_STYLE_URL'],
    })
    expect(JSON.stringify(response.body)).not.toContain('missing')
    expect(logs.records).toHaveLength(1)
    expect(logs.records[0]?.msg).toBe(CONTEXT_FAILED_LOG_MESSAGE)
    expect(logs.records[0]?.level).toBe('error')
    expect(logs.records[0]?.fields).toMatchObject({ error: { name: 'EnvError' } })
  })

  it('answers 503 failed for anything else that stops the context', () => {
    const response = healthResponse(
      () => {
        throw new TypeError('sdk exploded')
      },
      {},
      createLogger({ sink: createMemorySink().sink }),
    )
    expect(response.status).toBe(HTTP_STATUS_SERVICE_UNAVAILABLE)
    expect(response.body).toMatchObject({
      ok: false,
      serverTier: ServerTierStates.failed,
      issues: [],
    })
  })
})

describe('makeHealthHandler', () => {
  it('returns a JSON Response and re-probes an unbuildable context on every call', async () => {
    let attempts = 0
    const { context } = createTestContext()
    const handler = makeHealthHandler({
      context: () => {
        attempts += 1
        if (attempts === 1) {
          throw new EnvError('server', [{ variable: 'INTERNAL_CRON_SECRET', message: 'short' }])
        }
        return context
      },
      source: {},
      logger: createLogger({ sink: createMemorySink().sink }),
    })
    const first = handler()
    expect(first.status).toBe(HTTP_STATUS_SERVICE_UNAVAILABLE)
    expect(first.headers.get('content-type')).toBe(JSON_CONTENT_TYPE)
    await expect(readJson(first)).resolves.toMatchObject({ issues: ['INTERNAL_CRON_SECRET'] })
    const second = handler()
    expect(second.status).toBe(200)
    await expect(readJson(second)).resolves.toMatchObject({ ok: true, serverTier: 'ready' })
  })
})
