-- Forge: agent-compiled deterministic extractors
-- One Postgres instance, two schemas.
--   forge   = agent tooling input/output (sources, adapters, fixtures, compile runs)
--   runtime = scrape execution (jobs, runs, records, change feed)

create extension if not exists pgcrypto;

create schema if not exists forge;
create schema if not exists runtime;

-- ============================================================ forge

create type forge.source_state    as enum ('new','compiling','active','degraded','repairing','disabled');
create type forge.adapter_status  as enum ('draft','canary','active','retired','rejected');
create type forge.fetch_tier      as enum ('http','browser');
create type forge.compile_kind    as enum ('compile','repair');
create type forge.compile_state   as enum ('queued','running','succeeded','failed','abandoned');

-- What you want, in your words. Human-owned. The only place a schema is defined.
create table forge.source (
  id            uuid primary key default gen_random_uuid(),
  key           text not null unique,                 -- 'willhaben/listing'
  intent        text not null,                        -- natural language brief for the agent
  entry_url     text not null,
  url_pattern   text,                                 -- regex matching item URLs
  output_schema jsonb not null,                       -- JSON Schema. Agents may never edit this.
  required_fields text[] not null default '{}',
  cadence       interval not null default '1 day',
  state         forge.source_state not null default 'new',
  fetch_hints   jsonb not null default '{}'::jsonb,   -- headers, locale; proxy pool name later
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The compiled artifact. This is the thing that makes the framework a framework.
create table forge.adapter (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references forge.source(id) on delete cascade,
  version        int  not null,
  status         forge.adapter_status not null default 'draft',
  fetch_plan     jsonb not null,        -- {tier,urlTemplate,method,headers,body,waitFor}
  code_ts        text  not null,        -- what the agent wrote
  code_js        text  not null,        -- esbuild output; this is what executes
  code_hash      text  not null,        -- sha256(code_js); runtime cache key
  notes          text,                  -- why each field is anchored where it is
  compile_run_id uuid,
  created_at     timestamptz not null default now(),
  unique (source_id, version)
);
create unique index adapter_one_active on forge.adapter(source_id) where status = 'active';
create unique index adapter_one_canary on forge.adapter(source_id) where status = 'canary';

-- Frozen pages. Belong to the source, not the adapter, so every version tests on the same corpus.
create table forge.fixture (
  id          uuid primary key default gen_random_uuid(),
  source_id   uuid not null references forge.source(id) on delete cascade,
  url         text not null,
  tier        forge.fetch_tier not null,
  status_code int,
  headers     jsonb,
  body        bytea not null,           -- gzipped
  expected    jsonb,                    -- golden output, set once a human confirms
  captured_at timestamptz not null default now()
);
create index fixture_by_source on forge.fixture(source_id, captured_at desc);

-- One agent invocation. Also the queue for the forge worker.
create table forge.compile_run (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid not null references forge.source(id) on delete cascade,
  kind              forge.compile_kind not null,
  state             forge.compile_state not null default 'queued',
  trigger           jsonb not null default '{}'::jsonb,   -- health snapshot, or {manual:true}
  input             jsonb not null default '{}'::jsonb,   -- prior adapter id, failing fields, fixture ids
  result_adapter_id uuid references forge.adapter(id),
  model             text,
  tokens_in         int,
  tokens_out        int,
  cost_usd          numeric(10,4),
  iterations        int not null default 0,
  error             text,
  attempts          int not null default 0,
  run_after         timestamptz not null default now(),
  locked_by         text,
  locked_at         timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index compile_claim on forge.compile_run (run_after, created_at) where state = 'queued';
-- at most one open repair per source
create unique index compile_one_open on forge.compile_run(source_id) where state in ('queued','running');

-- Every tool call the agent made. Debuggability of the agent loop.
create table forge.compile_step (
  id             bigserial primary key,
  compile_run_id uuid not null references forge.compile_run(id) on delete cascade,
  n              int  not null,
  tool           text not null,
  input          jsonb,
  output_summary jsonb,
  created_at     timestamptz not null default now()
);
create index step_by_run on forge.compile_step(compile_run_id, n);

-- ============================================================ runtime

create type runtime.job_state as enum ('queued','running','done','failed','dead');

create table runtime.job (
  id           bigserial primary key,
  source_id    uuid not null references forge.source(id) on delete cascade,
  url          text not null,
  external_key text not null,
  priority     int  not null default 100,
  state        runtime.job_state not null default 'queued',
  attempts     int  not null default 0,
  run_after    timestamptz not null default now(),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  unique (source_id, url)
);
create index job_claim on runtime.job (run_after, priority, id) where state = 'queued';

create table runtime.run (
  id              bigserial primary key,
  job_id          bigint references runtime.job(id) on delete set null,
  source_id       uuid   not null references forge.source(id) on delete cascade,
  adapter_id      uuid   not null references forge.adapter(id),
  adapter_version int    not null,
  canary          boolean not null default false,
  http_status     int,
  fetch_ms        int,
  parse_ms        int,
  bytes           int,
  items           int not null default 0,
  valid_items     int not null default 0,
  field_nulls     jsonb,          -- {"price":0.02,"title":0}
  outcome         text not null,  -- ok | schema_invalid | empty | fetch_error | exec_error | timeout
  error           text,
  created_at      timestamptz not null default now()
);
create index run_health on runtime.run (source_id, created_at desc);

create table runtime.record (
  id           bigserial primary key,
  source_id    uuid not null references forge.source(id) on delete cascade,
  external_key text not null,
  payload      jsonb not null,
  content_hash text not null,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  last_run_id  bigint,
  unique (source_id, external_key)
);
create index record_payload on runtime.record using gin (payload jsonb_path_ops);

-- Outbox. Downstream apps read this instead of polling record.
create table runtime.change_event (
  id          bigserial primary key,
  record_id   bigint not null references runtime.record(id) on delete cascade,
  source_id   uuid   not null,
  kind        text   not null,   -- insert | update
  created_at  timestamptz not null default now(),
  consumed_at timestamptz
);
create index change_unconsumed on runtime.change_event (id) where consumed_at is null;
