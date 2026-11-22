-- ============================================================
-- Instagram + Yelp research, set off by the stop itself. Run once, after
-- schema.sql.
--
-- When a stop is a PLACE with a BUSINESS NAME and a MAP PIN (and is not a
-- travel stop), the database starts a Claude task (a routine with an API
-- trigger) once. The task researches the business and fills in its links.
--
--   - Once per business name, whatever the research finds. It is never
--     retried, and there is no schedule.
--   - A stop whose pin arrives after it is saved is researched when the pin
--     lands.
--   - Renaming the business starts a new search. Links that belonged to the
--     old name are cleared first, unless the same save changed them.
--   - Stops that exist when this runs are marked as already researched.
--
-- The task writes back through agent_save() only. It does not sign in: it
-- sends a key in an x-agent-token header (added by the Claude environment's
-- network secret), checked here against a hash. agent_save fills EMPTY
-- instagram / yelp fields on a place stop and nothing else.
--
-- Two values live in Supabase Vault, never in the repo:
--   claude_fire_url    the routine's Fire URL
--   claude_fire_token  the routine's API token (sk-ant-oat01-...)
-- Until both exist, saving works as before and no research is requested.
-- ============================================================

create extension if not exists pg_net;

-- ---------- the key the task writes with ----------
create table if not exists public.agent_keys (
  key_hash   text primary key,
  created_at timestamptz not null default now()
);
alter table public.agent_keys enable row level security;   -- no policies: unreadable through the API
revoke all on public.agent_keys from anon, authenticated;

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
  if ig = '' and yp = '' then return false; end if;
  update public.events e set
    instagram  = case when e.instagram = '' then ig else e.instagram end,   -- never overwrites a saved link
    yelp       = case when e.yelp = '' then yp else e.yelp end,
    updated_by = 'Research agent'
  where e.id = p_id and e.map_kind = 'place';
  return found;
end;
$$;

revoke all on function public.agent_ok() from public;
revoke all on function public.agent_save(uuid, text, text) from public;
grant execute on function public.agent_save(uuid, text, text) to anon, authenticated;

-- ---------- once per business name ----------
-- The business name a stop was last sent for research under.
alter table public.events add column if not exists social_requested_for text;

-- Stops that already exist count as researched.
update public.events
set social_requested_for = lower(trim(place_name))
where map_kind = 'place' and coalesce(trim(place_name), '') <> '' and social_requested_for is null;

create or replace function public.research_new_place()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  fp  text;
  url text;
  tok text;
begin
  -- A place, with a business name and a pin. Travel stops are left alone:
  -- the trip home is a place too, and its address is not for a web search.
  if new.map_kind is distinct from 'place' or new.category = 'travel'
     or coalesce(trim(new.place_name), '') = '' or new.lat is null or new.lng is null then
    return new;
  end if;
  fp := lower(trim(new.place_name));
  if new.social_requested_for is not distinct from fp then
    return new;                         -- already sent under this name
  end if;
  -- Renamed: the old name's links go, unless this same save changed them.
  if tg_op = 'UPDATE' and old.social_requested_for is not null then
    if new.instagram is not distinct from old.instagram then new.instagram := ''; end if;
    if new.yelp is not distinct from old.yelp then new.yelp := ''; end if;
  end if;
  new.social_requested_for := fp;       -- once, whatever the research finds

  -- Never let the request get in the way of saving the stop.
  begin
    select decrypted_secret into url from vault.decrypted_secrets where name = 'claude_fire_url';
    select decrypted_secret into tok from vault.decrypted_secrets where name = 'claude_fire_token';
    if url is not null and tok is not null then
      perform net.http_post(
        url     := url,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || tok,
          'anthropic-version', '2023-06-01',
          'anthropic-beta', 'experimental-cc-routine-2026-04-01',
          'Content-Type', 'application/json'),
        body    := jsonb_build_object('text', jsonb_build_object(
          'id', new.id,
          'business_name', new.place_name,
          'title', new.title,
          'address', new.address,
          'category', new.category,
          'area', new.geo_resolved,
          'website', new.link)::text));
    end if;
  exception when others then
    raise warning 'research request not sent: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists events_research on public.events;
create trigger events_research
  before insert or update on public.events
  for each row execute function public.research_new_place();

-- Earlier draft of this file, if it was run: the scheduled version's parts.
drop function if exists public.agent_pending();
drop function if exists public.agent_fingerprint(text, text, text);
alter table public.events drop column if exists social_checked_for;

-- ------------------------------------------------------------
-- Make the write key. Run on its own; it shows the key ONCE.
-- Paste it into the Claude form for this project.
-- Running it again adds another valid key; to revoke every key:
--   delete from public.agent_keys;
-- ------------------------------------------------------------
-- with k as (select encode(extensions.gen_random_bytes(24), 'hex') as token),
--      ins as (insert into public.agent_keys (key_hash)
--              select encode(extensions.digest(token, 'sha256'), 'hex') from k)
-- select token as agent_key from k;

-- ------------------------------------------------------------
-- Connect the routine. Run on its own, with the Fire URL and token from
-- claude.ai/code/routines (the task, Edit, Trigger +, API).
-- ------------------------------------------------------------
-- select vault.create_secret('PASTE FIRE URL', 'claude_fire_url');
-- select vault.create_secret('PASTE TOKEN', 'claude_fire_token');
