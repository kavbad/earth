-- 0950 — fix: blocks override every seat, link, preview and reply (spec §21, §56, §128; 0740 review).
--
-- supabase/tests/src/verify/social.test.ts reproduced four sequences that slipped past 0310 / 0330 /
-- 0270 although 0740 records "a blocked pair never shares a live room":
--
--   1. `earth.room_blocked_for` only looked at consenting camera/audio participants, so after A
--      blocked B, B could still discover and join (room_join, room_invite_join, RLS) a room where A
--      was merely watching — and A could join a room where B was watching — putting the pair face to
--      face; 0360 only separates them at block time. Any Human holding a live seat (`invited`,
--      `waiting`, `active`, whatever the media state) now makes the room not exist for a Human
--      blocked with them. Publishers are still what the friend-graph union of spec §58 is built on.
--   2. The same hole seated the blocked Human through a link into a direct room whose other member
--      only held an `invited` seat.
--   3. `room_invite_preview` named the inviter (`invitedByDisplayName`) and, through
--      `earth.room_context_title`, the members of a direct conversation to a viewer blocked with
--      them, while the participant list already hid them.
--   4. `message_send(reply_to_message_id)` accepted a reply to a message of a blocked Human inside a
--      shared group, although a reaction on the same message is refused (spec §56 "direct
--      visibility/interactions should be suppressed"). A before-insert trigger on `messages` now
--      raises `blocked` for a reply across a block, whatever RPC inserts the row.
--
-- Nothing else changes: signatures, grants and rate limits are the ones 0310 / 0330 / 0730 declare.

-- ---------------------------------------------------------------------------------------------------
-- 1 + 2. Any live seat of a blocked Human hides the room (earth.room_visible_to, earth.notify_live,
--        the link path of earth.room_join_human all go through this helper).
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_blocked_for(p_room_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_viewer is not null and exists (
    select 1
      from public.room_participants rp
     where rp.room_id = p_room_id
       and rp.human_id is not null
       and rp.human_id <> p_viewer
       and rp.status in ('invited', 'waiting', 'active')
       and earth.is_blocked_either(p_viewer, rp.human_id)
  )
$$;

-- ---------------------------------------------------------------------------------------------------
-- 3. Names of a direct conversation's members are never rendered to a viewer blocked with them.
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_context_title(p_room_id uuid, p_viewer uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_names text[];
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return null;
  end if;
  if v_room.context_type = 'group' then
    return (select g.name from public.groups g where g.id = v_room.context_id);
  end if;
  if v_room.context_type = 'direct' then
    select coalesce(array_agg(p.display_name order by cm.joined_at, cm.human_id), '{}'::text[])
      into v_names
      from public.conversation_members cm
      join public.public_identities p on p.human_id = cm.human_id
     where cm.conversation_id = v_room.context_id
       and cm.human_id is distinct from p_viewer
       and not earth.is_blocked_either(p_viewer, cm.human_id);
    return nullif(earth.live_name_list(v_names), '');
  end if;
  return null;
end
$$;

-- Same body as 0330 except `invitedByDisplayName`, which is null across a block.
create or replace function public.room_invite_preview(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.current_human();
  v_invite public.room_invites%rowtype;
  v_room public.rooms%rowtype;
  v_usability text;
  v_policy public.room_join_policy;
  v_participants jsonb;
begin
  perform earth.rate_limit_for_caller('room_invite_preview', 60, 60);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_invite from public.room_invites ri where ri.token_hash = earth.sha256_hex(token);
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_room from public.rooms r where r.id = v_invite.room_id;
  v_usability := earth.room_invite_usability(v_invite, v_room.status);
  v_policy := coalesce(v_invite.join_policy_override, v_room.join_policy);

  select coalesce(jsonb_agg(jsonb_build_object(
           'displayName', coalesce(p.display_name, gs.display_name, rp.display_name_snapshot, 'Earth member'),
           'avatarUrl', earth.public_media_url(p.avatar_media_id),
           'isGuest', rp.guest_session_id is not null
         ) order by rp.joined_at, rp.id), '[]'::jsonb)
    into v_participants
    from public.room_participants rp
    left join public.public_identities p on p.human_id = rp.human_id
    left join public.guest_sessions gs on gs.id = rp.guest_session_id
   where rp.room_id = v_room.id
     and rp.status = 'active'
     and rp.media_state <> 'watching'
     and not earth.is_blocked_either(v_viewer, rp.human_id);

  return jsonb_build_object(
    'roomId', v_room.id,
    'contextTitle', earth.room_context_title(v_room.id, v_viewer),
    'visibility', v_room.visibility,
    'joinPolicy', v_policy,
    'participants', v_participants,
    'invitedByDisplayName', case
                              when earth.is_blocked_either(v_viewer, v_invite.created_by_human_id) then null
                              else earth.display_name_of(v_invite.created_by_human_id)
                            end,
    'guestsAllowed', earth.flag('GUEST_ROOMS_ENABLED') and not v_room.guests_disabled and v_usability = 'ok',
    'ended', v_usability <> 'ok'
  );
end
$$;

revoke execute on function public.room_invite_preview(text) from public;
grant execute on function public.room_invite_preview(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 4. A reply is a direct interaction: never across a block, in any conversation.
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.messages_reply_block_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_parent_sender uuid;
begin
  if new.reply_to_message_id is null or new.sender_human_id is null then
    return new;
  end if;
  select m.sender_human_id into v_parent_sender
    from public.messages m
   where m.id = new.reply_to_message_id;
  if v_parent_sender is not null
     and v_parent_sender <> new.sender_human_id
     and earth.is_blocked_either(new.sender_human_id, v_parent_sender) then
    perform earth.raise('blocked');
  end if;
  return new;
end
$$;

revoke execute on function earth.messages_reply_block_trigger() from public, anon, authenticated;

create trigger messages_reply_block
  before insert on public.messages
  for each row execute function earth.messages_reply_block_trigger();

-- Fail loudly if a later range drops what this fix depends on.
do $$
begin
  if to_regprocedure('earth.room_blocked_for(uuid, uuid)') is null
     or to_regprocedure('earth.room_context_title(uuid, uuid)') is null
     or to_regprocedure('earth.messages_reply_block_trigger()') is null then
    raise exception '0950: block override primitives missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.messages'::regclass and t.tgname = 'messages_reply_block' and not t.tgisinternal
  ) then
    raise exception '0950: trigger messages_reply_block on public.messages is missing';
  end if;
end
$$;
