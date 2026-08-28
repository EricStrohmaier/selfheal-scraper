-- 001: record absence, and telling "blocked" apart from "broken"
--
-- Three gaps in the baseline schema, all of them found by reading a working
-- production scraper rather than by reasoning about the plan.
--
-- 1. A 200 response can be a bot challenge. Without a way to say so, a challenge
--    page extracts 0 items, which reads as `empty`, which trips degradation, which
--    queues a repair the agent cannot possibly fix — the adapter was never broken.
--    `runtime.run.outcome` gains 'blocked', and the health window ignores those runs.
--
-- 2. Nothing represented "this record disappeared". `change_event.kind` was only
--    insert|update, so a delisted apartment or a filled job stayed live forever.
--
-- 3. The absence sweep is only safe when a run collected the *whole* result set.
--    A run that aborted halfway would otherwise mark every unseen record gone.
--    `runtime.run.complete` carries that, and the sweep refuses to run without it.

alter table runtime.record add column is_active boolean not null default true;
alter table runtime.record add column gone_at timestamptz;
create index record_active on runtime.record (source_id) where is_active;

-- Which tier actually served the bytes, and whether we had to climb to get them.
-- `fetch_plan.tier` is the plan; this is what happened.
alter table runtime.run add column tier_used text;
alter table runtime.run add column escalated boolean not null default false;

-- False when the run stopped early: aborted, page budget exhausted, partial
-- pagination. Guards the absence sweep.
alter table runtime.run add column complete boolean not null default true;

comment on column runtime.run.outcome is
  'ok | schema_invalid | empty | fetch_error | exec_error | timeout | blocked';
comment on column runtime.change_event.kind is 'insert | update | gone';
