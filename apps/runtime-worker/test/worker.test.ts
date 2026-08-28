import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'

import { transpile } from '@forge/core'
import {
  activeAdapter,
  close,
  connect,
  createSource,
  enqueue,
  getSource,
  insertAdapter,
  migrate,
  promoteToCanary,
  readChangeEvents,
  recordRun,
  type Db,
} from '@forge/db'
import type { ExecuteResult } from '@forge/fetch'

import { externalKeyOf, pickAdapter, processJob } from '../src/pipeline.ts'
import { evaluateCanary, updateHealth } from '../src/health-step.ts'
import { runOnce, step, tick } from '../src/worker.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const url = process.env['DATABASE_URL']
const skip = url ? false : 'DATABASE_URL is not set'

let db: Db
let sourceId: string

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    price: { type: ['number', 'null'] },
  },
}

/** A working adapter over a tiny JSON shape. */
const GOOD = transpile(`
  export function extract(input) {
    const data = input.json()
    return (data.items || []).map((i) => ({ id: i.id, title: i.title, price: i.price ?? null }))
  }
`)

/**
 * What a break actually looks like: the *site* changes, the adapter does not. The adapter
 * keeps reading `title`, the response now calls it `heading`, and every item comes out
 * missing its title and failing output_schema.
 */
function brokenPayload(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ items: items.map(({ title, ...rest }) => ({ ...rest, heading: title })) })
}

function body(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ items })
}

