# @earth/permissions

`canViewObject` and friends: the TypeScript mirror of the database policy.

## The mirror rule (ARCHITECTURE §1)

Earth has exactly one deliberate double implementation. Row visibility, audience gating, blocks,
membership and consent are enforced by the database (`supabase/migrations`: RLS policies and
`security definer` RPCs — `earth.can_view_post`, `earth.room_visible_to`,
`earth.identity_visible_to`, `earth.can_view_conversation`, `room_join`, `message_send`,
`group_invite_preview`). That is the authority (spec §71: "Server/database authorization is
canonical").

This package re-states those rules as pure functions so the server tier and the clients can decide
**affordances** before calling the database: whether to render "Join them" or the consent sheet,
whether a reshare target is offered, whether a profile card is a link. A `false` here hides a
button; a `true` here still ends in the database's own check. Nothing in this package is a
security boundary.

| Function                                    | Mirrors                                                                         | Notes                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canViewPost(viewer, post, flags)`          | `earth.can_view_post` (0410)                                                    | Replies gated by `rootAudience`; hides are a feed concern (`canViewPostInFeed`).                                                                    |
| `canViewRoom(viewer, room, flags)`          | `earth.room_visible_to` / `earth.room_readable_by_caller` (0310)                | Live seats always see their room; blocks with a consenting publisher hide it; friend-graph union; area context; `PUBLIC_LIVE_ENABLED` for visitors. |
| `canJoinRoom(viewer, room, attempt, flags)` | `room_join`, `room_invite_join`, `guest_session_create` (0330)                  | Returns `{ allowed, reason?, requiresApproval? }` with the exact `earth.raise` code.                                                                |
| `canViewProfile(viewer, profile)`           | `earth.identity_visible_to` (0160)                                              | `public` → anyone, `limited` → Humans, `hidden` → friends; inactive Humans invisible.                                                               |
| `canReadConversation` / `canSendMessage`    | `earth.can_view_conversation` (0260), `earth.assert_conversation_access` (0270) | Direct conversations are suppressed by a block; group coexistence (spec §56).                                                                       |
| `canPreviewInviteMember(viewer, member)`    | `group_invite_preview` sample filter (0185)                                     | `public` members, or friends of a Human viewer.                                                                                                     |
| `allowedReshareAudiences(source, policy)`   | spec §72                                                                        | Equal or narrower than the source; `none` allows nothing.                                                                                           |
| `canViewObject({ viewer, object, flags })`  | spec §71                                                                        | Dispatch on `object.type`.                                                                                                                          |

The `Viewer` (`src/types.ts`) carries only facts the database derives itself
(`earth.current_role_kind()`, `earth.relation_to`, `earth.is_blocked_either`, participant rows,
`human_context` containment). The mirror never infers one fact from another; an unknown fact is
left out and the answer fails closed.

## Fixtures rule (DB_API §11)

`fixtures/{post,room,profile,conversation,group_invite_preview}.json` are the single source of
truth for permission cases. Two tests consume every file:

- `src/fixtures.test.ts` (this package): asserts `canViewObject(...) === expect` for every case,
  plus `canJoinRoom` for room `join` probes and `canSendMessage` for conversation `send` probes.
- `supabase/tests/src/authz/permissions-fixtures.test.ts` (owned by the database tier): materializes
  the same cases in Postgres — creates the Humans, relationships, blocks, group memberships,
  participant rows, area context and the object — and asserts that the RLS select / `*_get` RPC
  outcome equals `expect`, that `room_join` succeeds or raises `join.reason`, and that
  `message_send` succeeds or raises `send.reason`.

Because both sides read one file, the mirror and the database cannot drift silently: a rule change
must update the fixture, and the other side's test fails until it follows.

### Format

```json
{
  "object": "post",
  "description": "...",
  "flags": { "publicWorldEnabled": true },
  "cases": [
    {
      "name": "human friend · elsewhere · friends post active",
      "viewer": {
        "kind": "human",
        "relationToAuthor": "friend",
        "sharedGroups": 0,
        "blockedEitherWay": false,
        "sameNeighborhood": false,
        "sameCity": false
      },
      "object": { "audience": "friends", "status": "active", "isReply": false },
      "flags": { "publicWorldEnabled": false },
      "expect": true,
      "join": {
        "mediaState": "camera",
        "consentLevel": "friends",
        "expect": false,
        "reason": "consent_required"
      },
      "send": { "expect": false, "reason": "blocked" }
    }
  ]
}
```

- `object` (file level) names the object type; each case's `object` omits `type`.
- `viewer` is a `Viewer` (`ViewerSchema`); absent booleans are `false`, absent
  `relationToAuthor` is `other`.
- `flags` (file or case level) override the launch defaults
  (`PUBLIC_WORLD_ENABLED`, `PUBLIC_LIVE_ENABLED`, `GUEST_ROOMS_ENABLED`, all on).
- `expect` is the view outcome. `join` (room files) and `send` (conversation files) are optional
  probes; `reason` is the `EarthErrorCode` when the probe expects a failure, else `null`.
- `sameNeighborhood` implies `sameCity` (a neighborhood lies inside its city), so the area matrix
  has three contexts: elsewhere, same city, same neighborhood.
- `blockedEitherWay` is only set for Human viewers (a caller without a Human id cannot be blocked)
  and never together with `relationToAuthor: 'self'`.
- Cases never use `kind: 'service'` (the service role bypasses RLS; the mirror answers `true`).

`src/fixtures.ts` exports `FixtureFileSchema`, `loadFixtureFile`, `loadAllFixtures` and
`resolveFixtureCase` so the database test validates and iterates the same way.

### Regenerating

```sh
pnpm --filter @earth/permissions run fixtures:generate
```

`scripts/generate-fixtures.ts` enumerates the matrices and computes `expect` from an oracle that
transcribes the prose of `docs/architecture/DB_API.md` — on purpose not by importing `src/`, so the
fixture test checks the mirror against an independent reading of the contract. Review every
changed expectation as a rule change: it needs a matching migration or mirror change, never a
weakened invariant (spec §128).

## Commands

```sh
pnpm --filter @earth/permissions run typecheck
pnpm --filter @earth/permissions run lint
pnpm --filter @earth/permissions run test
```
