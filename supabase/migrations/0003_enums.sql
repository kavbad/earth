-- 0003 — Postgres enum types (ARCHITECTURE §5, spec PART III).
--
-- Type names and value order are the contract: packages/domain/src/enums.ts (ENUM_REGISTRY) mirrors
-- them and supabase/tests/src/enum-parity.test.ts fails when the two drift. Add values with
-- `alter type ... add value` in a later migration and update the registry in the same change.

create type public.human_status as enum (
  'pending',
  'active',
  'restricted',
  'suspended',
  'deleted'
);

create type public.human_pass_status as enum (
  'unverified',
  'verifying',
  'verified',
  'review_required',
  'rejected'
);

create type public.relationship_type as enum (
  'follow',
  'friend_pending',
  'friend',
  'familiar_private'
);

create type public.group_kind as enum (
  'persistent',
  'temporary'
);

create type public.group_member_role as enum (
  'owner',
  'moderator',
  'member'
);

create type public.group_member_status as enum (
  'active',
  'left',
  'removed'
);

create type public.conversation_type as enum (
  'direct',
  'group'
);

create type public.message_type as enum (
  'text',
  'image',
  'video',
  'audio',
  'file',
  'poll',
  'system',
  'place',
  'plan'
);

create type public.post_type as enum (
  'text',
  'image',
  'video',
  'moment'
);

create type public.audience as enum (
  'friends',
  'neighborhood',
  'city',
  'world'
);

create type public.reply_policy as enum (
  'everyone_eligible',
  'friends',
  'mentioned',
  'none'
);

create type public.reshare_policy as enum (
  'allowed_within_audience',
  'none'
);

create type public.room_context_type as enum (
  'direct',
  'group',
  'event',
  'place',
  'standalone'
);

create type public.room_visibility as enum (
  'invited',
  'group',
  'friends',
  'extended',
  'neighborhood',
  'city',
  'world'
);

create type public.room_join_policy as enum (
  'invited_only',
  'group',
  'friends',
  'friends_of_friends',
  'request',
  'anyone_with_link',
  'anyone'
);

create type public.room_status as enum (
  'starting',
  'active',
  'ending',
  'ended'
);

create type public.area_precision as enum (
  'none',
  'city',
  'neighborhood',
  'place'
);

create type public.participant_role as enum (
  'initiator',
  'moderator',
  'participant',
  'viewer'
);

create type public.media_state as enum (
  'watching',
  'audio',
  'camera'
);

create type public.participant_status as enum (
  'invited',
  'waiting',
  'active',
  'left',
  'removed'
);

create type public.area_type as enum (
  'neighborhood',
  'city',
  'region',
  'country'
);

create type public.location_audience_type as enum (
  'friend',
  'group',
  'temporary_context'
);

create type public.location_precision as enum (
  'city',
  'approximate',
  'precise'
);

create type public.notification_priority as enum (
  'critical_social',
  'high',
  'normal',
  'low'
);

create type public.report_reason as enum (
  'harassment',
  'threats',
  'hate',
  'sexual_content',
  'exploitation_minor_safety',
  'impersonation',
  'spam_scam',
  'nonconsensual_imagery',
  'dangerous_location_stalking',
  'violence',
  'other'
);

create type public.report_status as enum (
  'open',
  'in_review',
  'resolved',
  'dismissed'
);

create type public.media_provenance as enum (
  'earth_capture',
  'uploaded',
  'edited',
  'unknown'
);

create type public.profile_visibility as enum (
  'public',
  'limited',
  'hidden'
);
