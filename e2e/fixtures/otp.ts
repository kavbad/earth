/**
 * Email one-time codes for the journeys. GoTrue in the local stack sends every OTP through
 * Mailpit (SMTP 1025, HTTP API 8025) with the templates in `scripts/local-stack/mail-templates`,
 * which mark the code with `data-earth-otp="<code>"` — the same thing
 * `bash scripts/local-stack/otp.sh <email>` reads. This talks to the Mailpit HTTP API directly
 * (no subprocess per code); set `E2E_OTP_VIA_SCRIPT=1` to go through the shell script instead.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { REPO_ROOT, mailpitURL, sleep } from './stack'

const run = promisify(execFile)

/** Mirrors `scripts/local-stack/otp.ts`: GOTRUE_MAILER_OTP_LENGTH / supabase config. */
export const OTP_LENGTH = 6
export const OTP_ATTRIBUTE = 'data-earth-otp'
export const OTP_MARKER = 'earth-otp:'
export const OTP_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 250

const attributePattern = new RegExp(`${OTP_ATTRIBUTE}="(\\d{${OTP_LENGTH}})"`)
const markerPattern = new RegExp(`${OTP_MARKER}(\\d{${OTP_LENGTH}})`)
/** A bare code touches no other letter or digit: GoTrue's links carry hex token hashes. */
const barePattern = new RegExp(`(?<![A-Za-z0-9])(\\d{${OTP_LENGTH}})(?![A-Za-z0-9])`)
const urlPattern = /(?:href|src)="[^"]*"|https?:\/\/\S+/g

export interface MailParts {
  readonly html?: string | undefined
  readonly text?: string | undefined
  readonly subject?: string | undefined
}

/** Removes links (which embed token hashes) before a bare-digit search. */
export function stripLinks(value: string): string {
  return value.replace(urlPattern, ' ')
}

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

/** The `.../auth/v1/verify?token=<token_hash>&type=<type>` link the same email carries. */
export function extractConfirmationLink(html: string): { token: string; type: string } | null {
  const match = /href="([^"]*\/verify\?[^"]*)"/.exec(html)
  if (match?.[1] === undefined) return null
  const href = match[1].replace(/&amp;/g, '&')
  const query = new URL(href, 'http://localhost').searchParams
  const token = query.get('token')
  if (token === null || token === '') return null
  return { token, type: query.get('type') ?? 'magiclink' }
}

interface MailpitSummary {
  readonly ID: string
  readonly Subject: string
  readonly Created: string
  readonly To: readonly { readonly Address: string }[]
}

interface MailpitMessage {
  readonly ID: string
  readonly Subject: string
  readonly HTML: string
  readonly Text: string
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Mailpit ${url} answered ${response.status}`)
  return (await response.json()) as T
}

async function newestMessage(
  email: string,
  after: Date | undefined,
): Promise<MailpitSummary | null> {
  const query = encodeURIComponent(`to:${email}`)
  const { messages } = await getJson<{ messages: MailpitSummary[] | null }>(
    `${mailpitURL()}/api/v1/search?query=${query}&limit=20`,
  )
  const wanted = email.toLowerCase()
  const matching = (messages ?? [])
    .filter((message) => message.To.some((to) => to.Address.toLowerCase() === wanted))
    .filter((message) => after === undefined || new Date(message.Created) > after)
    .sort((a, b) => new Date(b.Created).getTime() - new Date(a.Created).getTime())
  return matching[0] ?? null
}

export interface ReadOtpOptions {
  /** Ignore mail older than this, so a re-used address yields the fresh code. */
  readonly after?: Date | undefined
  readonly timeoutMs?: number
}

export interface OtpMail {
  readonly code: string
  readonly subject: string
  readonly html: string
  readonly createdAt: string
}

/** Polls Mailpit until the OTP email for `email` exists and returns it; throws on timeout. */
export async function readLatestOtpMail(
  email: string,
  options: ReadOtpOptions = {},
): Promise<OtpMail> {
  const timeoutMs = options.timeoutMs ?? OTP_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const summary = await newestMessage(email, options.after)
    if (summary !== null) {
      const message = await getJson<MailpitMessage>(
        `${mailpitURL()}/api/v1/message/${encodeURIComponent(summary.ID)}`,
      )
      const code = extractOtp({
        html: message.HTML,
        text: message.Text,
        subject: message.Subject,
      })
      if (code !== null) {
        return {
          code,
          subject: message.Subject,
          html: message.HTML,
          createdAt: summary.Created,
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no one-time code for ${email} in Mailpit (${mailpitURL()}) within ${timeoutMs / 1000}s`,
      )
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/** `bash scripts/local-stack/otp.sh <email>` — the documented path, used when asked for. */
async function readLatestOtpViaScript(email: string, timeoutMs: number): Promise<string> {
  const seconds = String(Math.ceil(timeoutMs / 1000))
  const { stdout } = await run(
    'bash',
    ['scripts/local-stack/otp.sh', email, '--timeout', seconds],
    { cwd: REPO_ROOT, env: process.env, timeout: timeoutMs + 15_000 },
  )
  const code = stdout.trim()
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) {
    throw new Error(`scripts/local-stack/otp.sh printed ${JSON.stringify(code)} for ${email}`)
  }
  return code
}

/** The six-digit code Earth just emailed to `email`. Polls for up to 20 s; never sleeps blindly. */
export async function readLatestOtp(email: string, options: ReadOtpOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? OTP_TIMEOUT_MS
  if (process.env['E2E_OTP_VIA_SCRIPT'] === '1') {
    return readLatestOtpViaScript(email, timeoutMs)
  }
  return (await readLatestOtpMail(email, options)).code
}
