import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'

import { transpile } from '@forge/core'
import {
  activeAdapter,
  canaryAdapter,
  captureFixture,
  close,
  connect,
  createSource,
  getSource,
  insertAdapter,
  migrate,
  queueCompileRun,
  type Db,
  type SourceRow,
} from '@forge/db'
import type { executeFetchPlan, ExecuteResult } from '@forge/fetch'

import { runAgent, COMPILE_ITERATION_CAP, REPAIR_ITERATION_CAP } from '../src/agent.ts'
import type { CompleteRequest, ModelClient, ModelResponse } from '../src/model.ts'
import { step } from '../src/worker.ts'
import { outlinePage } from '../src/outline.ts'
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const url = process.env['DATABASE_URL']
const skip = url ? false : 'DATABASE_URL is not set'

let db: Db
let sourceId: string

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title'],
  properties: { id: { type: 'string' }, title: { type: 'string', minLength: 1 } },
}

const GOOD_CODE = `
export function extract(input) {
  const data = input.json()
  return (data.items || []).map((i) => ({ id: i.id, title: i.title }))
}
`

const PAYLOAD = JSON.stringify({
  items: [
    { id: 'a', title: 'Alpha' },
    { id: 'b', title: 'Beta' },
  ],
})

/**
 * A scripted model. Every turn is written out in advance, which is what lets the loop,
 * the tool dispatch, the iteration cap and the gate integration all be tested with no
 * network, no API key and no spend.
 */
class FakeModel implements ModelClient {
  readonly model = 'claude-opus-5'
  readonly requests: CompleteRequest[] = []
  #turns: ModelResponse[]

  constructor(turns: Array<Partial<ModelResponse>>) {
    this.#turns = turns.map((turn) => ({
      stopReason: turn.content?.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      content: [],
      usage: { inputTokens: 1000, outputTokens: 200 },
      ...turn,
    }))
  }

  async complete(request: CompleteRequest): Promise<ModelResponse> {
    this.requests.push(request)
    const turn = this.#turns.shift()
    if (!turn) return { stopReason: 'end_turn', content: [], usage: { inputTokens: 10, outputTokens: 5 } }
    return turn
  }
}

let toolCounter = 0
function useTool(name: string, input: Record<string, unknown>): Partial<ModelResponse> {
  return { content: [{ type: 'tool_use', id: `tool_${++toolCounter}`, name, input }] }
}
function say(text: string): Partial<ModelResponse> {
  return { content: [{ type: 'text', text }] }
}

function fakeFetcher(body = PAYLOAD): typeof executeFetchPlan {
  return async () => ({
    ok: true,
    outcome: 'ok',
    tier: 'http',
    status: 200,
    fetchMs: 5,
    bytes: body.length,
    body,
    headers: { 'content-type': 'application/json' },
    escalated: false,
  })
}

before(async () => {
  if (!url) return
  db = connect({ url })
  await migrate(db, { root })
})
after(async () => {
  if (!url) return
  await close(db)
})

beforeEach(async () => {
  if (!url) return
  await db.execute(sql`truncate runtime.change_event, runtime.record, runtime.run, runtime.job restart identity cascade`)
  await db.execute(sql`truncate forge.compile_step, forge.compile_run, forge.fixture, forge.adapter, forge.source cascade`)
  sourceId = await createSource(db, {
    key: `agent/${Math.random().toString(36).slice(2)}`,
    intent: 'Items with an id and a title.',
    entryUrl: 'https://example.test/items',
    outputSchema: OUTPUT_SCHEMA,
    requiredFields: ['id', 'title'],
  })
})

async function source(): Promise<SourceRow> {
  const row = await getSource(db, sourceId)
  assert.ok(row)
  return row
}

async function seedFixtures(count = 3, body = PAYLOAD): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    ids.push(
      await captureFixture(db, {
        sourceId,
        url: `https://example.test/items?page=${i}`,
        tier: 'http',
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body,
      }),
    )
  }
  return ids
}

