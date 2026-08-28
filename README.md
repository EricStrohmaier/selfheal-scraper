# selfheal-scraper

Forge — web extraction where an agent compiles deterministic extractors once and repairs
them when they break. The extractors run as plain code with no model in the loop.

`MASTER-PLAN.md` is the spec, `schema.sql` is the DDL, `migrations/` holds changes to it.

## The shape of it

Two tiers that never share a process:

- **Forge** (`apps/forge-worker`) — expensive, rare. A model explores a site once and
  writes extractor code, and repairs it when it breaks. Anthropic or OpenAI; the loop
  itself knows about neither.
- **Runtime** (`apps/runtime-worker`) — cheap, constant. Executes stored code. **Never
  calls a model.** It does not even load the Anthropic SDK, which is what makes that rule
  enforced rather than merely stated.

The artifact between them is a row in Postgres holding executable JS, a fetch plan and a
code hash. Adding a site is inserting a row; repair is inserting a row with `version + 1`;
rollback is flipping a status column.

```
packages/
  core/      contract types, acorn validator, node:vm sandbox, esbuild transpile,
             promotion gate, health math
  db/        drizzle schema over schema.sql, queue, record upsert + outbox, adapters
  fetch/     undici http tier, playwright browser tier, bot-challenge detection
apps/
  runtime-worker/  scheduler tick + job claim loop + health + canary routing
  forge-worker/    compile_run claim loop + the agent, its 5 tools and 2 prompts
adapters/
  hn-algolia/      hand-written, http tier, real captured fixtures
  willhaben/       hand-written, browser tier, SYNTHETIC fixtures (see its README)
```

Postgres is the only infrastructure dependency. No Redis, no broker, no object store.

## Running it

```sh
pnpm install
pnpm test         # offline: no network, no database
pnpm test:db      # needs DATABASE_URL
pnpm typecheck
```

Both workers have a `--once` mode that drains their queue and exits, which is what the
scheduled GitHub Actions workflows use — no host to run, nothing costing money between
ticks. `.github/workflows/` has the scrape cron, the forge cron, and CI.

```sh
node apps/runtime-worker/src/main.ts --once
node apps/forge-worker/src/main.ts --once                       # provider from whichever key is set
node apps/forge-worker/src/main.ts --once --provider=openai --model=gpt-5.5
```

### Environment

| variable | what it does |
|---|---|
| `DATABASE_URL` | the only required one |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | whichever is set picks the provider when `--provider` is omitted |
| `FORGE_MODEL_PRICING` | per-MTok rates for models the built-in table does not carry, e.g. `{"gpt-5.5":{"inputPerMTok":2,"outputPerMTok":8}}`. Without it `compile_run.cost_usd` stays null rather than guessing |
| `CHROMIUM_EXECUTABLE_PATH` | use a pre-installed Chromium instead of playwright's pinned build |
| `HTTPS_PROXY` / `NO_PROXY` | undici picks these up itself; the browser tier has to be told at launch, and is |

### Swapping the model provider

`ModelClient` in `apps/forge-worker/src/model.ts` is the whole boundary — one interface,
a neutral `AgentTurn` transcript, and token counts. `anthropic-model.ts` and
`openai-model.ts` are each about 120 lines and the agent loop imports neither.

The transcript type is the part that earns its keep. Anthropic wants tool results inside a
user message; the OpenAI Responses API wants them as sibling items in a flat array matched
by `call_id`. `AgentTurn` has a `tool_results` case rather than pretending results are user
text, so neither provider's shape leaks into the loop.

## Milestones

All five are implemented. M1's verification harness is the part everything else rests on.

| | contains | proven by |
|---|---|---|
| M1 | contract, validator, sandbox, transpile, gate | a hand-written adapter passing 3 committed fixtures offline |
| M2 | db, queue, record upsert, change feed, fetch tiers, runtime worker | the worker loop end to end against real Postgres |
| M3 | run metrics, health window, degradation, canary routing | a broken selector trips degradation without corrupting records |
| M4 | forge worker, compile agent, 5 tools, promotion gate | gpt-5.5 compiling a working Hacker News adapter from intent alone, live |
| M5 | repair agent, canary promotion, rollback | a repair lands as a canary; an unrepairable break fails loudly |

