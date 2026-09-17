-- 0420 — row level security and grants for the post tables (DB_API §4 "RLS"; ARCHITECTURE §5).
--
-- Clients read posts through earth.can_view_post (via earth.post_readable_by_caller) and never
-- write: every mutation is an RPC (0430). Media and reactions follow their post; hides are private
-- to the Human who hid. `service_role` keeps the 0002 defaults (bypasses RLS).

-- posts: visible per DB_API §4 (visitors and Guests read as anonymous viewers: world posts while
-- PUBLIC_WORLD_ENABLED). Authors always see their own rows, removed ones included.
grant select on table public.posts to anon, authenticated;
create policy posts_select_visible on public.posts
  for select to anon, authenticated
  using (earth.post_readable_by_caller(id));

-- post_media: follows the post.
grant select on table public.post_media to anon, authenticated;
create policy post_media_select_visible on public.post_media
  for select to anon, authenticated
  using (earth.post_readable_by_caller(post_id));

-- post_reactions: readable when the post is (counts and "who reacted" on visible posts).
grant select on table public.post_reactions to anon, authenticated;
create policy post_reactions_select_visible on public.post_reactions
  for select to anon, authenticated
  using (earth.post_readable_by_caller(post_id));

-- post_hides: own rows only.
grant select on table public.post_hides to authenticated;
create policy post_hides_select_own on public.post_hides
  for select to authenticated
  using (human_id = earth.current_human());
