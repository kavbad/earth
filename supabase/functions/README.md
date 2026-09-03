# Supabase Edge Functions

Intentionally empty in V1.

Every data invariant and authorization decision lives in Postgres (`supabase/migrations`) as
RLS plus `security definer` RPC functions. Secret-bearing and provider-facing logic lives in
`packages/server` and is mounted as Next.js route handlers under `apps/web/app/api/**`.

See `docs/architecture/ADR-001-server-tier.md` for the decision and the migration path to
Edge Functions or a standalone service (a mount change, not a rewrite).
