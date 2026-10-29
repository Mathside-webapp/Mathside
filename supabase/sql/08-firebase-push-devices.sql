-- Mathside / Firebase Cloud Messaging: per-account Android device registration.
-- Run once in the EXISTING Mathside Supabase SQL Editor after scripts 01-07.
-- The frontend stores FCM tokens only through narrowly scoped SECURITY DEFINER RPCs.
-- No service account / Firebase private key belongs in this SQL or the website.

create table if not exists public.mathside_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique,
  platform text not null default 'android' check (platform in ('android')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists mathside_push_devices_user_idx
  on public.mathside_push_devices (user_id) where enabled;

alter table public.mathside_push_devices enable row level security;
revoke all on public.mathside_push_devices from anon, authenticated;
grant select on public.mathside_push_devices to authenticated;

drop policy if exists mathside_push_devices_read_own on public.mathside_push_devices;
create policy mathside_push_devices_read_own
  on public.mathside_push_devices for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.mathside_register_push_device(
  p_token text, p_platform text default 'android'
) returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Login required' using errcode = '28000'; end if;
  if p_token is null or length(trim(p_token)) < 20 or length(p_token) > 4096 then
    raise exception 'Invalid push token';
  end if;
  if p_platform <> 'android' then raise exception 'Unsupported platform'; end if;
  insert into public.mathside_push_devices (user_id,token,platform,enabled,last_seen_at)
  values (v_user,trim(p_token),p_platform,true,now())
  on conflict (token) do update set
    user_id = excluded.user_id,
    platform = excluded.platform,
    enabled = true,
    last_seen_at = now();
  return true;
end;
$$;

create or replace function public.mathside_unregister_push_device(p_token text)
returns boolean language plpgsql security definer
set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Login required' using errcode = '28000'; end if;
  update public.mathside_push_devices set enabled = false
    where user_id = auth.uid() and token = p_token;
  return found;
end;
$$;

revoke all on function public.mathside_register_push_device(text,text) from public, anon;
revoke all on function public.mathside_unregister_push_device(text) from public, anon;
grant execute on function public.mathside_register_push_device(text,text) to authenticated;
grant execute on function public.mathside_unregister_push_device(text) to authenticated;
notify pgrst, 'reload schema';
