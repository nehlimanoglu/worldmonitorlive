-- World Monitor — schedule the ingest Edge Function with pg_cron.
-- Run once in Supabase → SQL Editor. Replace <PROJECT_REF> and <ANON_KEY> first.
--   <PROJECT_REF> = your project ref (the xxxx in https://xxxx.supabase.co)
--   <ANON_KEY>    = Project Settings → API → "anon public"  (a valid project JWT)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- (re)create the schedule: call /functions/v1/ingest every 3 minutes
select cron.unschedule('wm-ingest') where exists (select 1 from cron.job where jobname = 'wm-ingest');

select cron.schedule(
  'wm-ingest',
  '*/3 * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/ingest',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <ANON_KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Optional: prune the table so it doesn't grow forever (keep newest 3000).
select cron.unschedule('wm-prune') where exists (select 1 from cron.job where jobname = 'wm-prune');
select cron.schedule(
  'wm-prune',
  '*/30 * * * *',
  $$ delete from public.events
     where id not in (select id from public.events order by t desc limit 3000) $$
);

-- Check it's registered:  select jobname, schedule, active from cron.job;
-- See recent runs:        select * from cron.job_run_details order by start_time desc limit 10;
