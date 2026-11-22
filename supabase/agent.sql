-- ============================================================
-- Research agent access. Run once, after schema.sql.
--
-- A scheduled Claude task researches each new place stop's Instagram and
-- Yelp and writes them back. It does not sign in. It sends a key in an
-- x-agent-token header, and that key opens exactly two functions:
--
--   agent_pending()  the place stops still missing a link that have not
--                    been researched under their current name and address
--   agent_save()     fills an EMPTY instagram / yelp field on one place stop
--                    and records that it was researched
--
-- Nothing else: no other column, no other table, no deletes. Only a hash
-- of the key is stored. The key itself lives in the Claude environment's
-- network secrets, which add the header to requests to this project.
-- ============================================================

create table if not exists public.agent_keys (
  key_hash   text primary key,
  created_at timestamptz not null default now()
);
alter table public.agent_keys enable row level security;   -- no policies: unreadable through the API
revoke all on public.agent_keys from anon, authenticated;

-- What a stop was last researched as (title | business name | address).
-- When the stop is renamed or moved, it is researched again.
alter table public.events add column if not exists social_checked_for text;

create or replace function public.agent_ok()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from public.agent_keys
    where key_hash = encode(digest(coalesce(current_setting('request.headers', true)::json ->> 'x-agent-token', ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.agent_fingerprint(p_title text, p_place text, p_address text)
returns text
language sql
immutable
as $$
  select md5(coalesce(p_title, '') || '|' || coalesce(p_place, '') || '|' || coalesce(p_address, ''));
$$;

create or replace function public.agent_pending()
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.agent_ok() then
    raise exception 'agent key missing or wrong' using errcode = '42501';
  end if;
  return coalesce((
    select json_agg(json_build_object(
      'id', e.id, 'day', e.day, 'time', e.time, 'title', e.title, 'place_name', e.place_name,
      'address', e.address, 'category', e.category, 'instagram', e.instagram, 'yelp', e.yelp
    ) order by e.day, e.time)
    from public.events e
    where e.map_kind = 'place'
      and e.category <> 'travel'
      and (e.instagram = '' or e.yelp = '')
      and e.social_checked_for is distinct from public.agent_fingerprint(e.title, e.place_name, e.address)
  ), '[]'::json);
end;
$$;

create or replace function public.agent_save(p_id uuid, p_instagram text, p_yelp text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ig text := coalesce(trim(p_instagram), '');
  yp text := coalesce(trim(p_yelp), '');
begin
  if not public.agent_ok() then
    raise exception 'agent key missing or wrong' using errcode = '42501';
  end if;
  -- Only an Instagram handle or profile link, and only a Yelp business page.
  if ig !~ '^(@?[A-Za-z0-9._]{1,30}|https://(www\.)?instagram\.com/[A-Za-z0-9._]{1,30}/?)$' then ig := ''; end if;
  if yp !~ '^https://(www\.)?yelp\.com/biz/[A-Za-z0-9%._~-]+$' then yp := ''; end if;
  update public.events e set
    instagram = case when e.instagram = '' then ig else e.instagram end,   -- never overwrites a saved link
    yelp      = case when e.yelp = '' then yp else e.yelp end,
    social_checked_for = public.agent_fingerprint(e.title, e.place_name, e.address),
    updated_by = 'Research agent'
  where e.id = p_id and e.map_kind = 'place';
  return found;
end;
$$;

revoke all on function public.agent_ok() from public;
revoke all on function public.agent_pending() from public;
revoke all on function public.agent_save(uuid, text, text) from public;
grant execute on function public.agent_pending() to anon, authenticated;
grant execute on function public.agent_save(uuid, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- Make the key. Run this on its own; it shows the key ONCE.
-- Paste it into the Claude form for this project, then close the tab.
-- Running it again adds another valid key; to revoke every key:
--   delete from public.agent_keys;
-- ------------------------------------------------------------
-- with k as (select encode(extensions.gen_random_bytes(24), 'hex') as token),
--      ins as (insert into public.agent_keys (key_hash)
--              select encode(extensions.digest(token, 'sha256'), 'hex') from k)
-- select token as agent_key from k;
