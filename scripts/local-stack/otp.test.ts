import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_MAILPIT_URL,
  DEFAULT_TIMEOUT_MS,
  OTP_ATTRIBUTE,
  OTP_MARKER,
  extractOtp,
  fetchMessage,
  findLatestMessage,
  latestOtpFor,
  parseCliArgs,
  stripLinks,
  type MailpitMessage,
  type MailpitMessageSummary,
} from './otp'

describe('extractOtp', () => {
  it('prefers the template attribute over other numbers', () => {
    const html = `<p>Sent at 20250101</p><strong ${OTP_ATTRIBUTE}="482913">482913</strong><!-- ${OTP_MARKER}482913 -->`
    expect(extractOtp({ html, subject: 'Order 123456' })).toBe('482913')
  })

  it('falls back to the marker, the subject, then any bare six digits', () => {
    expect(extractOtp({ text: `see ${OTP_MARKER}104455 now` })).toBe('104455')
    expect(extractOtp({ subject: 'Your Earth code: 771234', html: '<p>no code here</p>' })).toBe(
      '771234',
    )
    expect(extractOtp({ text: 'Enter 900001 to continue' })).toBe('900001')
    expect(extractOtp({ html: '<p>code 555555</p>' })).toBe('555555')
  })

  it('ignores longer digit runs and returns null when nothing matches', () => {
    expect(extractOtp({ text: 'ref 12345678, phone 5551234' })).toBeNull()
    expect(extractOtp({})).toBeNull()
  })

  it("never reads digits out of GoTrue's hex token hashes or links (default template)", () => {
    // Real shape of GoTrue's default confirmation mail: the link's token hash contains "410672".
    const html =
      '<p><a href="http://localhost:54321/verify?token=313c77e64dd643a2a0e94593509cb83786f3f410672c8883c0942700&amp;type=signup&amp;redirect_to=http://localhost:3000">Confirm</a></p>' +
      '<p>Alternatively, enter the code: 477621</p>'
    expect(extractOtp({ html })).toBe('477621')
    expect(extractOtp({ text: 'hash f3f410672c only' })).toBeNull()
    expect(extractOtp({ text: 'see https://x.test/verify?t=123456 then 654321' })).toBe('654321')
    expect(stripLinks('a href="x123456y" b')).toBe('a   b')
  })
})

interface FakeMailpit {
  server: http.Server
  url: string
  messages: Array<MailpitMessageSummary & MailpitMessage>
  searches: string[]
}

function startFakeMailpit(): Promise<FakeMailpit> {
  const state: FakeMailpit = { server: http.createServer(), url: '', messages: [], searches: [] }
  state.server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mailpit')
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/api/v1/search') {
      const query = url.searchParams.get('query') ?? ''
      state.searches.push(query)
      const wanted = query.replace(/^to:/, '').toLowerCase()
      const messages = state.messages
        .filter((m) => m.To.some((to) => to.Address.toLowerCase().includes(wanted)))
        .map(({ ID, Subject, Created, To }) => ({ ID, Subject, Created, To }))
      json(200, { messages, total: messages.length })
      return
    }
    const detail = /^\/api\/v1\/message\/(.+)$/.exec(url.pathname)
    if (detail) {
      const message = state.messages.find((m) => m.ID === decodeURIComponent(detail[1] as string))
      if (message) {
        json(200, {
          ID: message.ID,
          Subject: message.Subject,
          HTML: message.HTML,
          Text: message.Text,
        })
      } else {
        json(404, { error: 'not found' })
      }
      return
    }
    json(404, { error: 'unknown route' })
  })
  return new Promise((resolve) => {
    state.server.listen(0, '127.0.0.1', () => {
      const address = state.server.address() as net.AddressInfo
      state.url = `http://127.0.0.1:${address.port}/`
      resolve(state)
    })
  })
}

function message(
  id: string,
  to: string,
  created: string,
  code: string,
): MailpitMessageSummary & MailpitMessage {
  return {
    ID: id,
    Subject: `Your Earth code: ${code}`,
    Created: created,
    To: [{ Address: to }],
    HTML: `<strong ${OTP_ATTRIBUTE}="${code}">${code}</strong>`,
    Text: '',
  }
}

