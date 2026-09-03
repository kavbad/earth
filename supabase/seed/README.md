# Seed fixtures

Development-only data, applied by `pnpm db:reset` (and `pnpm db:seed`) as `supabase/seed/*.sql`
in lexical order. Seeds are never applied when `APP_ENV=production`.

Rules (spec §117, ARCHITECTURE.md §15):

- Fixture Humans (Xavier, Maya, Kavon, Sarah, Ben, Chris, ...) are explicitly marked as test
  fixtures in non-production (for example `humans.is_fixture = true` or a fixture tag) so no
  surface can mistake them for real Humans.
- Seeds create: friendships between fixtures, two groups, posts, active-looking historical
  Live records, and city/area examples (San Francisco areas for the map).
- Production must never display fake fixture Humans. Launch content in production comes from a
  real seeded cohort, never from these files.
- Seed files must be idempotent (re-runnable) and must only use public RPCs or explicit inserts
  that respect the same invariants the RPCs enforce.
