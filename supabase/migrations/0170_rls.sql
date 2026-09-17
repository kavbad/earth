-- 0170 — row level security policies and grants for the identity, social, context, group and
-- conversation tables (DB_API §1 / §2 "RLS summary"; ARCHITECTURE §5).
--
-- Every table already has RLS enabled by its migration; this file adds the policies and the
-- explicit grants. Rule of thumb: clients read what the policies allow and write only through RPCs,
-- except the few own-row tables (presence, context, push tokens, conversation preferences,
-- identity edits) where a direct upsert is the contract. `service_role` bypasses RLS and keeps the
-- default grants from 0002.

-- humans: own row only, any auth kind (pending Humans see themselves; nobody else sees them).
grant select on table public.humans to authenticated;
create policy humans_select_own on public.humans
  for select to authenticated
  using (auth_user_id = auth.uid());

-- public_identities: visibility rules in earth.identity_visible_to; own row always readable
-- (claim step) and editable while the Human is active or pending. Handle changes go through RPC.
grant select on table public.public_identities to anon, authenticated;
grant update (display_name, bio, avatar_media_id, profile_visibility, public_city_visibility, home_city_area_id)
  on table public.public_identities to authenticated;
create policy public_identities_select on public.public_identities
  for select to anon, authenticated
  using (human_id = earth.current_human_id() or earth.identity_visible_to(human_id, earth.current_human()));
create policy public_identities_update_own on public.public_identities
  for update to authenticated
  using (human_id = earth.current_human_id() and earth.human_status(human_id) in ('active', 'pending'))
  with check (human_id = earth.current_human_id() and earth.human_status(human_id) in ('active', 'pending'));

-- media_objects: own objects plus public avatar objects; insert own (pending Humans upload their avatar).
grant select on table public.media_objects to anon, authenticated;
grant insert on table public.media_objects to authenticated;
create policy media_objects_select on public.media_objects
  for select to anon, authenticated
  using (bucket = 'avatars' or (owner_human_id is not null and owner_human_id = earth.current_human_id()));
create policy media_objects_insert_own on public.media_objects
  for insert to authenticated
  with check (owner_human_id is not null and owner_human_id = earth.current_human_id());

-- auth_identities, human_passes, identity_reviews: own rows; writes via RPC/service.
grant select on table public.auth_identities to authenticated;
create policy auth_identities_select_own on public.auth_identities
  for select to authenticated
  using (human_id = earth.current_human_id());

grant select on table public.human_passes to authenticated;
create policy human_passes_select_own on public.human_passes
  for select to authenticated
  using (human_id = earth.current_human_id());

grant select on table public.identity_reviews to authenticated;
create policy identity_reviews_select_own on public.identity_reviews
  for select to authenticated
  using (human_id = earth.current_human_id());

-- relationships: rows where the viewer is the source, or the target of a non-familiar edge.
grant select on table public.relationships to authenticated;
create policy relationships_select on public.relationships
  for select to authenticated
  using (
    source_human_id = earth.current_human_id()
    or (target_human_id = earth.current_human_id() and type <> 'familiar_private')
  );

-- blocks: own blocks as blocker. Being blocked is never revealed.
grant select on table public.blocks to authenticated;
create policy blocks_select_own on public.blocks
  for select to authenticated
  using (blocker_human_id = earth.current_human_id());

-- human_presence, human_context, push_tokens: own row, active Humans only.
grant select, insert, update, delete on table public.human_presence to authenticated;
create policy human_presence_own on public.human_presence
  for all to authenticated
  using (human_id = earth.current_human())
  with check (human_id = earth.current_human());

grant select, insert, update, delete on table public.human_context to authenticated;
create policy human_context_own on public.human_context
  for all to authenticated
  using (human_id = earth.current_human())
  with check (human_id = earth.current_human());

grant select, insert, update, delete on table public.push_tokens to authenticated;
create policy push_tokens_own on public.push_tokens
  for all to authenticated
  using (human_id = earth.current_human())
  with check (human_id = earth.current_human());

-- groups / group_members: active members only; pending Humans never appear in member lists.
grant select on table public.groups to authenticated;
create policy groups_select_member on public.groups
  for select to authenticated
  using (earth.is_group_member(id, earth.current_human()));

grant select on table public.group_members to authenticated;
create policy group_members_select_member on public.group_members
  for select to authenticated
  using (
    earth.is_group_member(group_id, earth.current_human())
    and earth.human_status(human_id) <> 'pending'
  );

-- group_invites: no client access to the table (token_hash). Creators and owners/moderators read
-- invites through this view, which never exposes the hash. The view runs as its owner and filters
-- by the caller explicitly.
create view public.group_invites_view as
  select gi.id, gi.group_id, gi.created_by, gi.expires_at, gi.max_uses, gi.use_count, gi.status,
         gi.created_at, gi.revoked_at
    from public.group_invites gi
   where earth.current_human() is not null
     and (gi.created_by = earth.current_human()
          or earth.is_group_moderator(gi.group_id, earth.current_human()));
grant select on public.group_invites_view to authenticated, service_role;

-- conversations / conversation_members: members only; own preferences and read state are editable.
grant select on table public.conversations to authenticated;
create policy conversations_select_member on public.conversations
  for select to authenticated
  using (earth.is_conversation_member(id, earth.current_human()));

grant select on table public.conversation_members to authenticated;
grant update (last_read_message_id, last_read_at, mute_state, notification_level)
  on table public.conversation_members to authenticated;
create policy conversation_members_select_member on public.conversation_members
  for select to authenticated
  using (earth.is_conversation_member(conversation_id, earth.current_human()));
create policy conversation_members_update_own on public.conversation_members
  for update to authenticated
  using (human_id = earth.current_human())
  with check (human_id = earth.current_human());
