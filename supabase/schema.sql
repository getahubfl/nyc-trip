-- ============================================================
-- NYC Trip Dashboard — Supabase schema
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: every statement is idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Who is allowed in
-- ------------------------------------------------------------
-- The app is for two people. Rather than managing roles, we keep an
-- allow-list of email addresses. Anyone who signs in with an address
-- not on this list can authenticate but sees nothing and writes nothing.
create table if not exists public.trip_members (
  email text primary key,
  label text
);

-- >>> EDIT THESE TWO ROWS with the real addresses before running <<<
insert into public.trip_members (email, label) values
  ('you@example.com',     'Paris'),
  ('partner@example.com', 'Megan')
on conflict (email) do nothing;

alter table public.trip_members enable row level security;

drop policy if exists "members can read the member list" on public.trip_members;
create policy "members can read the member list"
  on public.trip_members for select
  to authenticated
  using (lower(auth.jwt() ->> 'email') in (select lower(email) from public.trip_members));

-- Helper: is the current signed-in user on the allow-list?
create or replace function public.is_trip_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trip_members m
    where lower(m.email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- ------------------------------------------------------------
-- 2. The itinerary
-- ------------------------------------------------------------
create table if not exists public.events (
  id                uuid primary key default gen_random_uuid(),

  -- when
  day               date not null,
  time              text,              -- 'HH:MM', null = time TBD
  duration_min      integer not null default 60,

  -- what
  title             text not null,
  address           text default '',
  category          text not null default 'sights',
  status            text not null default 'confirmed',
  link              text default '',
  notes             text default '',

  -- who / how much
  people            integer not null default 4,
  cost_per_person   numeric(10,2) not null default 0,
  extras            jsonb not null default '[]'::jsonb,   -- [{label, amount}]

  -- reservation
  needs_reservation boolean not null default false,
  booked            boolean not null default false,
  confirmation      text default '',
  reservation_time  text default '',

  -- where
  lat               double precision,
  lng               double precision,
  geo_status        text not null default 'idle',   -- idle|pending|ok|manual|failed|none
  geo_resolved      text default '',

  -- bookkeeping
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  updated_by        text
);

create index if not exists events_day_time_idx on public.events (day, time);

-- Keep updated_at honest, and record who touched it last.
create or replace function public.touch_event()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end;
$$;

drop trigger if exists events_touch on public.events;
create trigger events_touch
  before insert or update on public.events
  for each row execute function public.touch_event();

-- ------------------------------------------------------------
-- 3. Row Level Security
-- ------------------------------------------------------------
-- Without this, the anon key shipped in the public JS bundle would let
-- anyone read and edit the trip. With it, only allow-listed signed-in
-- users can touch anything.
alter table public.events enable row level security;

drop policy if exists "members read events"   on public.events;
drop policy if exists "members insert events" on public.events;
drop policy if exists "members update events" on public.events;
drop policy if exists "members delete events" on public.events;

create policy "members read events"
  on public.events for select to authenticated
  using (public.is_trip_member());

create policy "members insert events"
  on public.events for insert to authenticated
  with check (public.is_trip_member());

create policy "members update events"
  on public.events for update to authenticated
  using (public.is_trip_member())
  with check (public.is_trip_member());

create policy "members delete events"
  on public.events for delete to authenticated
  using (public.is_trip_member());

-- ------------------------------------------------------------
-- 4. Realtime
-- ------------------------------------------------------------
-- Publishes row changes so every open browser updates live.
-- REPLICA IDENTITY FULL makes DELETE events carry the old row, which the
-- client needs in order to know which stop vanished.
alter table public.events replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;

-- ------------------------------------------------------------
-- 5. Keepalive target
-- ------------------------------------------------------------
-- The GitHub Actions cron hits this table anonymously every few days so the
-- free-tier project never sits idle for 7 days and gets paused. It holds no
-- trip data — just a row to select.
create table if not exists public.heartbeat (
  id  integer primary key default 1,
  ok  boolean not null default true
);
insert into public.heartbeat (id, ok) values (1, true) on conflict (id) do nothing;

alter table public.heartbeat enable row level security;

drop policy if exists "anyone may read heartbeat" on public.heartbeat;
create policy "anyone may read heartbeat"
  on public.heartbeat for select
  to anon, authenticated
  using (true);