/** Offline fetcher. No network is reachable from this suite by construction. */
function fetcherFor(payload: string, overrides: Partial<ExecuteResult> = {}) {
  return async (): Promise<ExecuteResult> => ({
    ok: true,
    outcome: 'ok',
    tier: 'http',
    status: 200,
    fetchMs: 5,
    bytes: payload.length,
    body: payload,
    headers: { 'content-type': 'application/json' },
    escalated: false,
    ...overrides,
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
  // restart identity so job ids are predictable — canary routing is a function of them
  await db.execute(sql`truncate runtime.change_event, runtime.record, runtime.run, runtime.job restart identity cascade`)
  await db.execute(sql`truncate forge.compile_step, forge.compile_run, forge.fixture, forge.adapter, forge.source cascade`)
  sourceId = await createSource(db, {
    key: `wt/${Math.random().toString(36).slice(2)}`,
    intent: 'worker test',
    entryUrl: 'https://example.test/list',
    outputSchema: OUTPUT_SCHEMA,
    requiredFields: ['id', 'title'],
    cadence: '1 hour',
  })
  await insertAdapter(db, {
    sourceId,
    fetchPlan: { tier: 'http', urlTemplate: 'https://example.test/list' },
    codeTs: 'x',
    codeJs: GOOD.codeJs,
    codeHash: GOOD.codeHash,
    status: 'active',
  })
})

async function source() {
  const row = await getSource(db, sourceId)
  assert.ok(row)
  return row
}

async function claimAndProcess(payload: string, overrides: Partial<ExecuteResult> = {}) {
  await enqueue(db, { sourceId, url: 'https://example.test/list', externalKey: 'list' })
  const rows = await db.execute<{ id: number }>(sql`select id from runtime.job limit 1`)
  const jobId = rows[0]?.id
  assert.ok(jobId)
  return processJob(
    db,
    await source(),
    { id: jobId, source_id: sourceId, url: 'https://example.test/list', external_key: 'list', priority: 100, attempts: 1 },
    { fetcher: fetcherFor(payload, overrides) },
  )
}

describe('pure routing helpers', () => {
  test('external_key comes from externalKey, id, or key in that order', () => {
    assert.equal(externalKeyOf({ id: 'a' }), 'a')
    assert.equal(externalKeyOf({ externalKey: 'x', id: 'a' }), 'x')
    assert.equal(externalKeyOf({ key: 'k' }), 'k')
    assert.equal(externalKeyOf({ id: 42 }), '42')
    assert.equal(externalKeyOf({ sku: 'q' }, 'sku'), 'q')
  })

  test('an item with no usable key is rejected rather than given a synthetic one', () => {
    assert.equal(externalKeyOf({ title: 'no key' }), null)
    assert.equal(externalKeyOf(null), null)
    assert.equal(externalKeyOf('a string'), null)
  })

  const adapterStub = (id: string) => ({ id }) as never

  test('canary routing is deterministic and takes roughly 10%', () => {
    const active = adapterStub('active')
    const canary = adapterStub('canary')
    let canaryHits = 0
    for (let jobId = 0; jobId < 100; jobId++) {
      if (pickAdapter(active, canary, jobId)?.isCanary) canaryHits++
    }
    assert.equal(canaryHits, 10)
    // Same job, same answer, every time.
    assert.equal(pickAdapter(active, canary, 3)?.isCanary, pickAdapter(active, canary, 3)?.isCanary)
  })

  test('with no canary every job goes to the active adapter', () => {
    const active = adapterStub('active')
    for (let jobId = 0; jobId < 20; jobId++) {
      assert.equal(pickAdapter(active, null, jobId)?.isCanary, false)
    }
  })

  test('with no adapter at all there is nothing to pick', () => {
    assert.equal(pickAdapter(null, null, 1), null)
  })
})

describe('pipeline: the happy path', { skip }, () => {
  test('extracts, validates, writes records and emits change events', async () => {
    const result = await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]))
    assert.equal(result.outcome, 'ok')
    assert.equal(result.items, 2)
    assert.equal(result.validItems, 2)
    assert.deepEqual(result.written, { inserted: 2, updated: 0, unchanged: 0 })

    const events = await readChangeEvents(db)
    assert.equal(events.length, 2)
    assert.ok(events.every((e) => e.kind === 'insert'))
  })

  test('a second identical run writes nothing new', async () => {
    const payload = body([{ id: 'a', title: 'A' }])
    await claimAndProcess(payload)
    const again = await claimAndProcess(payload)
    assert.deepEqual(again.written, { inserted: 0, updated: 0, unchanged: 1 })
    assert.equal((await readChangeEvents(db)).length, 1)
  })

  /**
   * processJob deliberately never sweeps. One job's keys are not the source's whole
   * result set when the source has several entry jobs, so the sweep is a source-level
   * decision the worker makes after the queue drains.
   */
  test('processJob never sweeps, whatever disappeared', async () => {
    await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]))
    const second = await claimAndProcess(body([{ id: 'a', title: 'A' }]))
    assert.equal(second.swept, 0)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 2)
  })

  test('the run row carries the tier and timings', async () => {
    await claimAndProcess(body([{ id: 'a', title: 'A' }]))
    const rows = await db.execute<{ outcome: string; tier_used: string; complete: boolean; items: number }>(
      sql`select outcome, tier_used, complete, items from runtime.run order by id desc limit 1`,
    )
    assert.equal(rows[0]?.outcome, 'ok')
    assert.equal(rows[0]?.tier_used, 'http')
    assert.equal(rows[0]?.complete, true)
    assert.equal(rows[0]?.items, 1)
  })
})

