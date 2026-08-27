# Forge — master plan and spec

Version 0.1, draft. Name is a placeholder.

## 1. What this is

A system that turns "get X from site Y" into a stored, versioned, deterministic extractor
that runs as plain code and repairs itself when the site changes.

Two tiers, strictly separated:

- **Forge (agent tier).** Expensive, rare. A model explores a site once and writes extractor
  code. Also repairs that code when it breaks.
- **Runtime (execution tier).** Cheap, constant. Executes stored extractor code.
  Never calls a model. Has no per-site code in it at all.

The artifact connecting them is an **adapter**: a row in Postgres holding executable JS,
a fetch plan, and a code hash.

## 2. Why the extractor code lives in the database

This is the decision the whole design rests on.

- Adding a site is inserting a row. No deploy, no rebuild, no restart.
- Repair is inserting a new adapter row with `version + 1`. Rollback is flipping a status column.
- Any process that can reach Postgres can run any adapter. The runtime worker stays generic.
- Adapter history, the fixtures it was compiled against, and the agent run that produced it
  are all queryable in the same place.

The cost is that adapter code is model-generated and must be treated as untrusted input.
Section 7 covers how it is contained.

## 3. Two schemas, one Postgres instance

```
forge     agent tooling input and output
runtime   scrape execution and results
```

They are separate schemas because they have separate lifecycles, separate access patterns,
and separate growth curves. `forge` is small, low-write, and interesting to a human.
`runtime` is large, high-write, and interesting to a machine.

They are on one instance because `runtime.run` references `forge.adapter.id`, and health
computed in `runtime` triggers work in `forge`. On one instance that is a foreign key and a
transaction. Across two instances it is a sync problem you have to write and debug.

Nothing outside the two workers joins across the boundary, so splitting them onto separate
instances later is a deployment change and not a model change.

Full DDL is in `schema.sql`. It has been applied to Postgres 16 and the constraints below
are verified working.

### forge

| table | holds |
|---|---|
| `source` | what you want, in your words. `intent`, `entry_url`, `output_schema`, `required_fields`, `cadence`, `state`. Human-owned. |
| `adapter` | versioned extractor. `fetch_plan`, `code_ts`, `code_js`, `code_hash`, `status`, `notes`. |
| `fixture` | frozen page bodies plus golden output. Belongs to the source so every adapter version tests against the same corpus. |
| `compile_run` | one agent invocation. Also the queue for the forge worker. Records model, tokens, cost, iterations, outcome. |
| `compile_step` | every tool call the agent made inside a compile run. |

Two partial unique indexes carry real invariants:

```sql
create unique index adapter_one_active on forge.adapter(source_id) where status = 'active';
create unique index adapter_one_canary on forge.adapter(source_id) where status = 'canary';
create unique index compile_one_open  on forge.compile_run(source_id)
  where state in ('queued','running');
```

The third one is what stops a degraded source from queueing a repair on every failing run.

### runtime

| table | holds |
|---|---|
| `job` | queue. `unique(source_id, url)`, claimed with `FOR UPDATE SKIP LOCKED`. Re-scheduling is an upsert that resets `state` and `run_after`. |
| `run` | one fetch plus extract. Timings, bytes, item counts, per-field null rates, outcome. This table is the health signal. |
| `record` | extracted data. `unique(source_id, external_key)`, `payload jsonb`, `content_hash`. |
| `change_event` | outbox. Downstream apps read this instead of polling `record`. |

Change detection comes free from the upsert, with no extra query:

```sql
with up as (
  insert into runtime.record (source_id, external_key, payload, content_hash)
  values ($1,$2,$3,$4)
  on conflict (source_id, external_key) do update
    set payload = excluded.payload,
        content_hash = excluded.content_hash,
        last_seen = now()
    where runtime.record.content_hash is distinct from excluded.content_hash
  returning id, source_id, (xmax = 0) as is_insert
)
insert into runtime.change_event (record_id, source_id, kind)
select id, source_id, case when is_insert then 'insert' else 'update' end from up;
```

Unchanged content returns zero rows from `up`, so no change event is written. Verified.

## 4. How other applications consume it