const PLAN = { tier: 'http' as const, urlTemplate: 'https://example.test/items' }

describe('the tool allowlist is exactly section 9', () => {
  test('five tools, no more', () => {
    assert.deepEqual(
      TOOL_DEFINITIONS.map((t) => t.name).sort(),
      ['fetch_page', 'probe_network', 'query_dom', 'run_extract', 'save_adapter'],
    )
  })

  test('there is no shell, filesystem or free-network tool', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name).join(' ')
    for (const forbidden of ['bash', 'shell', 'exec', 'read_file', 'write_file', 'http']) {
      assert.equal(names.includes(forbidden), false, `found ${forbidden}`)
    }
  })
})

describe('page outline', () => {
  test('a JSON endpoint reports its item arrays and their keys', () => {
    const outline = outlinePage(PAYLOAD, 'application/json')
    assert.equal(outline.kind, 'json')
    assert.equal(outline.itemArrays?.[0]?.path, '$.items')
    assert.equal(outline.itemArrays?.[0]?.length, 2)
    assert.deepEqual(outline.itemArrays?.[0]?.keys, ['id', 'title'])
  })

  test('embedded JSON is surfaced ahead of the DOM', () => {
    const html = `<html><head><script id="__NEXT_DATA__">{"props":{"items":[1,2,3]}}</script></head><body><main>hi</main></body></html>`
    const outline = outlinePage(html, 'text/html')
    assert.equal(outline.kind, 'html')
    assert.equal(outline.embeddedJson?.[0]?.source, '__NEXT_DATA__')
  })

  test('repeated data-testid stems are grouped into one prefix anchor', () => {
    const cards = Array.from(
      { length: 5 },
      (_, i) => `<a data-testid="result-header-${1000 + i}">Item ${i}</a>`,
    ).join('')
    const outline = outlinePage(`<html><body>${cards}</body></html>`, 'text/html')
    const anchor = outline.anchors?.[0]
    assert.equal(anchor?.count, 5)
    assert.match(anchor?.selector ?? '', /\[data-testid\^="result-header"\]/)
  })
})

describe('tools: run_extract', { skip }, () => {
  test('rejects code that breaks a static rule before running it', async () => {
    await seedFixtures(1)
    const result = await executeTool(
      { db, source: await source(), compileRunId: crypto.randomUUID(), saveAs: 'draft' },
      'run_extract',
      { code: `export function extract(i) { return [process.env] }` },
    )
    const output = result.output as { rejected: boolean; violations: Array<{ rule: string }> }
    assert.equal(output.rejected, true)
    assert.ok(output.violations.some((v) => v.rule === 'forbidden-identifier'))
  })

  test('reports items and validation for working code', async () => {
    await seedFixtures(1)
    const result = await executeTool(
      { db, source: await source(), compileRunId: crypto.randomUUID(), saveAs: 'draft' },
      'run_extract',
      { code: GOOD_CODE },
    )
    const output = result.output as { passed: boolean; sample_items: unknown[] }
    assert.equal(output.passed, true)
    assert.deepEqual(output.sample_items, [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ])
  })

  test('says so when there are no fixtures yet', async () => {
    const result = await executeTool(
      { db, source: await source(), compileRunId: crypto.randomUUID(), saveAs: 'draft' },
      'run_extract',
      { code: GOOD_CODE },
    )
    assert.match(String((result.output as { error: string }).error), /no fixtures/)
  })
})

