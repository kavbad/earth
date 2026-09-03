import { describe, expect, it } from 'vitest'

import { DELETE, GET, PATCH, POST, PUT, dynamic, maxDuration, runtime } from './route'

describe('/api/[...earth] route module', () => {
  it('runs on the Node runtime, always dynamically, with a bounded duration', () => {
    expect(runtime).toBe('nodejs')
    expect(dynamic).toBe('force-dynamic')
    expect(maxDuration).toBe(60)
  })

  it('exports one handler per method the router serves', () => {
    for (const handler of [GET, POST, PUT, PATCH, DELETE]) expect(typeof handler).toBe('function')
    expect(GET).toBe(POST)
    expect(GET).toBe(PUT)
  })

  it('answers JSON even when the server environment is not configured', async () => {
    // process.env in a unit test has no server tier configured, so the context cannot be built.
    const response = await GET(new Request('http://localhost:3000/api/feed?scope=world'))
    expect(response.headers.get('content-type')).toContain('application/json')
    expect([200, 500]).toContain(response.status)
  })
})
