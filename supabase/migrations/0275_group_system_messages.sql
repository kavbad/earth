-- 0275 — system messages for group joins and leaves (DB_API §2 `group_invite_join` "a system
-- message '<name> joined' is inserted"; spec §27).
--
-- Replaces, with identical signatures, `earth.group_invite_join_internal` (the join path shared by
-- `group_invite_join` and `claim_complete`), `public.group_invite_join` and `public.group_leave`
-- from 0185 so both events go through `earth.system_message(conversation, text, payload, actor)`
-- of 0270 with a typed payload (`kind`, `actorHumanId`). The leave line is written while the leaver
-- is still a conversation member; the insert trigger (0250) bumps unread counts for everyone else.

create or replace function earth.group_invite_join_internal(
  p_human_id uuid,
  p_token_hash text,
  out out_group_id uuid,
  out out_conversation_id uuid,
  out out_already_member boolean,
  out out_is_second_group boolean
)
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_invite public.group_invites%rowtype;
  v_member public.group_members%rowtype;
begin
  if p_human_id is null then
    perform earth.raise('invalid_input', 'group_invite_join_internal: human id required');
  end if;
  v_invite := earth.assert_group_invite_usable(p_token_hash);
  out_group_id := v_invite.group_id;
  select c.id into out_conversation_id from public.conversations c where c.group_id = out_group_id;
  if out_conversation_id is null then
    perform earth.raise('internal', 'group without a canonical conversation');
  end if;

  out_is_second_group := exists (
    select 1 from public.group_members gm
     where gm.human_id = p_human_id and gm.status = 'active' and gm.group_id <> out_group_id
  );

  select * into v_member
    from public.group_members gm
   where gm.group_id = out_group_id and gm.human_id = p_human_id
   for update;

  if found and v_member.status = 'active' then
    out_already_member := true;
    insert into public.conversation_members (conversation_id, human_id)
    values (out_conversation_id, p_human_id)
    on conflict on constraint conversation_members_pkey do nothing;
    return;
  end if;
  if found and v_member.status = 'removed' then
    perform earth.raise('join_not_allowed');
  end if;

  out_already_member := false;
  if found then
    update public.group_members gm
       set status = 'active', role = 'member', joined_at = now(), left_at = null, removed_by_human_id = null
     where gm.group_id = out_group_id and gm.human_id = p_human_id;
  else
    insert into public.group_members (group_id, human_id, role, status)
    values (out_group_id, p_human_id, 'member', 'active');
  end if;

  insert into public.conversation_members (conversation_id, human_id)
  values (out_conversation_id, p_human_id)
  on conflict on constraint conversation_members_pkey do nothing;

  update public.group_invites gi
     set use_count = gi.use_count + 1,
         status = case
                    when gi.max_uses is not null and gi.use_count + 1 >= gi.max_uses then 'exhausted'
                    else gi.status
                  end
   where gi.id = v_invite.id;

  update public.groups g set last_activity_at = now() where g.id = out_group_id;

  perform earth.system_message(
    out_conversation_id,
    coalesce(earth.display_name_of(p_human_id), 'Someone') || ' joined',
    jsonb_build_object('kind', 'member_joined', 'actorHumanId', p_human_id),
    p_human_id
  );
end
$$;

create or replace function public.group_invite_join(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group_id uuid;
  v_conversation_id uuid;
  v_already boolean;
  v_second boolean;
begin
  perform earth.rate_limit_for_caller('group_invite_join', 10, 600);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  -- The "<name> joined" system message is written by earth.group_invite_join_internal (above).
  select * into v_group_id, v_conversation_id, v_already, v_second
    from earth.group_invite_join_internal(v_me, earth.sha256_hex(token));
  return jsonb_build_object(
    'groupId', v_group_id,
    'conversationId', v_conversation_id,
    'alreadyMember', v_already,
    'isSecondGroup', v_second
  );
end
$$;

create or replace function public.group_leave(group_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_conversation_id uuid;
  v_new_owner uuid;
  v_archived boolean := false;
begin
  perform earth.rate_limit_for_caller('group_leave', 60, 3600);
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;

  update public.group_members gm
     set status = 'left', left_at = now(), role = 'member'
   where gm.group_id = v_group.id and gm.human_id = v_me;

  -- "<name> left", while the leaver is still a conversation member.
  select c.id into v_conversation_id from public.conversations c where c.group_id = v_group.id;
  if v_conversation_id is not null then
    perform earth.system_message(
      v_conversation_id,
      coalesce(earth.display_name_of(v_me), 'Someone') || ' left',
      jsonb_build_object('kind', 'member_left', 'actorHumanId', v_me),
      v_me
    );
  end if;

  delete from public.conversation_members cm
   where cm.human_id = v_me
     and cm.conversation_id in (select c.id from public.conversations c where c.group_id = v_group.id);

  if v_role = 'owner' then
    select gm.human_id into v_new_owner
      from public.group_members gm
     where gm.group_id = v_group.id and gm.status = 'active'
     order by (gm.role = 'moderator') desc, gm.joined_at, gm.human_id
     limit 1;
    if v_new_owner is not null then
      update public.group_members gm set role = 'owner'
       where gm.group_id = v_group.id and gm.human_id = v_new_owner;
    end if;
  end if;

  if not exists (select 1 from public.group_members gm where gm.group_id = v_group.id and gm.status = 'active') then
    update public.groups g set status = 'archived' where g.id = v_group.id;
    v_archived := true;
  end if;

  return jsonb_build_object('groupId', v_group.id, 'left', true, 'newOwnerHumanId', v_new_owner, 'archived', v_archived);
end
$$;

-- Grants are unchanged by create or replace (0185): group_invite_join / group_leave stay executable
-- by anon, authenticated and service_role; the internal stays owner/service only.