describe('tools: save_adapter', { skip }, () => {
  const ctx = async (saveAs: 'draft' | 'canary' = 'draft') => ({
    db,
    source: await source(),
    compileRunId: (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? '',
    saveAs,
  })

  test('refuses to save below the 3-fixture floor', async () => {
    await seedFixtures(2)
    const result = await executeTool(await ctx(), 'save_adapter', {
      code: GOOD_CODE,
      fetch_plan: PLAN,
      notes: 'items come from $.items',
    })
    const output = result.output as { saved: boolean; hint: string }
    assert.equal(output.saved, false)
    assert.match(output.hint, /at least 3 fixtures/)
  })

  test('saves and reports the gate result once the corpus is big enough', async () => {
    await seedFixtures(3)
    const result = await executeTool(await ctx(), 'save_adapter', {
      code: GOOD_CODE,
      fetch_plan: PLAN,
      notes: 'items come from $.items',
    })
    assert.equal((result.output as { saved: boolean }).saved, true)
    assert.ok(result.savedAdapterId)
  })

  test('refuses code that breaks a static rule', async () => {
    await seedFixtures(3)
    const result = await executeTool(await ctx(), 'save_adapter', {
      code: `export function extract(i) { return [...i.doc().querySelectorAll('div > div > span')] }`,
      fetch_plan: PLAN,
      notes: 'x',
    })
    const output = result.output as { saved: boolean; violations: Array<{ rule: string }> }
    assert.equal(output.saved, false)
    assert.ok(output.violations.some((v) => v.rule === 'positional-selector'))
  })

  /** The rule the whole self-healing story rests on. */
  test('no tool can write output_schema or required_fields', async () => {
    await seedFixtures(3)
    const before = await source()
    for (const tool of TOOL_DEFINITIONS) {
      await executeTool(await ctx(), tool.name, {
        url: 'https://example.test/x',
        tier: 'http',
        code: GOOD_CODE,
        fetch_plan: PLAN,
        notes: 'x',
        selector: 'div',
        fixture_id: crypto.randomUUID(),
        output_schema: { type: 'object' },
        required_fields: [],
      }).catch(() => undefined)
    }
    const after = await source()
    assert.deepEqual(after.output_schema, before.output_schema)
    assert.deepEqual(after.required_fields, before.required_fields)
  })
})

describe('the compile loop', { skip }, () => {
  test('runs tools, saves an adapter, and logs every step', async () => {
    const fixtureIds = await seedFixtures(3)
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    const model = new FakeModel([
      useTool('run_extract', { code: GOOD_CODE, fixture_ids: fixtureIds }),
      useTool('save_adapter', { code: GOOD_CODE, fetch_plan: PLAN, notes: 'items come from $.items' }),
      say('done'),
    ])

    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher(),
    })

    assert.equal(outcome.succeeded, true)
    assert.ok(outcome.adapterId)
    assert.equal(outcome.iterations, 2)
    assert.equal(outcome.tokensIn, 2000)
    assert.ok((outcome.costUsd ?? 0) > 0)

    const steps = await db.execute<{ n: number; tool: string }>(
      sql`select n, tool from forge.compile_step where compile_run_id = ${compileRunId}::uuid order by n`,
    )
    assert.deepEqual(steps.map((s) => s.tool), ['run_extract', 'save_adapter'])
  })

  test('a gate failure comes back to the model instead of ending the run', async () => {
    await seedFixtures(2) // below the floor, so the first save fails
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    const model = new FakeModel([
      useTool('save_adapter', { code: GOOD_CODE, fetch_plan: PLAN, notes: 'first try' }),
      useTool('fetch_page', { url: 'https://example.test/items?page=3', tier: 'http' }),
      useTool('save_adapter', { code: GOOD_CODE, fetch_plan: PLAN, notes: 'second try' }),
    ])

    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher(),
    })
    assert.equal(outcome.succeeded, true)
    assert.equal(outcome.iterations, 3)
  })

  test('the iteration cap is enforced, not merely requested', async () => {
    await seedFixtures(3)
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    // Twenty attempts at a tool that never saves anything.
    const model = new FakeModel(
      Array.from({ length: 20 }, () => useTool('query_dom', { fixture_id: 'nope', selector: 'div' })),
    )

    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher(),
    })
    assert.equal(outcome.succeeded, false)
    assert.equal(outcome.iterations, COMPILE_ITERATION_CAP)
    assert.match(outcome.message, /iteration cap/)
  })

  test('a repair gets the tighter 8-call cap', async () => {
    assert.equal(REPAIR_ITERATION_CAP, 8)
    await seedFixtures(3)
    await insertAdapter(db, {
      sourceId, fetchPlan: PLAN, ...transpile(GOOD_CODE), status: 'active',
    })
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'repair' })) ?? ''
    const model = new FakeModel(
      Array.from({ length: 20 }, () => useTool('query_dom', { fixture_id: 'nope', selector: 'div' })),
    )
    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'repair', fetcher: fakeFetcher(),
    })
    assert.equal(outcome.iterations, REPAIR_ITERATION_CAP)
  })

  test('a refusal ends the run cleanly rather than looping', async () => {
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    const model = new FakeModel([
      { stopReason: 'refusal', content: [], refusal: { category: 'cyber', explanation: 'no' } },
    ])
    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher(),
    })
    assert.equal(outcome.succeeded, false)
    assert.match(outcome.message, /declined/)
  })

  test('the system prompt and tool list are byte-identical across turns, so they cache', async () => {
    await seedFixtures(3)
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    const model = new FakeModel([
      useTool('run_extract', { code: GOOD_CODE }),
      useTool('run_extract', { code: GOOD_CODE }),
      say('giving up'),
    ])
    await runAgent({ db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher() })

    assert.ok(model.requests.length >= 2)
    const [first, second] = model.requests
    assert.equal(first?.system, second?.system)
    assert.deepEqual(first?.tools, second?.tools)
  })

  test('parallel tool calls all return in one user message', async () => {
    await seedFixtures(1)
    const compileRunId = (await queueCompileRun(db, { sourceId, kind: 'compile' })) ?? ''
    const model = new FakeModel([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'run_extract', input: { code: GOOD_CODE } },
          { type: 'tool_use', id: 't2', name: 'run_extract', input: { code: GOOD_CODE } },
        ],
      },
      say('done'),
    ])
    await runAgent({ db, model, source: await source(), compileRunId, kind: 'compile', fetcher: fakeFetcher() })

    const followUp = model.requests[1]?.turns.at(-1)
    assert.equal(followUp?.role, 'tool_results')
    assert.equal(followUp?.role === 'tool_results' ? followUp.results.length : 0, 2)
  })
})

