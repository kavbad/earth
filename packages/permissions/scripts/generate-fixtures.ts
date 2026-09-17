/**
 * Writes `packages/permissions/fixtures/*.json` (DB_API §11 format).
 *
 * The expectations are computed by the ORACLE below, a direct transcription of the prose rules of
 * DB_API.md (§1 RLS summary, §2 group_invite_preview / message_send, §3 room_visible_to and
 * room_join, §4 Visibility) — deliberately not by importing the mirror in `../src`, so the
 * fixture-driven test in `src/fixtures.test.ts` checks the mirror against an independent reading
 * of the contract, and `supabase/tests` checks the database against the same file.
 *
 * Regenerate with `pnpm --filter @earth/permissions run fixtures:generate` and review the diff:
 * a changed expectation is a changed rule, and needs a matching migration or mirror change.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  AUDIENCE,
  HUMAN_STATUS,
  PROFILE_VISIBILITY,
  ROOM_JOIN_POLICY,
  ROOM_VISIBILITY,
  VIEWER_RELATIONS,
  allowedJoinPoliciesFor,
  visibilityRank,
  type Audience,
  type ConversationType,
  type EarthErrorCode,
  type HumanStatus,
  type MediaState,
  type ProfileVisibility,
  type RoleKind,
  type RoomJoinPolicy,
  type RoomStatus,
  type RoomVisibility,
  type ViewerRelation,
} from '@earth/domain'

// ---------------------------------------------------------------------------
// Fixture shapes (kept structural here; `src/fixtures.ts` is the validating schema)
// ---------------------------------------------------------------------------

interface Viewer {
  kind: RoleKind
  relationToAuthor?: ViewerRelation
  sharedGroups?: number
  blockedEitherWay: boolean
  isGroupMember?: boolean
  isConversationMember?: boolean
  isInvitedParticipant?: boolean
  hasLink?: boolean
  isFriendOfConsentingParticipant?: boolean
  isFriendOfFriendOfConsentingParticipant?: boolean
  sameNeighborhood?: boolean
  sameCity?: boolean
}

interface Flags {
  publicWorldEnabled: boolean
  publicLiveEnabled: boolean
  guestRoomsEnabled: boolean
}

const LAUNCH_FLAGS: Flags = {
  publicWorldEnabled: true,
  publicLiveEnabled: true,
  guestRoomsEnabled: true,
}

interface JoinProbe {
  mediaState: MediaState
  consentLevel: RoomVisibility
  expect: boolean
  reason: EarthErrorCode | null
  requiresApproval?: boolean
}

interface SendProbe {
  expect: boolean
  reason: EarthErrorCode | null
}

interface Case {
  name: string
  viewer: Viewer
  object: Record<string, unknown>
  flags?: Partial<Flags>
  expect: boolean
  join?: JoinProbe
  send?: SendProbe
}

interface File {
  object: 'post' | 'room' | 'profile' | 'conversation' | 'group_invite_preview'
  description: string
  cases: Case[]
}

// ---------------------------------------------------------------------------
// ORACLE — DB_API.md transcribed
// ---------------------------------------------------------------------------

/** DB_API §4 "Visibility". */
function oraclePost(
  v: Viewer,
  o: {
    audience: Audience
    status: 'active' | 'removed'
    isReply: boolean
    rootAudience?: Audience
  },
  flags: Flags,
): boolean {
  // author self → true
  if (v.kind === 'human' && v.relationToAuthor === 'self') return true
  // status='active'
  if (o.status !== 'active') return false
  // blocked either way → false
  if (v.blockedEitherWay) return false
  // Replies use the root post's audience.
  const audience = o.isReply ? (o.rootAudience ?? o.audience) : o.audience
  const human = v.kind === 'human'
  const friend = human && v.relationToAuthor === 'friend'
  switch (audience) {
    // friends → friends only
    case 'friends':
      return friend
    // neighborhood → viewer's current_area_id equals or is inside posts.area_id, or friends
    case 'neighborhood':
      return friend || (human && v.sameNeighborhood === true)
    // city → viewer's current or home city equals post city, or friends
    case 'city':
      return friend || (human && (v.sameCity === true || v.sameNeighborhood === true))
    // world → anyone (visitors included when PUBLIC_WORLD_ENABLED)
    case 'world':
      return human || flags.publicWorldEnabled
  }
}