describe('pipeline: bad data never corrupts records', { skip }, () => {
  test('an invalid item is not written, and the run is schema_invalid', async () => {
    const result = await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: '' }]))
    assert.equal(result.outcome, 'schema_invalid')
    assert.equal(result.validItems, 1)
    assert.equal(result.written.inserted, 1)
  })

  /** The genuinely destructive failure mode, and the one thing that must never happen. */
  test('a partial extraction does not sweep the records it failed to produce', async () => {
    await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]))
    const partial = await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: '' }]))
    assert.equal(partial.swept, 0)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 2)
  })

  test('an empty extraction sweeps nothing', async () => {
    await claimAndProcess(body([{ id: 'a', title: 'A' }]))
    const empty = await claimAndProcess(body([]))
    assert.equal(empty.outcome, 'empty')
    assert.equal(empty.swept, 0)
  })

  test('a blocked fetch records a blocked run and writes nothing', async () => {
    const result = await claimAndProcess('<html>Just a moment</html>', {
      ok: false,
      outcome: 'blocked',
      body: '<html><title>Just a moment</title></html>',
      error: 'Cloudflare',
    })
    assert.equal(result.outcome, 'blocked')
    assert.equal(result.written.inserted, 0)
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from runtime.record`)
    assert.equal(rows[0]?.n, 0)
  })

  test('an adapter that throws is an exec_error, not a crash', async () => {
    const thrower = transpile(`export function extract(i) { throw new Error('anchor gone') }`)
    await db.execute(sql`update forge.adapter set code_js = ${thrower.codeJs}, code_hash = ${thrower.codeHash}`)
    const result = await claimAndProcess(body([{ id: 'a', title: 'A' }]))
    assert.equal(result.outcome, 'exec_error')
    assert.match(result.error ?? '', /anchor gone/)
  })

  test('a degraded source stops writing records entirely', async () => {
    await db.execute(sql`update forge.source set state = 'degraded' where id = ${sourceId}::uuid`)
    const result = await claimAndProcess(body([{ id: 'a', title: 'A' }]))
    assert.equal(result.outcome, 'ok')
    assert.deepEqual(result.written, { inserted: 0, updated: 0, unchanged: 0 })
  })
})

describe('health: a broken selector degrades without corrupting records', { skip }, () => {
  /**
   * The M3 definition of done, end to end: a deliberately broken selector trips
   * degradation, queues exactly one repair, and leaves every previously good record
   * intact and active.
   */
  test('the full degradation path', async () => {
    const payload = body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    await claimAndProcess(payload)
    const before = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(before[0]?.n, 2)

    // The site renames `title` to `heading`. The adapter is untouched and now yields
    // items with no title at all, which fail output_schema.
    const broken = brokenPayload([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
    for (let i = 0; i < 4; i++) {
      const run = await claimAndProcess(broken)
      assert.equal(run.outcome, 'schema_invalid')
      assert.equal(run.validItems, 0)
    }

    const action = await updateHealth(db, await source())
    assert.equal(action.action, 'degraded')
    assert.ok(action.report.trips.length > 0)
    assert.equal((await source()).state, 'degraded')

    // Records survived untouched.
    const after = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(after[0]?.n, 2)

    // Exactly one repair queued, however many runs failed.
    const repairs = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from forge.compile_run where source_id = ${sourceId}::uuid`,
    )
    assert.equal(repairs[0]?.n, 1)
  })

  test('a healthy source is never degraded', async () => {
    for (let i = 0; i < 5; i++) await claimAndProcess(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]))
    assert.equal((await updateHealth(db, await source())).action, 'none')
    assert.equal((await source()).state, 'active')
  })

  test('blocked runs alone never degrade a source', async () => {
    for (let i = 0; i < 5; i++) {
      await claimAndProcess('x', { ok: false, outcome: 'blocked', body: '<html>Just a moment</html>' })
    }
    const action = await updateHealth(db, await source())
    assert.equal(action.action, 'none')
    assert.equal(action.report.blocked, 5)
    assert.equal((await source()).state, 'active')
  })

  test('a fourth failed repair disables the source instead of queueing another', async () => {
    await db.execute(sql`
      insert into forge.compile_run (source_id, kind, state, finished_at)
      select ${sourceId}::uuid, 'repair', 'failed', now() from generate_series(1, 3)
    `)
    for (let i = 0; i < 4; i++) await claimAndProcess(brokenPayload([{ id: 'a', title: 'A' }]))

    const action = await updateHealth(db, await source())
    assert.equal(action.action, 'disabled')
    assert.equal((await source()).state, 'disabled')
  })
})