Two boundaries, both plain SQL. No client library required, any language works.

1. Read `runtime.record.payload`, or a per-source view that projects the jsonb into columns.
2. Consume `runtime.change_event` as an outbox, with `LISTEN/NOTIFY` used only as a wakeup.
   The table stays the source of truth because raw NOTIFY drops messages across a restart.

## 5. The adapter contract

```ts
type FetchPlan = {
  tier: 'http' | 'browser'
  urlTemplate: string                  // 'https://api.example.at/v2/item/{key}'
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  waitFor?: string                     // browser tier only
}

type ExtractInput = {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  json(): unknown                      // lazy JSON.parse
  doc(): Document                      // lazy linkedom parse
}

// this is what the agent writes and what is stored in adapter.code_ts
export function extract(input: ExtractInput): unknown[]
export function discover?(input: ExtractInput): string[]   // listing page -> item URLs
```

`json()` and `doc()` are lazy so an adapter that reads a JSON endpoint never pays for HTML parsing.
That is the main per-run cost lever.

### Static rules enforced before the row is written

Parsed with `acorn`, rejected on any violation:

- exports exactly `extract`, optionally `discover`, nothing else
- no `import`, `require`, `await`, `async`, `fetch`, `eval`, `new Function`, `process`, `globalThis`
- no `setTimeout` / `setInterval`
- no unbounded `while (true)`
- no positional selectors: `nth-child`, `nth-of-type`, or chains of bare `> div`
- `code_ts` under 400 lines
- does not reference `output_schema`. Validation is applied by the runtime, not the adapter.

### Promotion gate

An adapter cannot leave `draft` until:

- it runs against at least 3 fixtures
- every fixture yields at least 1 item
- 100% of produced items validate against `source.output_schema`
- where `fixture.expected` is set, output matches it, or the compile run explains the diff

## 6. Runtime worker loop

```
tick scheduler          enqueue jobs whose source cadence is due
claim job               FOR UPDATE SKIP LOCKED, one row
load adapter            active, or canary for 10% of jobs on sources with a canary
                        compiled function cached in-process, LRU keyed by code_hash
fetch                   per fetch_plan; undici for http, playwright for browser
extract                 sandboxed, sync, 2s CPU cap
validate                each item against output_schema
write                   upsert record + change_event, only for valid items
record run              timings, counts, per-field null rate, outcome
update health           recompute rolling window for the source
```

Nothing is written to `record` from a run whose items fail validation. A broken site produces
a stale source, never a corrupted one.

### Canary promotion

When a canary adapter exists, 10% of that source's jobs route to it. Promote after 20 canary
runs when its `schema_invalid_rate` is at or below the active adapter's and its item yield is
within 10%. Otherwise set it to `rejected` and leave the active adapter alone.

## 7. Sandbox

`node:vm` with a frozen context containing only `JSON, Object, Array, String, Number, Boolean,
Math, Date, RegExp, Map, Set, parseInt, parseFloat, isNaN`, and
`codeGeneration: { strings: false, wasm: false }`. Compiled scripts cached by `code_hash`.

Verified in this environment: `require`, `fetch`, `process` all throw `ReferenceError`;
`new Function` and `eval` throw `EvalError`; an infinite loop terminates with
`ERR_SCRIPT_EXECUTION_TIMEOUT`.

**Known limit, do not ignore it.** `node:vm` is a correctness boundary and not a security
boundary. Passing a normal host object into the context leaks the host realm through
`input.constructor.constructor`. Confirmed working escape in this environment:

```js
input.constructor.constructor('return process.env.HOME')()   // -> /root
```

Two mitigations, both cheap:

- Build `ExtractInput` with `Object.create(null)` so there is no prototype chain to walk.
  Verified to block the escape above. Does not cover `doc()`, which returns a linkedom object.
- Run the extract step in a dedicated child process per worker, recycled every N runs, with
  no credentials in its environment and no network egress. This is the actual boundary.

Upgrade path if adapters ever come from outside your own agent: `isolated-vm`.

## 8. Health and repair

Rolling window is the last 20 runs per source. Any of these trips it:

