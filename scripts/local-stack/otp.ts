#!/usr/bin/env tsx
/**
 * Reads the latest email one-time code Mailpit received for an address. GoTrue in the local stack
 * sends every OTP email through Mailpit (SMTP 1025, HTTP API 8025) using the templates in
 * scripts/local-stack/mail-templates, which mark the code with `data-earth-otp="<code>"`.
 *
 *   tsx scripts/local-stack/otp.ts <email> [--mailpit http://127.0.0.1:8025] [--timeout <seconds>] [--after <iso>] [--json]
 *
 * Polls until a matching message exists (default 15 s) because delivery is asynchronous. Used by
 * scripts/local-stack/otp.sh and the e2e journeys.
 */
import { pathToFileURL } from 'node:url'

/** Same as supabase/config.toml [auth.email].otp_length and GOTRUE_MAILER_OTP_LENGTH (env.sh). */
export const OTP_LENGTH = 6
/** Mirrors @earth/config LOCAL_PORTS.mailpitHttp (asserted in env.test.ts). */
export const DEFAULT_MAILPIT_URL = 'http://127.0.0.1:8025'
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_POLL_INTERVAL_MS = 500

/** Attribute the mail templates put on the code element; the most reliable extraction path. */
export const OTP_ATTRIBUTE = 'data-earth-otp'
/** Marker in an HTML comment, for extraction from text-only renderings of the same templates. */
export const OTP_MARKER = 'earth-otp:'

export interface MailParts {
  html?: string | undefined
  text?: string | undefined
  subject?: string | undefined
}

const attributePattern = new RegExp(`${OTP_ATTRIBUTE}="(\\d{${OTP_LENGTH}})"`)
const markerPattern = new RegExp(`${OTP_MARKER}(\\d{${OTP_LENGTH}})`)
/**
 * A bare code is exactly OTP_LENGTH digits not touching any other letter or digit: GoTrue's links
 * carry hex token hashes (`token=…f3f410672c…`) that would otherwise yield false positives.
 */
const barePattern = new RegExp(`(?<![A-Za-z0-9])(\\d{${OTP_LENGTH}})(?![A-Za-z0-9])`)
const urlPattern = /(?:href|src)="[^"]*"|https?:\/\/\S+/g

/** Removes links (which embed token hashes and redirect URLs) before a bare-digit search. */
export function stripLinks(value: string): string {
  return value.replace(urlPattern, ' ')
}

/** Extracts the code from the templates' attribute or marker, else the first bare 6-digit run. */
export function extractOtp(parts: MailParts): string | null {
  const html = parts.html ?? ''
  const text = parts.text ?? ''
  const subject = parts.subject ?? ''
  const candidates = [
    attributePattern.exec(html),
    markerPattern.exec(html),
    markerPattern.exec(text),
    barePattern.exec(stripLinks(subject)),
    barePattern.exec(stripLinks(text)),
    barePattern.exec(stripLinks(html)),
  ]
  for (const match of candidates) {
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

export interface MailpitAddress {
  Name?: string
  Address: string
}

export interface MailpitMessageSummary {
  ID: string
  Subject: string
  Created: string
  To: MailpitAddress[]
}

export interface MailpitMessage {
  ID: string
  Subject: string
  Date?: string
  HTML: string
  Text: string
}

export interface OtpResult {
  code: string
  messageId: string
  subject: string
  createdAt: string
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function normalizeUrl(mailpitUrl: string): string {
  return mailpitUrl.replace(/\/+$/, '')
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T> {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Mailpit ${url} answered ${response.status}`)
  return (await response.json()) as T
}

/** Newest message addressed to `email` (case-insensitive), optionally created after `after`. */
export async function findLatestMessage(
  mailpitUrl: string,
  email: string,
  options: { fetchImpl?: FetchLike; after?: Date | undefined } = {},
): Promise<MailpitMessageSummary | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const query = encodeURIComponent(`to:${email}`)
  const { messages } = await getJson<{ messages: MailpitMessageSummary[] | null }>(
    fetchImpl,
    `${normalizeUrl(mailpitUrl)}/api/v1/search?query=${query}&limit=20`,
  )
  const wanted = email.toLowerCase()
  const matching = (messages ?? [])
    .filter((message) => message.To.some((to) => to.Address.toLowerCase() === wanted))
    .filter((message) => options.after === undefined || new Date(message.Created) > options.after)
    .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime())
  return matching[0] ?? null
}

export async function fetchMessage(
  mailpitUrl: string,
  id: string,
  fetchImpl: FetchLike = fetch,
): Promise<MailpitMessage> {
  return getJson<MailpitMessage>(
    fetchImpl,
    `${normalizeUrl(mailpitUrl)}/api/v1/message/${encodeURIComponent(id)}`,
  )
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls Mailpit until an OTP email for `email` exists and returns its code, or `null` once
 * `timeoutMs` elapses. `after` ignores older messages so a re-used address yields the fresh code.
 */
export async function latestOtpFor(
  mailpitUrl: string,
  email: string,
  options: {
    fetchImpl?: FetchLike
    timeoutMs?: number
    intervalMs?: number
    after?: Date | undefined
    now?: () => number
  } = {},
): Promise<OtpResult | null> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  for (;;) {
    const summary = await findLatestMessage(mailpitUrl, email, { fetchImpl, after: options.after })
    if (summary !== null) {
      const message = await fetchMessage(mailpitUrl, summary.ID, fetchImpl)
      const code = extractOtp({ html: message.HTML, text: message.Text, subject: message.Subject })
      if (code !== null) {
        return { code, messageId: summary.ID, subject: summary.Subject, createdAt: summary.Created }
      }
    }
    if (now() >= deadline) return null
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface CliOptions {
  email: string | undefined
  mailpitUrl: string
  timeoutMs: number
  after: Date | undefined
  json: boolean
  help: boolean
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  const options: CliOptions = {
    email: undefined,
    mailpitUrl: env['EARTH_MAILPIT_URL'] ?? DEFAULT_MAILPIT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    after: undefined,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    switch (arg) {
      case '--mailpit':
        options.mailpitUrl = next()
        break
      case '--timeout': {
        const seconds = Number(next())
        if (!Number.isFinite(seconds) || seconds < 0)
          throw new Error('--timeout must be a number of seconds')
        options.timeoutMs = seconds * 1000
        break
      }
      case '--after': {
        const after = new Date(next())
        if (Number.isNaN(after.getTime())) throw new Error('--after must be an ISO timestamp')
        options.after = after
        break
      }
      case '--json':
        options.json = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
        if (options.email !== undefined) throw new Error('Only one email address is expected')
        options.email = arg
    }
  }
  return options
}

export const USAGE =
  'usage: tsx scripts/local-stack/otp.ts <email> [--mailpit <url>] [--timeout <seconds>] [--after <iso>] [--json]'

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  ;(async () => {
    const options = parseCliArgs(process.argv.slice(2), process.env)
    if (options.help || options.email === undefined) {
      console.log(USAGE)
      process.exitCode = options.help ? 0 : 1
      return
    }
    const result = await latestOtpFor(options.mailpitUrl, options.email, {
      timeoutMs: options.timeoutMs,
      after: options.after,
    })
    if (result === null) {
      console.error(
        `[otp] no OTP email for ${options.email} at ${options.mailpitUrl} within ${options.timeoutMs / 1000}s`,
      )
      process.exitCode = 1
      return
    }
    console.log(options.json ? JSON.stringify(result) : result.code)
  })().catch((error: unknown) => {
    console.error(`[otp] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
