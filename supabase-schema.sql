-- World Monitor — Supabase schema
-- Run this once in Supabase → SQL Editor → New query → Run.

create table if not exists public.events (
  id         bigint generated always as identity primary key,
  cat        text not null check (cat in ('crypto','ai','markets','conflict','weather','world')),
  title      text not null,
  place      text,
  lon        double precision not null,
  lat        double precision not null,
  t          timestamptz not null default now(),
  key        text unique,
  created_at timestamptz not null default now()
);

create index if not exists events_t_idx on public.events (t desc);

-- Row Level Security: anyone (anon key) may READ; only the service role (used by
-- the ingester) may write — service_role bypasses RLS, so no insert policy needed.
alter table public.events enable row level security;

drop policy if exists "public read" on public.events;
create policy "public read" on public.events for select using (true);

-- Realtime: publish INSERTs on this table so the map gets live pushes.
-- (Safe to run once; ignore "already member of publication" if you re-run.)
do $$
begin
  begin
    alter publication supabase_realtime add table public.events;
  exception when duplicate_object then null;
  end;
end $$;

-- Optional housekeeping: keep the table from growing forever.
-- Enable pg_cron in Supabase (Database → Extensions), then:
--   select cron.schedule('wm-prune', '*/30 * * * *',
--     $$ delete from public.events where id not in
--        (select id from public.events order by t desc limit 3000) $$);
