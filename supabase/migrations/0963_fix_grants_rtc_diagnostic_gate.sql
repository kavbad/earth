-- 0963 — grants review: `rtc_diagnostic_record` asks who is calling before it spends the caller's
-- rate-limit window (ARCHITECTURE §5; DB_API §8; spec §114, §128 "Audience permission is
-- server-authoritative"; same rule as 0960).
--
-- 0800 gated visitors, the service and claiming credentials by `earth.current_role_kind()`, charged
-- `rtc_diagnostic_record` (120/10min) and only then ran `earth.assert_human()` for the `human`
-- kind — which is also what a restricted or suspended Human is. Such a Human therefore wrote a
-- `private.rate_limits` row before `human_not_active` rolled it back: a write before the caller gate,
-- the pattern 0960 closed for `room_join` / `room_set_media_state`.
-- `supabase/tests/src/verify/grants.test.ts` counts rolled-back writes through `pg_stat_user_tables`
-- for restricted and suspended Humans, which is how this surfaced.
--
-- The body is the 0800 definition with `earth.assert_human()` moved in front of the rate limit for
-- the `human` kind; Guests are unchanged (their seat is checked after the window, as for every
-- Guest-capable RPC). Grants are restated (`create or replace` keeps them).

create or replace function public.rtc_diagnostic_record(
  kind text,
  room_id uuid default null,
  payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_role text := earth.current_role_kind();
  v_kind text := nullif(btrim(coalesce(kind, '')), '');
  v_payload jsonb := coalesce(payload, '{}'::jsonb);
  v_human uuid;
  v_guest uuid;
  v_id uuid;
  v_created_at timestamptz;
begin
  if v_role = 'visitor' then
    perform earth.raise('not_authenticated');
  elsif v_role = 'service' then
    perform earth.raise('forbidden', 'the service inserts rtc_diagnostics directly');
  elsif v_role = 'claiming' then
    perform earth.raise('not_a_human');
  end if;
  -- Who is calling, before anything is written: a restricted or suspended Human is refused
  -- (`human_not_active`) with no rate-limit row spent on the refusal (same rule as 0960).
  if v_role = 'human' then
    v_human := earth.assert_human();
  end if;

  perform earth.rate_limit_for_caller('rtc_diagnostic_record', 120, 600);

  if v_kind is null or v_kind !~ '^[a-z][a-z0-9_]*$' or length(v_kind) > 64 then
    perform earth.raise('invalid_input', 'kind must be a snake_case identifier of at most 64 characters');
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    perform earth.raise('invalid_input', 'payload must be an object');
  end if;
  if (select count(*) from jsonb_object_keys(v_payload)) > 64 then
    perform earth.raise('invalid_input', 'payload carries at most 64 keys');
  end if;
  if octet_length(v_payload::text) > 16384 then
    perform earth.raise('invalid_input', 'payload is larger than 16 KiB');
  end if;

  if room_id is not null then
    if not exists (select 1 from public.rooms r where r.id = room_id) then
      perform earth.raise('room_not_found');
    end if;
    if v_role = 'human' then
      if not exists (
        select 1 from public.room_participants rp where rp.room_id = rtc_diagnostic_record.room_id and rp.human_id = v_human
      ) then
        perform earth.raise('not_in_room');
      end if;
    else
      v_guest := earth.analytics_caller_guest_session(room_id);
      if v_guest is null then
        perform earth.raise('not_in_room');
      end if;
    end if;
  end if;

  insert into public.rtc_diagnostics (human_id, guest_session_id, room_id, kind, payload)
  values (v_human, v_guest, room_id, v_kind, earth.analytics_strip_coordinates(v_payload))
  returning id, created_at into v_id, v_created_at;

  return jsonb_build_object('id', v_id, 'createdAt', to_jsonb(v_created_at));
end
$$;

-- Grants unchanged from 0800 (restated: client profile, never PUBLIC).
revoke execute on function public.rtc_diagnostic_record(text, uuid, jsonb) from public;
grant execute on function public.rtc_diagnostic_record(text, uuid, jsonb) to anon, authenticated, service_role;