- `schema_invalid_rate > 0.20`
- any required field `null_rate > 0.15`
- items per run below `0.6 ×` trailing median
- 3 consecutive runs with outcome `empty` or `exec_error`

On trip:

1. `source.state = 'degraded'`. Record writes for that source stop.
2. Capture 2 fresh fixtures.
3. Insert `forge.compile_run(kind='repair')` with the failing field report and the fixture ids.
   The `compile_one_open` index makes duplicate repairs impossible.
4. Forge worker picks it up, produces `version + 1` as `canary`.
5. Canary passes the gate and 20 canary runs, then it becomes `active` and `state` returns to `active`.

After 3 failed repairs the source goes to `disabled` and a human is notified.

## 9. The agent

One loop, two prompts, a fixed tool allowlist.

| tool | does |
|---|---|
| `fetch_page(url, tier)` | fetch, store a fixture, return a structured outline plus a truncated body |
| `probe_network(url)` | load in a browser, return the XHR and fetch calls the page made with response shapes |
| `query_dom(fixture_id, selector)` | test a selector against a stored fixture without writing code |
| `run_extract(code, fixture_ids)` | sandbox-execute candidate code, return items plus a validation report |
| `save_adapter(code, fetch_plan, notes)` | write a draft and run the promotion gate |

No shell, no filesystem, no free network. Every call is written to `compile_step`.

### Compile objective, in priority order

1. Produce items that validate against `output_schema`.
2. Reach `tier: 'http'` if the site allows it. Call `probe_network` before writing any DOM selector.
   A browser run costs roughly 2-4 seconds and 300MB. A JSON endpoint costs 80ms and 3MB.
   Finding the endpoint is the single highest-value thing the agent does.
3. Data source preference: internal JSON endpoint, then embedded JSON
   (`__NEXT_DATA__`, `application/ld+json`, inline state), then semantic DOM attributes
   (`data-*`, `itemprop`, `aria-*`), then stable class prefixes, then text regex.
   Going down the list requires a justification written into `notes`.
4. Write `notes` explaining what anchors each field. The repair agent reads this.

Iteration cap: 12 tool calls. Then fail and record why.

### Repair objective

- Minimal diff against the current adapter.
- Must pass all existing fixtures, including the ones from before the break.
- **May not modify `output_schema` or `required_fields`.** If the site genuinely stopped
  publishing a required field, the correct outcome is a failed repair with that finding.
  Without this rule, self-healing degrades into extracting garbage that still validates.
- Iteration cap: 8 tool calls.

## 10. Deliberately not in v1

- No CLI. Sources are added by inserting a row. Work is triggered by inserting a `compile_run`.
- No proxy or session management. `source.fetch_hints` is passed through to the fetcher
  unchanged, so adding a third-party proxy later is a config change.
- No login or auth flows.
- No UI.
- No distributed scheduler. One tick inside the runtime worker.

## 11. Layout

```
packages/
  core/       adapter contract types, acorn validator, sandbox, esbuild transpile, health math
  db/         drizzle schema, queue queries, record upsert
  fetch/      http tier (undici) and browser tier (playwright)
apps/
  runtime-worker/   scheduler tick + job claim loop
  forge-worker/     compile_run claim loop + agent
schema.sql
docker-compose.yml   postgres only
```

Postgres is the only infrastructure dependency. No Redis, no broker, no object store.

## 12. Build order

| milestone | contains | done when |
|---|---|---|
| M1 | contract types, acorn validator, sandbox, fixture runner | one hand-written adapter passes against 3 committed fixtures |
| M2 | db package, runtime worker, job queue, record upsert, change_event | two real sites scrape on a cadence unattended |
| M3 | run metrics, health window, degradation, canary routing | a deliberately broken selector trips degradation without corrupting records |
| M4 | forge worker, compile agent, tools, promotion gate | agent compiles a working adapter for a third site from intent alone |
| M5 | repair agent, canary promotion, rollback | a real layout change is repaired without human edits |

Do not start M4 until M1 through M3 have run unattended for a week against two real sites.
The value of the agent tier depends entirely on the verification harness underneath it being
trustworthy, and that harness is M1 through M3.
