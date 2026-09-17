-- 0250 — messages and reactions (spec §27–28, §53–55; DB_API §2 tables).
--
-- `messages.client_id` is the client-generated UUID of spec §53: `(conversation_id, sender_human_id,
-- client_id)` is unique so a retried send returns the row it already created (system messages carry
-- no client id). Deletion never removes a row: `message_delete` tombstones it (`deleted_at` set,
-- `text` null, `payload` '{}'), keeping `id`, `conversation_id`, `sender_human_id`,
-- `reply_to_message_id` and `created_at` so replies still resolve (spec §27 "thread integrity").
-- Server time is canonical (spec §54): `created_at` is the transaction time and the keyset is
-- `(created_at, id)`. Every insert maintains `conversations.last_message_at`,
-- `conversation_members.unread_count` (all members but the sender) and `groups.last_activity_at`
-- through one trigger, so system messages and sends behave the same. `message_reactions` carries a
-- denormalized `conversation_id` (set by trigger from the message) so realtime subscriptions and
-- policies can filter without a join. Policies and grants live in 0260; RPCs in 0270.

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_human_id uuid not null references public.humans (id) on delete restrict,
  type public.message_type not null default 'text',
  text text,
  reply_to_message_id uuid references public.messages (id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  client_id uuid,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint messages_client_key unique (conversation_id, sender_human_id, client_id),
  constraint messages_text_length_check check (text is null or length(text) <= 4000),
  constraint messages_payload_check check (jsonb_typeof(payload) = 'object'),
  -- A text message needs text until it is tombstoned.
  constraint messages_text_required_check check (
    deleted_at is not null or type <> 'text' or length(btrim(coalesce(text, ''))) > 0
  ),
  -- A tombstone keeps no content.
  constraint messages_tombstone_check check (
    deleted_at is null or (text is null and payload = '{}'::jsonb)
  ),
  -- System messages are never client-generated.
  constraint messages_system_client_check check (type <> 'system' or client_id is null),
  constraint messages_reply_not_self_check check (reply_to_message_id is null or reply_to_message_id <> id)
);

-- Keyset pages (`messages_list` scans it backwards, `messages_since` forwards).
create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc, id desc);
create index messages_sender_human_id_idx on public.messages (sender_human_id);
create index messages_reply_to_message_id_idx on public.messages (reply_to_message_id);

create table public.message_reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  human_id uuid not null references public.humans (id) on delete cascade,
  reaction text not null,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint message_reactions_pkey primary key (message_id, human_id, reaction),
  constraint message_reactions_reaction_check check (length(reaction) between 1 and 16 and reaction = btrim(reaction))
);

create index message_reactions_human_id_idx on public.message_reactions (human_id);
create index message_reactions_conversation_message_idx on public.message_reactions (conversation_id, message_id);

-- Read state points at a message (spec §55); a physically removed message clears it.
alter table public.conversation_members
  add constraint conversation_members_last_read_message_id_fkey
  foreign key (last_read_message_id) references public.messages (id) on delete set null;

-- ---------------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------------

-- Every new message: conversation activity, unread counts for everyone but the sender, group activity.
create or replace function earth.messages_after_insert_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  update public.conversations c
     set last_message_at = greatest(coalesce(c.last_message_at, new.created_at), new.created_at)
   where c.id = new.conversation_id;

  update public.conversation_members cm
     set unread_count = cm.unread_count + 1
   where cm.conversation_id = new.conversation_id
     and cm.human_id <> new.sender_human_id;

  update public.groups g
     set last_activity_at = greatest(coalesce(g.last_activity_at, new.created_at), new.created_at)
   where g.id = (select c.group_id from public.conversations c where c.id = new.conversation_id)
     and g.id is not null;

  return new;
end
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function earth.messages_after_insert_trigger();

-- Identity columns never change; a tombstone keeps no content and is frozen afterwards (only the
-- referential `reply_to_message_id` may still be cleared by a physical delete of its target).
create or replace function earth.messages_before_update_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.conversation_id <> old.conversation_id
     or new.sender_human_id <> old.sender_human_id
     or new.type <> old.type
     or new.created_at <> old.created_at
     or new.client_id is distinct from old.client_id then
    perform earth.raise('invalid_input', 'message identity columns are immutable');
  end if;
  if old.deleted_at is not null and (
       new.deleted_at is distinct from old.deleted_at
       or new.text is distinct from old.text
       or new.payload <> old.payload
       or new.edited_at is distinct from old.edited_at) then
    perform earth.raise('invalid_input', 'a deleted message is immutable');
  end if;
  if new.deleted_at is not null then
    new.text := null;
    new.payload := '{}'::jsonb;
  end if;
  return new;
end
$$;

create trigger messages_before_update
  before update on public.messages
  for each row execute function earth.messages_before_update_trigger();

-- message_reactions.conversation_id always mirrors the message.
create or replace function earth.message_reactions_before_insert_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  select m.conversation_id into new.conversation_id from public.messages m where m.id = new.message_id;
  if new.conversation_id is null then
    perform earth.raise('message_not_found');
  end if;
  return new;
end
$$;

create trigger message_reactions_before_insert
  before insert on public.message_reactions
  for each row execute function earth.message_reactions_before_insert_trigger();

alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