The plan says not to start M4 until M1-M3 have run unattended for a week against two real
sites. That has not happened. One compile has succeeded live and the runtime tier has run
against two real sites, but nothing has run *unattended over time*, `adapters/willhaben`
ships synthetic fixtures, and the repair loop has only ever seen a scripted model. The
next thing worth doing is letting the cron workflows run for a week and reading what the
health window says, not adding features.

## Where this deviates from the master plan

Each of these is explained in a comment where it happens.

### The sandbox (section 7)

**1. Subtract from the realm, never inject into it.** The plan says the context should
hold "only `JSON, Object, Array, ...`". Read as injecting the *host* intrinsics, that is a
complete escape — host `Object.constructor` *is* the host `Function`:

```js
Object.constructor('return process.env.HOME')()   // -> /root
```

A fresh `vm` context already has its own intrinsics, so the allowlist is applied by
deleting everything not on it.

**2. `Object.create(null)` is necessary but not sufficient.** It blocks
`input.constructor`, as the plan says. But `json` and `doc` are functions hanging off that
object, and a *host* function leaks the host realm through `input.json.constructor`
regardless of the prototype. `ExtractInput` is built inside the realm instead, and
`json()` parses with the sandbox's own `JSON`.

**3. `Object.freeze(globalThis)` doesn't work** — V8 refuses to freeze a contextified
global. Each surviving global is pinned non-writable and non-configurable individually.