describe('canary promotion', { skip }, () => {
  async function addCanary(code = GOOD) {
    const canary = await insertAdapter(db, {
      sourceId,
      fetchPlan: { tier: 'http', urlTemplate: 'https://example.test/list' },
      codeTs: 'x',
      codeJs: code.codeJs,
      codeHash: `${code.codeHash}-canary`,
    })
    await promoteToCanary(db, canary.id)
    return canary
  }

  test('waits below 20 canary runs', async () => {
    const canary = await addCanary()
    for (let i = 0; i < 5; i++) {
      await recordRun(db, {
        jobId: null, sourceId, adapterId: canary.id, adapterVersion: canary.version,
        canary: true, outcome: 'ok', items: 10, validItems: 10,
      })
    }
    assert.equal((await evaluateCanary(db, await source())).action, 'wait')
  })

  test('promotes a canary that matches the active adapter over 20 runs', async () => {
    const canary = await addCanary()
    const active = await activeAdapter(db, sourceId)
    assert.ok(active)
    for (let i = 0; i < 20; i++) {
      await recordRun(db, {
        jobId: null, sourceId, adapterId: active.id, adapterVersion: active.version,
        canary: false, outcome: 'ok', items: 10, validItems: 10,
      })
      await recordRun(db, {
        jobId: null, sourceId, adapterId: canary.id, adapterVersion: canary.version,
        canary: true, outcome: 'ok', items: 10, validItems: 10,
      })
    }
    const verdict = await evaluateCanary(db, await source())
    assert.equal(verdict.action, 'promoted')
    assert.equal((await activeAdapter(db, sourceId))?.id, canary.id)
  })

  test('rejects a canary that yields less, leaving the active adapter alone', async () => {
    const canary = await addCanary()
    const active = await activeAdapter(db, sourceId)
    assert.ok(active)
    for (let i = 0; i < 20; i++) {
      await recordRun(db, {
        jobId: null, sourceId, adapterId: active.id, adapterVersion: active.version,
        canary: false, outcome: 'ok', items: 10, validItems: 10,
      })
      await recordRun(db, {
        jobId: null, sourceId, adapterId: canary.id, adapterVersion: canary.version,
        canary: true, outcome: 'ok', items: 3, validItems: 3,
      })
    }
    assert.equal((await evaluateCanary(db, await source())).action, 'rejected')
    assert.equal((await activeAdapter(db, sourceId))?.id, active.id)
  })

  test('a canary run never writes records', async () => {
    await addCanary()
    // Job id 1 falls in the canary bucket under the deterministic 10% rule.
    await enqueue(db, { sourceId, url: 'https://example.test/list', externalKey: 'list' })
    const jobRows = await db.execute<{ id: number }>(sql`select id from runtime.job limit 1`)
    const jobId = jobRows[0]?.id
    assert.ok(jobId !== undefined && pickAdapter({} as never, {} as never, jobId)?.isCanary)
    const result = await processJob(
      db,
      await source(),
      { id: jobId, source_id: sourceId, url: 'https://example.test/list', external_key: 'list', priority: 100, attempts: 1 },
      { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }])) },
    )
    assert.equal(result.canary, true)
    assert.deepEqual(result.written, { inserted: 0, updated: 0, unchanged: 0 })
  })
})