describe('the repair loop', { skip }, () => {
  async function seedBrokenSource() {
    await seedFixtures(3)
    await insertAdapter(db, {
      sourceId,
      fetchPlan: PLAN,
      ...transpile(GOOD_CODE),
      notes: 'items come from $.items; title is i.title',
      status: 'active',
    })
    return (await queueCompileRun(db, {
      sourceId,
      kind: 'repair',
      trigger: { trips: [{ rule: 'required-field-null-rate' }] },
      input: { failingFields: ['title'] },
    })) as string
  }

  test('the repair prompt carries the current code, its notes and the health report', async () => {
    const compileRunId = await seedBrokenSource()
    const model = new FakeModel([say('diagnosing')])
    await runAgent({
      db, model, source: await source(), compileRunId, kind: 'repair',
      trigger: { trips: [{ rule: 'required-field-null-rate' }] },
      failingFields: ['title'],
      fetcher: fakeFetcher(),
    })

    const first = model.requests[0]?.turns[0]
    const opening = first?.role === 'user' ? first.text : ''
    assert.match(opening, /items come from \$\.items/)
    assert.match(opening, /required-field-null-rate/)
    assert.match(opening, /Fields going null: title/)
    assert.match(opening, /export function extract/)
  })

  test('a repair lands as a canary, never straight over the incumbent', async () => {
    const compileRunId = await seedBrokenSource()
    const fixed = GOOD_CODE.replace('i.title', 'i.title || i.heading')
    const model = new FakeModel([
      useTool('save_adapter', { code: fixed, fetch_plan: PLAN, notes: 'title moved to heading' }),
      say('repaired'),
    ])
    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'repair', fetcher: fakeFetcher(),
    })

    assert.equal(outcome.succeeded, true)
    const canary = await canaryAdapter(db, sourceId)
    assert.equal(canary?.id, outcome.adapterId)
    assert.equal(canary?.version, 2)
    // The incumbent is untouched — it is at least partly working, and the canary has to
    // earn its place over 20 runs before displacing it.
    assert.equal((await activeAdapter(db, sourceId))?.version, 1)
  })

  /**
   * Section 9: "If the site genuinely stopped publishing a required field, the correct
   * outcome is a failed repair with that finding." A repair that reports rather than
   * papers over is the success case for this test.
   */
  test('a repair that finds the field genuinely gone fails without saving', async () => {
    const compileRunId = await seedBrokenSource()
    const model = new FakeModel([
      useTool('query_dom', { fixture_id: 'x', selector: '[data-title]' }),
      say('The site no longer publishes a title anywhere in the response. This is not repairable without changing output_schema, which I may not do.'),
    ])
    const outcome = await runAgent({
      db, model, source: await source(), compileRunId, kind: 'repair', fetcher: fakeFetcher(),
    })

    assert.equal(outcome.succeeded, false)
    assert.match(outcome.message, /no longer publishes a title/)
    assert.equal(await canaryAdapter(db, sourceId), null)
    assert.equal((await activeAdapter(db, sourceId))?.version, 1)
  })
})

