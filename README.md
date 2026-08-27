# selfheal-scraper

Forge — web extraction where an agent compiles deterministic extractors once and repairs
them when they break. The extractors run as plain code with no model in the loop.

`MASTER-PLAN.md` is the spec. `schema.sql` is the Postgres DDL. **M1 is the only milestone
implemented.**

## What M1 is

M1 is the verification harness everything else depends on: the two boundaries that decide
whether model-written extractor code is allowed to exist and what happens when it runs.

```
packages/core/src/
  contract.ts    FetchPlan, ExtractInput, Adapter — master plan section 5
  validator.ts   acorn static rules, returns a violation list
  sandbox.ts     node:vm execution, 2s CPU cap, LRU by code_hash
  transpile.ts   code_ts -> code_js via esbuild, sha256 for code_hash
  gate.ts        the promotion gate — section 5
  fixtures.ts    reads a committed fixture corpus off disk

adapters/hn-algolia/
  extract.ts     one hand-written adapter (http tier, internal JSON endpoint)
  source.json    output_schema, required_fields, fetch_plan — human-owned
  fixtures/      3 gzipped real responses plus a manifest with golden output
```

Not built, deliberately: `packages/db`, `packages/fetch`, `apps/runtime-worker`,
`apps/forge-worker`. Those are M2 onward.

## Running it

```sh
pnpm install
pnpm test        # offline; no network, no database
pnpm typecheck
```

`pnpm test` proves the four things M1 is done when:

- the hand-written adapter extracts valid items from all 3 fixtures
- the promotion gate passes for it
- every static rule rejects its failing case
- every listed sandbox escape is blocked, including `input.constructor.constructor`

## Where this deviates from the master plan

Four places. Each one is explained in a comment at the point it happens.

**1. The sandbox subtracts from the realm rather than injecting into it.** Section 7 says
the context should contain "only `JSON, Object, Array, ...`". Read as injecting the host
intrinsics, that is a complete escape on its own — host `Object.constructor` *is* the host
`Function`:

```js
Object.constructor('return process.env.HOME')()   // -> /root
```

A fresh `vm` context already has its own realm intrinsics, so the allowlist is applied by
deleting everything not on it. `sandbox.test.ts` pins this.

**2. `Object.create(null)` on `ExtractInput` is necessary but not sufficient.** Section 7
credits it with blocking the escape, and it does block `input.constructor`. But `json` and
`doc` are functions hanging off that object, and a *host* function leaks the host realm
through `input.json.constructor` whether or not the object has a prototype. `ExtractInput`
is therefore built inside the realm, and `json()` parses with the sandbox's own `JSON`.

**3. The validator type-strips before it parses.** Section 5 says "parsed with acorn".
acorn does not parse TypeScript, and `code_ts` is TypeScript. esbuild erases the types
first and the rules run against that. Reported line numbers refer to the stripped source.

**4. Results are copied out of the realm.** Not addressed in the plan. Values returned by
an adapter are sandbox-realm objects; they fail `instanceof` on the host and keep the
context alive. They are JSON round-tripped at the boundary, which is the same normalization
`runtime.record.payload` would apply anyway. The same problem affects thrown errors — even
Node's own CPU-cap error arrives cross-realm — so every failure is re-thrown as a host
`SandboxError` carrying a `kind` that maps onto `runtime.run.outcome`.

## Known limitation

`node:vm` is a correctness boundary, not a security boundary — section 7 says so and it is
still true here. `doc()` parses with linkedom on the host, so the `Document` it returns
carries host prototypes and `input.doc().constructor.constructor` reaches the host realm.
The real fix is section 7's second mitigation: run extraction in a dedicated child process
with no credentials and no network egress. That is not M1. `sandbox.test.ts` pins the hole
so it fails loudly the day someone closes it.
