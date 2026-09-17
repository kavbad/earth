# ADR-001 — Server tier runs in Node (Next.js route handlers), not Deno Edge Functions

Status: accepted (V1)

## Context

The spec asks for Supabase server-side functions for sensitive multi-table invariants and
for anything requiring secrets (LiveKit tokens, push, Human verification). Supabase offers
two shapes: Postgres functions (RPC) and Deno Edge Functions.

The shared TypeScript packages (`@earth/domain`, `@earth/permissions`, `@earth/analytics`)
must be usable by the server tier without duplication. Deno Edge Functions cannot import
workspace packages through pnpm, cannot be executed in this build environment (no Docker
edge-runtime), and would force a second module-resolution style on the shared packages.

## Decision

1. Every data invariant and every authorization decision lives in Postgres as `security definer`
   RPC functions plus RLS. These are Supabase server-side functions in the strict sense and are
   fully testable against a local Postgres.
2. Secret-bearing and provider-facing logic lives in `packages/server` as pure functions with
   injected dependencies, mounted as route handlers under `apps/web/app/api/**`. Mobile calls
   these routes through `@earth/api` using `API_BASE_URL`.
3. `supabase/functions/` is kept in the tree with a README pointing here so the migration path to
   Edge Functions (or a standalone service) is a mount change, not a rewrite.

## Consequences

- One TypeScript runtime for shared logic; vitest covers the server tier.
- The web deployment (Vercel or any Node host) also serves the API. Scheduled work is triggered
  by platform cron hitting `/api/internal/*` with `INTERNAL_CRON_SECRET`, or by `pg_cron` + `pg_net`
  on hosted Supabase.
- If the API must scale independently, `packages/server` can be mounted in a Hono/Fastify app
  without changing clients.