interface RoomObject {
  visibility: RoomVisibility
  joinPolicy: RoomJoinPolicy
  status: RoomStatus
  guestsDisabled: boolean
}

/** DB_API §3 "RLS summary" + `earth.room_visible_to`. */
function oracleRoomView(v: Viewer, r: RoomObject, flags: Flags): boolean {
  const live = r.status === 'starting' || r.status === 'active'
  const friend = v.isFriendOfConsentingParticipant === true
  const fof = friend || v.isFriendOfFriendOfConsentingParticipant === true
  switch (v.kind) {
    case 'service':
      return true
    case 'visitor':
    case 'claiming':
      // visitors: world only when PUBLIC_LIVE_ENABLED
      return live && r.visibility === 'world' && flags.publicLiveEnabled
    case 'guest':
      // guests: only their room (a session; or a link that can still create one)
      if (v.isInvitedParticipant === true) return !r.guestsDisabled
      return (
        v.hasLink === true &&
        flags.guestRoomsEnabled &&
        r.status !== 'ended' &&
        !r.guestsDisabled &&
        !v.blockedEitherWay
      )
    case 'human': {
      // caller is/was a participant
      if (v.isInvitedParticipant === true) return true
      // blocked with any consenting camera/audio participant → not visible
      if (v.blockedEitherWay) return false
      // group member for group rooms
      if (v.isGroupMember === true) return true
      if (!live) return false
      const reach: Record<RoomVisibility, boolean> = {
        invited: false,
        group: false,
        friends: friend,
        extended: fof,
        neighborhood: fof || v.sameNeighborhood === true,
        city: fof || v.sameCity === true || v.sameNeighborhood === true,
        world: true,
      }
      return reach[r.visibility]
    }
  }
}

/** DB_API §3 `room_join` / `room_invite_join` / `guest_session_create`. */
function oracleRoomJoin(
  v: Viewer,
  r: RoomObject,
  mediaState: MediaState,
  consentLevel: RoomVisibility,
  flags: Flags,
): JoinProbe {
  const probe = (
    expect: boolean,
    reason: EarthErrorCode | null,
    requiresApproval = false,
  ): JoinProbe =>
    requiresApproval
      ? { mediaState, consentLevel, expect, reason, requiresApproval }
      : { mediaState, consentLevel, expect, reason }
  if (v.kind === 'visitor') return probe(false, 'not_authenticated')
  if (v.kind === 'claiming' || v.kind === 'service') return probe(false, 'not_a_human')
  if (v.kind === 'guest') {
    if (v.isInvitedParticipant === true) {
      if (r.status === 'ended') return probe(false, 'room_ended')
      if (r.guestsDisabled) return probe(false, 'guests_disabled')
      return probe(true, null)
    }
    if (v.hasLink !== true) return probe(false, 'guest_not_allowed')
    if (!flags.guestRoomsEnabled) return probe(false, 'feature_disabled')
    if (r.status === 'ended') return probe(false, 'room_ended')
    if (r.guestsDisabled) return probe(false, 'guests_disabled')
    if (v.blockedEitherWay) return probe(false, 'blocked')
    return probe(true, null)
  }
  // human
  const reachable = oracleRoomView(v, r, flags) || (v.hasLink === true && !v.blockedEitherWay)
  if (!reachable) return probe(false, 'room_not_found')
  if (r.status === 'ended') return probe(false, 'room_ended')
  if (mediaState === 'watching') return probe(true, null)
  const invited = v.hasLink === true || v.isInvitedParticipant === true
  const member = v.isGroupMember === true
  const friend = v.isFriendOfConsentingParticipant === true
  const fof = friend || v.isFriendOfFriendOfConsentingParticipant === true
  const admitted: Record<RoomJoinPolicy, boolean> = {
    invited_only: invited,
    group: invited || member,
    friends: invited || member || friend,
    friends_of_friends: invited || member || fof,
    request: true,
    anyone_with_link: invited,
    anyone: true,
  }
  if (!admitted[r.joinPolicy]) return probe(false, 'join_not_allowed')
  if (visibilityRank(consentLevel) < visibilityRank(r.visibility)) {
    return probe(false, 'consent_required')
  }
  return probe(true, null, r.joinPolicy === 'request' && !(invited || member))
}