describe('the worker loop', { skip }, () => {
  test('the tick enqueues due sources and skips them once run', async () => {
    assert.equal((await tick(db)).queued, 1)
    // Already queued, so the upsert is a no-op rather than a duplicate.
    assert.equal((await tick(db)).queued, 1)
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from runtime.job`)
    assert.equal(rows[0]?.n, 1)
  })

  test('step returns null on an empty queue', async () => {
    assert.equal(await step(db), null)
  })

  test('runOnce ticks, drains, and reports', async () => {
    const reports = await runOnce(db, { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }])) })
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.outcome, 'ok')
    assert.equal(reports[0]?.written, 1)
    assert.equal(await step(db), null)
  })

  test('runOnce is a no-op when nothing is due', async () => {
    await runOnce(db, { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }])) })
    assert.deepEqual(await runOnce(db, { fetcher: fetcherFor(body([])) }), [])
  })

  test('a record that disappears is swept once the source drains', async () => {
    await runOnce(db, { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])) })
    await db.execute(sql`update runtime.run set created_at = created_at - interval '2 days'`)
    const reports = await runOnce(db, { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }])) })

    assert.equal(reports[0]?.swept, 1)
    const events = await readChangeEvents(db)
    assert.equal(events.at(-1)?.kind, 'gone')
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 1)
  })

  /**
   * The case the live run exposed: a source with several entry jobs has its result set
   * spread across them. Sweeping after each job would mark the previous job's records
   * gone, and the next job would do the same to those.
   */
  test('a source with several entry jobs is swept once, not once per job', async () => {
    await db.execute(sql`
      update forge.source
         set fetch_hints = '{"entryKeys":["one","two","three"]}'::jsonb
       where id = ${sourceId}::uuid
    `)
    await db.execute(sql`
      update forge.adapter
         set fetch_plan = '{"tier":"http","urlTemplate":"https://example.test/{key}"}'::jsonb
    `)

    // Each job returns a different record. None of them is the whole result set.
    let call = 0
    const perJob = async () => {
      const items = [{ id: `item-${++call}`, title: `Item ${call}` }]
      const payload = body(items)
      return {
        ok: true as const, outcome: 'ok' as const, tier: 'http' as const, status: 200,
        fetchMs: 1, bytes: payload.length, body: payload,
        headers: { 'content-type': 'application/json' }, escalated: false,
      }
    }

    const reports = await runOnce(db, { fetcher: perJob })
    assert.equal(reports.length, 3)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 3, 'all three jobs contributed records and none swept the others')
    assert.equal(reports.reduce((n, r) => n + r.swept, 0), 0)
  })

  test('one failed job stops the whole source being swept', async () => {
    await runOnce(db, { fetcher: fetcherFor(body([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])) })
    await db.execute(sql`update runtime.run set created_at = created_at - interval '2 days'`)

    // The fetch is blocked, so the result set is unknown, not empty.
    const reports = await runOnce(db, {
      fetcher: fetcherFor('x', { ok: false, outcome: 'blocked', body: '<html>Just a moment</html>' }),
    })
    assert.equal(reports[0]?.swept, 0)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 2, 'records survive a blocked run')
  })

  test('the tick expands fetch_hints.entryKeys into one job each', async () => {
    await db.execute(sql`
      update forge.source set fetch_hints = '{"entryKeys":["a","b"]}'::jsonb where id = ${sourceId}::uuid
    `)
    await db.execute(sql`
      update forge.adapter set fetch_plan = '{"tier":"http","urlTemplate":"https://example.test/{key}"}'::jsonb
    `)
    assert.equal((await tick(db)).queued, 2)
    const rows = await db.execute<{ url: string; external_key: string }>(
      sql`select url, external_key from runtime.job order by external_key`,
    )
    assert.deepEqual(rows.map((r) => r.url), ['https://example.test/a', 'https://example.test/b'])
  })

  /** entry_url is where the compile agent starts, not what the runtime fetches. */
  test('the tick fetches the fetch_plan, never the entry_url', async () => {
    await db.execute(sql`
      update forge.adapter set fetch_plan = '{"tier":"http","urlTemplate":"https://api.example.test/v2"}'::jsonb
    `)
    await tick(db)
    const rows = await db.execute<{ url: string }>(sql`select url from runtime.job`)
    assert.equal(rows[0]?.url, 'https://api.example.test/v2')
    assert.notEqual(rows[0]?.url, 'https://example.test/list')
  })

  test('a {key} template with no entryKeys is reported, not silently skipped', async () => {
    await db.execute(sql`
      update forge.adapter set fetch_plan = '{"tier":"http","urlTemplate":"https://example.test/{key}"}'::jsonb
    `)
    const messages: string[] = []
    const result = await tick(db, { log: (m) => messages.push(m) })
    assert.equal(result.queued, 0)
    assert.ok(messages.some((m) => m.includes('misconfigured')))
  })

  test('an aborted signal stops the drain', async () => {
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await runOnce(db, { signal: controller.signal, fetcher: fetcherFor(body([])) }), [])
  })
})
