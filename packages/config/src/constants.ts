/**
 * Product-wide constants owned by `@earth/config` (ARCHITECTURE §2, §14, §15).
 *
 * Domain limits, TTLs and deep-link paths live in `@earth/domain`; this file only holds what
 * the environment loader and the local stack need to agree on.
 */

/** Product name as rendered in UI chrome, notifications and metadata. */
export const APP_NAME = 'Earth' as const

/** Canonical production web origin (ARCHITECTURE §14 `WEB_ORIGIN`). */
export const PRODUCTION_WEB_ORIGIN = 'https://earth.social' as const

/** Hostname every local-stack service binds to (scripts/local-stack, ARCHITECTURE §15). */
export const LOCAL_HOST = 'localhost' as const

/** Ports of the local stack (ARCHITECTURE §15; scripts/local-stack/env.sh mirrors them). */
export const LOCAL_PORTS = {
  /** `apps/web` (Next.js) — also hosts the `/api` server tier. */
  web: 3000,
  /**
   * Supabase-shaped gateway (scripts/local-stack/gateway.mjs): routes `/rest/v1` to PostgREST
   * and `/auth/v1` to GoTrue, so it is the local `SUPABASE_URL`. Same port as the Supabase CLI
   * (`supabase/config.toml` `[api].port`).
   */
  gateway: 54321,
  /** PostgREST in front of the local Postgres (behind the gateway). */
  postgrest: 3001,
  /** GoTrue (Supabase Auth; behind the gateway). */
  gotrue: 9999,
  /** LiveKit server in dev mode. */
  livekit: 7880,
  /** Mailpit SMTP listener (GoTrue sends OTP mail here). */
  mailpitSmtp: 1025,
  /** Mailpit HTTP UI + API (e2e reads OTP codes from it). */
  mailpitHttp: 8025,
} as const

export type LocalService = keyof typeof LOCAL_PORTS

/** URLs of the local stack derived from {@link LOCAL_PORTS}; `env.ts` uses them as development defaults. */
export const LOCAL_URLS = {
  web: `http://${LOCAL_HOST}:${LOCAL_PORTS.web}`,
  /** What `SUPABASE_URL` points at locally. */
  supabase: `http://${LOCAL_HOST}:${LOCAL_PORTS.gateway}`,
  postgrest: `http://${LOCAL_HOST}:${LOCAL_PORTS.postgrest}`,
  gotrue: `http://${LOCAL_HOST}:${LOCAL_PORTS.gotrue}`,
  livekit: `ws://${LOCAL_HOST}:${LOCAL_PORTS.livekit}`,
  mailpitHttp: `http://${LOCAL_HOST}:${LOCAL_PORTS.mailpitHttp}`,
} as const