**4. Values and errors crossing back out are normalized.** Not addressed in the plan.
Sandbox-realm values fail `instanceof` on the host and keep the context alive; that is
true even of Node's own CPU-cap error, so a worker doing `catch (e) { if (e instanceof
Error) }` would mishandle its own timeouts.

**Known limitation, unchanged:** `doc()` parses with linkedom on the host, so the Document
carries host prototypes and `input.doc().constructor.constructor` reaches the host realm.
Section 7 says as much. The real fix is its second mitigation — a dedicated child process
with no credentials and no network egress. A test pins the hole so it fails loudly if
someone closes it without updating the plan.

### The validator (section 5)

**5. It type-strips before it parses.** acorn does not parse TypeScript and `code_ts` is
TypeScript. One wrinkle worth knowing: esbuild drops an *unused* value import as if it
were a type import, so `verbatimModuleSyntax` is needed or `import fs from 'node:fs'`
vanishes before the validator sees it.

### Runtime and health (sections 3, 6, 8)

**6. `blocked` is a new run outcome, and the health window ignores it.** A bot challenge
answers 200 with a real HTML body. Recorded as `empty`, three of them trip degradation and
queue a repair the agent cannot possibly complete, because the adapter was never wrong —
and the repair then works against fixtures that are themselves challenge pages. This came
straight from reading a working production scraper, and it is the most valuable single
change here.

**7. Records can disappear.** `change_event.kind` gains `gone`, and `record` gains
`is_active`/`gone_at`. Nothing in the plan represented a delisted listing or a filled job.

**8. The absence sweep needs a completeness guard.** `run.complete` is false when a run
stopped early, and the sweep refuses without it. A partial result set marking every
unreached record gone is the one genuinely destructive failure mode in the system.

**9. Two sections disagree about partial writes.** Section 6 says write "only for valid
items"; section 3 says "nothing is written to `record` from a run whose items fail
validation". Valid items are written, and the absence sweep additionally requires a clean
run — which preserves section 3's actual guarantee ("a broken site produces a stale
source, never a corrupted one") without discarding good rows over one bad one.

**10. Nothing says how `record.external_key` is derived.** The schema requires
`unique(source_id, external_key)` and adapters return opaque `unknown[]`, with nothing
connecting them. The rule here is `fetch_hints.externalKeyField`, else the first of
`externalKey`, `id`, `key`. An item with no usable key is invalid rather than getting a
synthetic one — hashing the payload would make every edit look like a new record.

**11a. `undici.request` does not decompress.** Not a plan deviation, a bug worth naming:
unlike `fetch`, it hands back the raw body. Sending `accept-encoding: gzip` and reading it
as utf8 gives binary noise — the adapter extracts nothing, the challenge detector calls it
blocked, and nothing says "this is compressed". Most of the web is gzipped, so this broke
almost every real site while the one JSON endpoint under test happened to answer
uncompressed. Found by pointing a live compile at Hacker News.

**11b. Nothing paced itself.** The queue claims jobs as fast as it can, so a source with
fifty item URLs would hit one host fifty times a second — how a working scraper becomes a
blocked one. `httpFetch` now enforces a per-host minimum interval, default 1s, with
`fetch_hints.minIntervalMs` for sites that ask for more (Hacker News asks for 30).

**11. Fetch escalation is recorded, not silent.** `fetch_plan.tier` is a static choice in
the plan. A site that served JSON to plain HTTP last week can start challenging it, so the
http tier escalates to the browser on `blocked` only — never on a 404 or a reset, which
will not read differently through a browser — and `run.tier_used`/`run.escalated` record
what happened. A source that escalates every run has a compile problem, not a fetch one.

### The gate and the agent (sections 5, 9)

**12. One gate clause isn't machine-decidable.** "…or the compile run explains the diff" —
code cannot adjudicate prose. The gate reports the mismatch as blocking and leaves the
override to whoever reads the compile run.

**13. `code_hash` is not a version identity.** `sha256(code_js)` with comments stripped
means two `code_ts` versions differing only in comments collide. Correct for a script
cache key; `unique (source_id, version)` is the identity.

**14. A repair lands as a canary; a fresh compile goes active directly.** The plan says
repairs produce a canary (section 8 step 4) but never says what happens to a first
compile. There is no incumbent to protect, and it has already passed the gate, so it is
promoted.

## What has actually been run against live sites

- **The runtime tier**, against `hn.algolia.com`: two consecutive runs, 59 records from 60
  items (one story appears in two queries, so dedup by `external_key` is doing its job),
  second run wrote nothing and emitted no change events.
- **The agent tier**, against `news.ycombinator.com` with `gpt-5.5`: compiled a working
  adapter from intent alone in 8 tool calls — fetch, probe, two more fetches, two
  `query_dom` probes, `run_extract` (90 items, 90 valid), `save_adapter`. 38.4K input and
  5.3K output tokens. The adapter it wrote anchors on `tr.athing[id]` and reaches each
  row's score through `#score_<id>` — the id-first pattern the prompt teaches — and
  correctly returns null for the one job posting with no score, author or link.
- **The runtime tier running that agent-written adapter**: 30 records, all valid.

Not exercised live: the browser tier. Chromium's HTTPS is reset by this sandbox's proxy
whichever way it is configured, though it reaches the proxy over plain HTTP, so the
`executablePath` and proxy plumbing is right and the tier is unproven. The repair loop has
also only been run against a scripted model, not a real break on a real site.

## Notes carried over from an existing production scraper

Reading `EricStrohmaier/willhaben-scraper` changed more of this design than reading the
plan did. Beyond the `blocked` outcome and the absence sweep above:

- **Anchor on the card's own id.** Find one anchor per repeating unit, read its id out of
  its own `data-testid`, address every other field with a selector built from that id.
  Nothing is then positional. This is now the worked example in the compile prompt.
- **Locale-aware parsing has no error mode.** `€ 1.234,56` read the en-US way gives a
  plausible wrong number, not an exception. It gets its own test.
- **A next-page button stays in the DOM on the last page**, marked disabled. Following it
  blindly walks in a circle.
- **Consent walls hide the content**, so a fixture captured without dismissing one teaches
  the agent to write selectors against a cookie dialog.
- **Escalating fetch tiers**, cheapest first, only climbing on a soft failure.