/** DB_API §1 `public_identities` RLS / `profile_get`. */
function oracleProfile(
  v: Viewer,
  p: { profileVisibility: ProfileVisibility; humanStatus: HumanStatus },
): boolean {
  if ((v.kind === 'human' || v.kind === 'claiming') && v.relationToAuthor === 'self') return true
  if (p.humanStatus !== 'active') return false
  if (v.blockedEitherWay) return false
  const rule: Record<ProfileVisibility, boolean> = {
    public: true,
    limited: v.kind === 'human',
    hidden: v.kind === 'human' && v.relationToAuthor === 'friend',
  }
  return rule[p.profileVisibility]
}

/** DB_API §2 `messages` RLS / `message_send`. */
function oracleConversation(
  v: Viewer,
  c: { conversationType: ConversationType },
): { read: boolean; send: SendProbe } {
  const blockedDirect = c.conversationType === 'direct' && v.blockedEitherWay
  const member = v.isConversationMember === true
  const read = v.kind === 'human' && member && !blockedDirect
  let send: SendProbe
  if (v.kind === 'visitor') send = { expect: false, reason: 'not_authenticated' }
  else if (v.kind !== 'human') send = { expect: false, reason: 'not_a_human' }
  else if (!member) send = { expect: false, reason: 'conversation_not_found' }
  else if (blockedDirect) send = { expect: false, reason: 'blocked' }
  else send = { expect: true, reason: null }
  return { read, send }
}