describe('Mailpit client', () => {
  let mailpit: FakeMailpit

  beforeAll(async () => {
    mailpit = await startFakeMailpit()
    mailpit.messages.push(
      message('m1', 'alice@earth.local', '2026-01-01T10:00:00Z', '111111'),
      message('m2', 'ALICE@earth.local', '2026-01-01T10:05:00Z', '222222'),
      message('m3', 'bob@earth.local', '2026-01-01T10:06:00Z', '333333'),
      message('m4', 'alice@earth.local.evil', '2026-01-01T10:07:00Z', '444444'),
    )
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mailpit.server.close(() => resolve()))
  })

  it('finds the newest message for an address, case-insensitively and exactly', async () => {
    const latest = await findLatestMessage(mailpit.url, 'alice@earth.local')
    expect(latest?.ID).toBe('m2')
    expect(mailpit.searches.at(-1)).toBe('to:alice@earth.local')
    await expect(findLatestMessage(mailpit.url, 'carol@earth.local')).resolves.toBeNull()
  })

  it('honours the `after` cut-off', async () => {
    const latest = await findLatestMessage(mailpit.url, 'alice@earth.local', {
      after: new Date('2026-01-01T10:05:00Z'),
    })
    expect(latest).toBeNull()
    const older = await findLatestMessage(mailpit.url, 'alice@earth.local', {
      after: new Date('2026-01-01T09:00:00Z'),
    })
    expect(older?.ID).toBe('m2')
  })

  it('fetches a message body and surfaces HTTP errors', async () => {
    await expect(fetchMessage(mailpit.url, 'm3')).resolves.toMatchObject({ ID: 'm3' })
    await expect(fetchMessage(mailpit.url, 'missing')).rejects.toThrow(/404/)
  })

  it('returns the latest code and waits for delivery', async () => {
    await expect(
      latestOtpFor(mailpit.url, 'bob@earth.local', { timeoutMs: 0 }),
    ).resolves.toMatchObject({
      code: '333333',
      messageId: 'm3',
    })

    const pending = latestOtpFor(mailpit.url, 'dave@earth.local', {
      timeoutMs: 2_000,
      intervalMs: 20,
    })
    setTimeout(() => {
      mailpit.messages.push(message('m5', 'dave@earth.local', '2026-01-01T11:00:00Z', '555555'))
    }, 60)
    await expect(pending).resolves.toMatchObject({ code: '555555', messageId: 'm5' })
  })

  it('gives up after the timeout', async () => {
    await expect(
      latestOtpFor(mailpit.url, 'nobody@earth.local', { timeoutMs: 50, intervalMs: 10 }),
    ).resolves.toBeNull()
  })
})

describe('parseCliArgs', () => {
  it('reads the email, flags and environment defaults', () => {
    expect(parseCliArgs(['probe@earth.local'], {})).toEqual({
      email: 'probe@earth.local',
      mailpitUrl: DEFAULT_MAILPIT_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      after: undefined,
      json: false,
      help: false,
    })
    expect(
      parseCliArgs(
        [
          '--mailpit',
          'http://mail:1',
          '--timeout',
          '2',
          '--after',
          '2026-01-01T00:00:00Z',
          '--json',
          'a@b.c',
        ],
        { EARTH_MAILPIT_URL: 'http://ignored' },
      ),
    ).toMatchObject({
      email: 'a@b.c',
      mailpitUrl: 'http://mail:1',
      timeoutMs: 2_000,
      after: new Date('2026-01-01T00:00:00Z'),
      json: true,
    })
    expect(parseCliArgs([], { EARTH_MAILPIT_URL: 'http://env:8025' }).mailpitUrl).toBe(
      'http://env:8025',
    )
    expect(parseCliArgs(['-h'], {}).help).toBe(true)
  })

  it('rejects bad input', () => {
    expect(() => parseCliArgs(['--timeout', 'soon'], {})).toThrow(/seconds/)
    expect(() => parseCliArgs(['--after', 'yesterday'], {})).toThrow(/ISO/)
    expect(() => parseCliArgs(['--bogus'], {})).toThrow(/Unknown argument/)
    expect(() => parseCliArgs(['a@b.c', 'd@e.f'], {})).toThrow(/one email/)
    expect(() => parseCliArgs(['--mailpit'], {})).toThrow(/needs a value/)
  })
})