describe('the forge worker', { skip }, () => {
  test('claims a run, records cost and tokens, and promotes a fresh compile', async () => {
    await seedFixtures(3)
    await queueCompileRun(db, { sourceId, kind: 'compile', trigger: { manual: true } })
    const model = new FakeModel([
      useTool('save_adapter', { code: GOOD_CODE, fetch_plan: PLAN, notes: 'from $.items' }),
      say('done'),
    ])

    const report = await step({ db, model, fetcher: fakeFetcher() })
    assert.equal(report?.outcome.succeeded, true)

    const rows = await db.execute<{
      state: string; model: string; tokens_in: number; cost_usd: string; iterations: number
    }>(sql`select state, model, tokens_in, cost_usd, iterations from forge.compile_run`)
    assert.equal(rows[0]?.state, 'succeeded')
    assert.equal(rows[0]?.model, 'claude-opus-5')
    assert.equal(rows[0]?.tokens_in, 1000)
    assert.ok(Number(rows[0]?.cost_usd) > 0)

    // A fresh compile has no incumbent, so the draft goes active directly.
    assert.equal((await activeAdapter(db, sourceId))?.id, report?.outcome.adapterId)
    assert.equal((await source()).state, 'active')
  })

  test('a failed compile records why and leaves the source out of active', async () => {
    await queueCompileRun(db, { sourceId, kind: 'compile' })
    const model = new FakeModel([say('I could not find any items on this page.')])

    const report = await step({ db, model, fetcher: fakeFetcher() })
    assert.equal(report?.outcome.succeeded, false)

    const rows = await db.execute<{ state: string; error: string }>(
      sql`select state, error from forge.compile_run`,
    )
    assert.equal(rows[0]?.state, 'failed')
    assert.match(rows[0]?.error ?? '', /could not find any items/)
    assert.equal((await source()).state, 'new')
  })

  test('a failed repair returns the source to degraded so it can be retried', async () => {
    await seedFixtures(3)
    await insertAdapter(db, {
      sourceId, fetchPlan: PLAN, ...transpile(GOOD_CODE), status: 'active',
    })
    await queueCompileRun(db, { sourceId, kind: 'repair' })
    const model = new FakeModel([say('the field is gone')])

    await step({ db, model, fetcher: fakeFetcher() })
    assert.equal((await source()).state, 'degraded')
  })

  test('step returns null on an empty queue', async () => {
    assert.equal(await step({ db, model: new FakeModel([]), fetcher: fakeFetcher() }), null)
  })
})