/** DB_API §2 `group_invite_preview` sample members. */
function oracleInvitePreview(
  v: Viewer,
  m: { profileVisibility: ProfileVisibility; isFriendOfViewer: boolean; humanStatus: HumanStatus },
): boolean {
  if (m.humanStatus !== 'active') return false
  if (v.relationToAuthor === 'self') return false
  if (v.blockedEitherWay) return false
  if (m.profileVisibility === 'public') return true
  return v.kind === 'human' && (m.isFriendOfViewer || v.relationToAuthor === 'friend')
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

const ANONYMOUS_KINDS: readonly RoleKind[] = ['visitor', 'guest', 'claiming']

interface AreaContext {
  label: string
  sameNeighborhood: boolean
  sameCity: boolean
}

/** `sameNeighborhood` implies `sameCity` (a neighborhood lies in its city), so three contexts. */
const AREA_CONTEXTS: readonly AreaContext[] = [
  { label: 'elsewhere', sameNeighborhood: false, sameCity: false },
  { label: 'same city', sameNeighborhood: false, sameCity: true },
  { label: 'same neighborhood', sameNeighborhood: true, sameCity: true },
]

function humanViewer(relation: ViewerRelation, blocked: boolean, area?: AreaContext): Viewer {
  const viewer: Viewer = {
    kind: 'human',
    relationToAuthor: relation,
    sharedGroups: relation === 'shared_group' ? 1 : 0,
    blockedEitherWay: blocked,
  }
  if (area !== undefined) {
    viewer.sameNeighborhood = area.sameNeighborhood
    viewer.sameCity = area.sameCity
  }
  return viewer
}

function anonymousViewer(kind: RoleKind): Viewer {
  return { kind, blockedEitherWay: false }
}

function relationLabel(relation: ViewerRelation, blocked: boolean): string {
  return `${relation}${blocked ? ' blocked' : ''}`
}

/** Relation × block, without the impossible self × blocked. */
function relationBlockPairs(): ReadonlyArray<readonly [ViewerRelation, boolean]> {
  const pairs: Array<readonly [ViewerRelation, boolean]> = []
  for (const relation of VIEWER_RELATIONS) {
    pairs.push([relation, false])
    if (relation !== 'self') pairs.push([relation, true])
  }
  return pairs
}

// ---- post ------------------------------------------------------------------

function postCases(): Case[] {
  const cases: Case[] = []
  const statuses = ['active', 'removed'] as const
  const push = (
    name: string,
    viewer: Viewer,
    object: {
      audience: Audience
      status: 'active' | 'removed'
      isReply: boolean
      rootAudience?: Audience
      hiddenByViewer?: boolean
    },
    flags?: Partial<Flags>,
  ) => {
    const resolved = { ...LAUNCH_FLAGS, ...flags }
    const c: Case = { name, viewer, object, expect: oraclePost(viewer, object, resolved) }
    if (flags !== undefined) c.flags = flags
    cases.push(c)
  }

  for (const kind of ANONYMOUS_KINDS) {
    for (const audience of AUDIENCE) {
      for (const status of statuses) {
        push(`${kind} · ${audience} post ${status}`, anonymousViewer(kind), {
          audience,
          status,
          isReply: false,
        })
      }
      push(`${kind} · reply in ${audience} thread`, anonymousViewer(kind), {
        audience,
        status: 'active',
        isReply: true,
        rootAudience: audience,
      })
    }
    push(
      `${kind} · world post while PUBLIC_WORLD_ENABLED off`,
      anonymousViewer(kind),
      {
        audience: 'world',
        status: 'active',
        isReply: false,
      },
      { publicWorldEnabled: false },
    )
  }

  for (const [relation, blocked] of relationBlockPairs()) {
    for (const area of AREA_CONTEXTS) {
      for (const audience of AUDIENCE) {
        for (const status of statuses) {
          push(
            `human ${relationLabel(relation, blocked)} · ${area.label} · ${audience} post ${status}`,
            humanViewer(relation, blocked, area),
            { audience, status, isReply: false },
          )
        }
      }
    }
  }
  push(
    'human friend · world post while PUBLIC_WORLD_ENABLED off',
    humanViewer('friend', false, AREA_CONTEXTS[0]),
    {
      audience: 'world',
      status: 'active',
      isReply: false,
    },
    { publicWorldEnabled: false },
  )
  push(
    'human other · world post while PUBLIC_WORLD_ENABLED off',
    humanViewer('other', false, AREA_CONTEXTS[0]),
    {
      audience: 'world',
      status: 'active',
      isReply: false,
    },
    { publicWorldEnabled: false },
  )

  // Replies: gated by the ROOT audience (spec §72); the reply's own audience is ≤ root.
  for (const relation of ['friend', 'other'] as const) {
    for (const area of AREA_CONTEXTS) {
      for (const rootAudience of AUDIENCE) {
        for (const audience of AUDIENCE) {
          if (AUDIENCE.indexOf(audience) > AUDIENCE.indexOf(rootAudience)) continue
          push(
            `human ${relation} · ${area.label} · ${audience} reply in ${rootAudience} thread`,
            humanViewer(relation, false, area),
            { audience, status: 'active', isReply: true, rootAudience },
          )
        }
      }
    }
  }

  // Hides are a feed concern: a direct fetch still answers as for the unhidden post (DB_API §4).
  for (const relation of ['friend', 'other'] as const) {
    for (const audience of ['friends', 'world'] as const) {
      push(
        `human ${relation} · elsewhere · ${audience} post hidden by viewer (direct fetch)`,
        humanViewer(relation, false, AREA_CONTEXTS[0]),
        { audience, status: 'active', isReply: false, hiddenByViewer: true },
      )
    }
  }
  return cases
}

// ---- room ------------------------------------------------------------------

interface RoomProfile {
  label: string
  viewer: Viewer
}

const HUMAN_ROOM_PROFILES: readonly RoomProfile[] = [
  {
    label: 'stranger',
    viewer: { kind: 'human', relationToAuthor: 'other', blockedEitherWay: false },
  },
  {
    label: 'invited participant',
    viewer: {
      kind: 'human',
      relationToAuthor: 'other',
      blockedEitherWay: false,
      isInvitedParticipant: true,
    },
  },
  {
    label: 'link holder',
    viewer: { kind: 'human', relationToAuthor: 'other', blockedEitherWay: false, hasLink: true },
  },
  {
    label: 'group member',
    viewer: {
      kind: 'human',
      relationToAuthor: 'shared_group',
      sharedGroups: 1,
      blockedEitherWay: false,
      isGroupMember: true,
    },
  },
  {
    label: 'friend of participant',
    viewer: {
      kind: 'human',
      relationToAuthor: 'friend',
      blockedEitherWay: false,
      isFriendOfConsentingParticipant: true,
    },
  },
  {
    label: 'friend of friend',
    viewer: {
      kind: 'human',
      relationToAuthor: 'other',
      blockedEitherWay: false,
      isFriendOfFriendOfConsentingParticipant: true,
    },
  },
  {
    label: 'same neighborhood',
    viewer: {
      kind: 'human',
      relationToAuthor: 'other',
      blockedEitherWay: false,
      sameNeighborhood: true,
      sameCity: true,
    },
  },
  {
    label: 'same city',
    viewer: { kind: 'human', relationToAuthor: 'other', blockedEitherWay: false, sameCity: true },
  },
  {
    label: 'blocked friend',
    viewer: {
      kind: 'human',
      relationToAuthor: 'friend',
      blockedEitherWay: true,
      isFriendOfConsentingParticipant: true,
    },
  },
  {
    label: 'blocked group member',
    viewer: {
      kind: 'human',
      relationToAuthor: 'shared_group',
      sharedGroups: 1,
      blockedEitherWay: true,
      isGroupMember: true,
    },
  },
  {
    label: 'blocked link holder',
    viewer: { kind: 'human', relationToAuthor: 'other', blockedEitherWay: true, hasLink: true },
  },
]

const GUEST_ROOM_PROFILES: readonly RoomProfile[] = [
  { label: 'guest with link', viewer: { kind: 'guest', blockedEitherWay: false, hasLink: true } },
  {
    label: 'guest with session',
    viewer: { kind: 'guest', blockedEitherWay: false, hasLink: true, isInvitedParticipant: true },
  },
  { label: 'guest without link', viewer: { kind: 'guest', blockedEitherWay: false } },
  {
    label: 'blocked guest with link',
    viewer: { kind: 'guest', blockedEitherWay: true, hasLink: true },
  },
]

function roomCases(): Case[] {
  const cases: Case[] = []
  const push = (
    name: string,
    viewer: Viewer,
    room: RoomObject,
    probe: { mediaState: MediaState; consentLevel: RoomVisibility } | null,
    flags?: Partial<Flags>,
  ) => {
    const resolved = { ...LAUNCH_FLAGS, ...flags }
    const c: Case = {
      name,
      viewer,
      object: { ...room },
      expect: oracleRoomView(viewer, room, resolved),
    }
    if (flags !== undefined) c.flags = flags
    if (probe !== null) {
      c.join = oracleRoomJoin(viewer, room, probe.mediaState, probe.consentLevel, resolved)
    }
    cases.push(c)
  }
  const roomOf = (
    visibility: RoomVisibility,
    joinPolicy: RoomJoinPolicy,
    status: RoomStatus = 'active',
    guestsDisabled = false,
  ): RoomObject => ({
    visibility,
    joinPolicy,
    status,
    guestsDisabled,
  })
  const defaultPolicy = (visibility: RoomVisibility): RoomJoinPolicy => {
    const policy = allowedJoinPoliciesFor(visibility)[0]
    if (policy === undefined) throw new Error(`no join policy for ${visibility}`)
    return policy
  }

  for (const visibility of ROOM_VISIBILITY) {
    for (const kind of ['visitor', 'claiming'] as const) {
      push(
        `${kind} · ${visibility} room · watch`,
        anonymousViewer(kind),
        roomOf(visibility, defaultPolicy(visibility)),
        {
          mediaState: 'watching',
          consentLevel: 'invited',
        },
      )
    }
    for (const profile of GUEST_ROOM_PROFILES) {
      push(
        `${profile.label} · ${visibility} room · join audio`,
        profile.viewer,
        roomOf(visibility, defaultPolicy(visibility)),
        {
          mediaState: 'audio',
          consentLevel: visibility,
        },
      )
    }
    push(
      `guest with link · ${visibility} room, guests disabled · join audio`,
      GUEST_ROOM_PROFILES[0]!.viewer,
      roomOf(visibility, defaultPolicy(visibility), 'active', true),
      {
        mediaState: 'audio',
        consentLevel: visibility,
      },
    )
    push(
      `guest with session · ${visibility} room, guests disabled · join audio`,
      GUEST_ROOM_PROFILES[1]!.viewer,
      roomOf(visibility, defaultPolicy(visibility), 'active', true),
      {
        mediaState: 'audio',
        consentLevel: visibility,
      },
    )
  }
  push(
    'visitor · world room while PUBLIC_LIVE_ENABLED off · watch',
    anonymousViewer('visitor'),
    roomOf('world', 'anyone'),
    {
      mediaState: 'watching',
      consentLevel: 'invited',
    },
    { publicLiveEnabled: false },
  )
  push(
    'claiming · world room while PUBLIC_LIVE_ENABLED off · watch',
    anonymousViewer('claiming'),
    roomOf('world', 'anyone'),
    {
      mediaState: 'watching',
      consentLevel: 'invited',
    },
    { publicLiveEnabled: false },
  )
  for (const visibility of ['invited', 'friends', 'world'] as const) {
    push(
      `guest with link · ${visibility} room while GUEST_ROOMS_ENABLED off · join audio`,
      GUEST_ROOM_PROFILES[0]!.viewer,
      roomOf(visibility, defaultPolicy(visibility)),
      {
        mediaState: 'audio',
        consentLevel: visibility,
      },
      { guestRoomsEnabled: false },
    )
  }

  for (const profile of HUMAN_ROOM_PROFILES) {
    for (const visibility of ROOM_VISIBILITY) {
      push(
        `${profile.label} · ${visibility} room · watch`,
        profile.viewer,
        roomOf(visibility, defaultPolicy(visibility)),
        {
          mediaState: 'watching',
          consentLevel: 'invited',
        },
      )
      for (const joinPolicy of ROOM_JOIN_POLICY) {
        push(
          `${profile.label} · ${visibility} room, ${joinPolicy} · join camera consenting ${visibility}`,
          profile.viewer,
          roomOf(visibility, joinPolicy),
          {
            mediaState: 'camera',
            consentLevel: visibility,
          },
        )
        if (
          visibility !== 'invited' &&
          (joinPolicy === 'anyone' || joinPolicy === 'invited_only')
        ) {
          push(
            `${profile.label} · ${visibility} room, ${joinPolicy} · join camera without consent`,
            profile.viewer,
            roomOf(visibility, joinPolicy),
            {
              mediaState: 'camera',
              consentLevel: 'invited',
            },
          )
        }
      }
    }
    for (const visibility of ['friends', 'world'] as const) {
      push(
        `${profile.label} · ended ${visibility} room · watch`,
        profile.viewer,
        roomOf(visibility, defaultPolicy(visibility), 'ended'),
        {
          mediaState: 'watching',
          consentLevel: 'invited',
        },
      )
    }
    push(
      `${profile.label} · starting world room · watch`,
      profile.viewer,
      roomOf('world', 'anyone', 'starting'),
      {
        mediaState: 'watching',
        consentLevel: 'invited',
      },
    )
  }
  return cases
}

// ---- profile ---------------------------------------------------------------

function profileCases(): Case[] {
  const cases: Case[] = []
  const push = (
    name: string,
    viewer: Viewer,
    object: { profileVisibility: ProfileVisibility; humanStatus: HumanStatus },
  ) => {
    cases.push({ name, viewer, object, expect: oracleProfile(viewer, object) })
  }
  for (const kind of ANONYMOUS_KINDS) {
    for (const profileVisibility of PROFILE_VISIBILITY) {
      for (const humanStatus of HUMAN_STATUS) {
        push(
          `${kind} · ${profileVisibility} profile of ${humanStatus} human`,
          anonymousViewer(kind),
          { profileVisibility, humanStatus },
        )
      }
    }
  }
  for (const profileVisibility of PROFILE_VISIBILITY) {
    push(
      `claiming self · own ${profileVisibility} profile while pending`,
      { kind: 'claiming', relationToAuthor: 'self', blockedEitherWay: false },
      {
        profileVisibility,
        humanStatus: 'pending',
      },
    )
  }
  for (const [relation, blocked] of relationBlockPairs()) {
    for (const profileVisibility of PROFILE_VISIBILITY) {
      for (const humanStatus of HUMAN_STATUS) {
        push(
          `human ${relationLabel(relation, blocked)} · ${profileVisibility} profile of ${humanStatus} human`,
          humanViewer(relation, blocked),
          { profileVisibility, humanStatus },
        )
      }
    }
  }
  return cases
}

// ---- conversation ----------------------------------------------------------

function conversationCases(): Case[] {
  const cases: Case[] = []
  const push = (name: string, viewer: Viewer, object: { conversationType: ConversationType }) => {
    const { read, send } = oracleConversation(viewer, object)
    cases.push({ name, viewer, object, expect: read, send })
  }
  for (const conversationType of ['direct', 'group'] as const) {
    for (const kind of ANONYMOUS_KINDS) {
      push(`${kind} · ${conversationType} conversation`, anonymousViewer(kind), {
        conversationType,
      })
    }
    for (const member of [false, true]) {
      for (const blocked of [false, true]) {
        const viewer: Viewer = {
          kind: 'human',
          relationToAuthor: 'other',
          blockedEitherWay: blocked,
          isConversationMember: member,
        }
        push(
          `human ${member ? 'member' : 'non-member'}${blocked ? ' blocked' : ''} · ${conversationType} conversation`,
          viewer,
          { conversationType },
        )
      }
    }
    push(
      `human friend member · ${conversationType} conversation`,
      {
        kind: 'human',
        relationToAuthor: 'friend',
        blockedEitherWay: false,
        isConversationMember: true,
      },
      { conversationType },
    )
  }
  return cases
}

// ---- group_invite_preview --------------------------------------------------

function invitePreviewCases(): Case[] {
  const cases: Case[] = []
  const push = (
    name: string,
    viewer: Viewer,
    object: {
      profileVisibility: ProfileVisibility
      isFriendOfViewer: boolean
      humanStatus: HumanStatus
    },
  ) => {
    cases.push({ name, viewer, object, expect: oracleInvitePreview(viewer, object) })
  }
  const statuses: readonly HumanStatus[] = ['active', 'pending', 'suspended']
  for (const kind of ANONYMOUS_KINDS) {
    for (const profileVisibility of PROFILE_VISIBILITY) {
      for (const humanStatus of statuses) {
        push(`${kind} · ${profileVisibility} ${humanStatus} member`, anonymousViewer(kind), {
          profileVisibility,
          isFriendOfViewer: false,
          humanStatus,
        })
      }
    }
  }
  for (const profileVisibility of PROFILE_VISIBILITY) {
    for (const isFriendOfViewer of [false, true]) {
      for (const blocked of [false, true]) {
        for (const humanStatus of statuses) {
          const viewer = humanViewer(isFriendOfViewer ? 'friend' : 'other', blocked)
          push(
            `human ${isFriendOfViewer ? 'friend' : 'stranger'}${blocked ? ' blocked' : ''} · ${profileVisibility} ${humanStatus} member`,
            viewer,
            { profileVisibility, isFriendOfViewer, humanStatus },
          )
        }
      }
    }
    push(`human self · own ${profileVisibility} membership`, humanViewer('self', false), {
      profileVisibility,
      isFriendOfViewer: false,
      humanStatus: 'active',
    })
    push(
      `human shared_group · ${profileVisibility} active member`,
      humanViewer('shared_group', false),
      { profileVisibility, isFriendOfViewer: false, humanStatus: 'active' },
    )
  }
  return cases
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const FILES: readonly File[] = [
  {
    object: 'post',
    description:
      'earth.can_view_post: audience × relation × block × area context × caller kind × status; replies gated by the root audience; hides never deny a direct fetch.',
    cases: postCases(),
  },
  {
    object: 'room',
    description:
      'earth.room_visible_to (expect) and room_join / room_invite_join / guest_session_create (join): visibility × join policy × relation flags × media state × consent × block × status.',
    cases: roomCases(),
  },
  {
    object: 'profile',
    description:
      'earth.identity_visible_to / profile_get: profile_visibility × relation × block × human status × caller kind.',
    cases: profileCases(),
  },
  {
    object: 'conversation',
    description:
      'earth.can_view_conversation (expect) and message_send (send): conversation type × membership × block × caller kind.',
    cases: conversationCases(),
  },
  {
    object: 'group_invite_preview',
    description:
      'group_invite_preview sample members: profile_visibility × friendship × block × member status × caller kind.',
    cases: invitePreviewCases(),
  },
]

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))
mkdirSync(FIXTURES_DIR, { recursive: true })
for (const file of FILES) {
  const names = new Set<string>()
  for (const c of file.cases) {
    if (names.has(c.name)) throw new Error(`${file.object}: duplicate case name "${c.name}"`)
    names.add(c.name)
  }
  const path = `${FIXTURES_DIR}${file.object}.json`
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  const allowed = file.cases.filter((c) => c.expect).length
  console.log(`${file.object}.json: ${file.cases.length} cases (${allowed} visible)`)
}
