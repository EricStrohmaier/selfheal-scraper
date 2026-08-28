import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'

import { connect, close, type Db } from '../src/client.ts'
import { migrate, dropAll } from '../src/migrate.ts'
import { createSource, dueSources, getSourceByKey, setSourceState } from '../src/sources.ts'
import { claimJob, enqueue, failJob, finishJob, queueDepth, reclaimStaleJobs } from '../src/queue.ts'
import { contentHash, readChangeEvents, sweepAbsent, writeRecords } from '../src/records.ts'
import { insertAdapter, activeAdapter, canaryAdapter, promoteToActive, promoteToCanary, rollback } from '../src/adapters.ts'
import { recordRun, recentRuns } from '../src/runs.ts'
import { captureFixture, fixturesForSource, setExpected } from '../src/fixtures.ts'
import { claimCompileRun, failCompileRun, failedRepairCount, queueCompileRun } from '../src/compile.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const url = process.env['DATABASE_URL']

// These tests need a real Postgres. `pnpm test` (the offline suite) does not run this
// file; `pnpm test:db` does, and skips cleanly when no database is configured.
const skip = url ? false : 'DATABASE_URL is not set'

let db: Db
let sourceId: string
let adapterId: string

const SCHEMA = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }

before(async () => {
  if (!url) return
  db = connect({ url })
  await dropAll(db)
  await migrate(db, { root })
})

after(async () => {
  if (!url) return
  await close(db)
})

beforeEach(async () => {
  if (!url) return
  await db.execute(sql`truncate runtime.change_event, runtime.record, runtime.run, runtime.job cascade`)
  await db.execute(sql`truncate forge.compile_step, forge.compile_run, forge.fixture, forge.adapter, forge.source cascade`)
  sourceId = await createSource(db, {
    key: `test/${Math.random().toString(36).slice(2)}`,
    intent: 'test source',
    entryUrl: 'https://example.test',
    outputSchema: SCHEMA,
    requiredFields: ['id'],
    cadence: '1 hour',
  })
  const adapter = await insertAdapter(db, {
    sourceId,
    fetchPlan: { tier: 'http', urlTemplate: 'https://example.test/{key}' },
    codeTs: 'export function extract(i) { return [] }',
    codeJs: 'module.exports = {}',
    codeHash: 'hash-1',
    status: 'active',
  })
  adapterId = adapter.id
})

describe('migrations', { skip }, () => {
  test('schema.sql plus migrations/ apply, and re-applying is a no-op', async () => {
    const again = await migrate(db, { root })
    assert.deepEqual(again, [])
  })

  test('migration 001 added the absence and blocked columns', async () => {
    const rows = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'runtime' and table_name = 'record' and column_name in ('is_active','gone_at')
    `)
    assert.equal(rows.length, 2)
  })
})

describe('queue', { skip }, () => {
  test('enqueue is idempotent on (source_id, url)', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    assert.equal(await queueDepth(db, sourceId), 1)
  })

  test('claim takes one job and marks it running', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    const job = await claimJob(db, 'worker-1')
    assert.equal(job?.url, 'https://example.test/a')
    assert.equal(job?.attempts, 1)
    assert.equal(await claimJob(db, 'worker-2'), null)
  })

  test('two workers claiming concurrently get different rows', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    await enqueue(db, { sourceId, url: 'https://example.test/b', externalKey: 'b' })
    const [one, two] = await Promise.all([claimJob(db, 'w1'), claimJob(db, 'w2')])
    assert.ok(one && two)
    assert.notEqual(one.id, two.id)
  })

  test('priority then id decides claim order', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/low', externalKey: 'l', priority: 200 })
    await enqueue(db, { sourceId, url: 'https://example.test/high', externalKey: 'h', priority: 1 })
    const job = await claimJob(db, 'w1')
    assert.equal(job?.url, 'https://example.test/high')
  })

  test('a running job is not reset by a re-enqueue', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    await claimJob(db, 'w1')
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    const rows = await db.execute<{ state: string }>(sql`select state from runtime.job`)
    assert.equal(rows[0]?.state, 'running')
  })

  test('failure backs off, then goes dead at the attempt cap', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    const job = await claimJob(db, 'w1')
    assert.ok(job)
    assert.equal(await failJob(db, job.id, 'boom', 3), 'retry')

    await db.execute(sql`update runtime.job set attempts = 3, run_after = now() where id = ${job.id}`)
    assert.equal(await failJob(db, job.id, 'boom', 3), 'dead')
    const rows = await db.execute<{ state: string }>(sql`select state from runtime.job where id = ${job.id}`)
    assert.equal(rows[0]?.state, 'dead')
  })

  test('a job whose worker died is reclaimed, not lost', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    const job = await claimJob(db, 'w1')
    assert.ok(job)
    assert.equal(await reclaimStaleJobs(db, 900), 0)
    await db.execute(sql`update runtime.job set locked_at = now() - interval '1 hour' where id = ${job.id}`)
    assert.equal(await reclaimStaleJobs(db, 900), 1)
    assert.ok(await claimJob(db, 'w2'))
  })

  test('finishJob clears the lock', async () => {
    await enqueue(db, { sourceId, url: 'https://example.test/a', externalKey: 'a' })
    const job = await claimJob(db, 'w1')
    assert.ok(job)
    await finishJob(db, job.id)
    const rows = await db.execute<{ state: string; locked_by: string | null }>(
      sql`select state, locked_by from runtime.job where id = ${job.id}`,
    )
    assert.equal(rows[0]?.state, 'done')
    assert.equal(rows[0]?.locked_by, null)
  })
})

describe('records and the change outbox', { skip }, () => {
  test('a new record inserts and emits one insert event', async () => {
    const result = await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    assert.deepEqual(result, { inserted: 1, updated: 0, unchanged: 0 })
    const events = await readChangeEvents(db)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.kind, 'insert')
  })

  test('unchanged content writes no change event at all', async () => {
    await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    const result = await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    assert.deepEqual(result, { inserted: 0, updated: 0, unchanged: 1 })
    assert.equal((await readChangeEvents(db)).length, 1)
  })

  test('key order in the payload is not a change', async () => {
    await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a', b: 1 } }])
    const result = await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { b: 1, id: 'a' } }])
    assert.equal(result.unchanged, 1)
    assert.equal(contentHash({ id: 'a', b: 1 }), contentHash({ b: 1, id: 'a' }))
  })

  test('changed content emits an update event', async () => {
    await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a', price: 1 } }])
    const result = await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a', price: 2 } }])
    assert.deepEqual(result, { inserted: 0, updated: 1, unchanged: 0 })
    const events = await readChangeEvents(db)
    assert.equal(events[1]?.kind, 'update')
  })

  test('unchanged records still refresh last_seen, so the sweep does not eat them', async () => {
    await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    await db.execute(sql`update runtime.record set last_seen = now() - interval '2 days'`)
    await writeRecords(db, sourceId, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    const rows = await db.execute<{ fresh: boolean }>(
      sql`select last_seen > now() - interval '1 minute' as fresh from runtime.record`,
    )
    assert.equal(rows[0]?.fresh, true)
  })
})

describe('the absence sweep', { skip }, () => {
  beforeEach(async () => {
    if (!url) return
    await writeRecords(db, sourceId, null, [
      { externalKey: 'a', payload: { id: 'a' } },
      { externalKey: 'b', payload: { id: 'b' } },
    ])
  })

  test('records not seen this run are marked gone and emit a gone event', async () => {
    const gone = await sweepAbsent(db, sourceId, ['a'], { complete: true })
    assert.equal(gone, 1)
    const rows = await db.execute<{ external_key: string; is_active: boolean }>(
      sql`select external_key, is_active from runtime.record order by external_key`,
    )
    assert.deepEqual(rows.map((r) => r.is_active), [true, false])
    const events = await readChangeEvents(db)
    assert.equal(events.at(-1)?.kind, 'gone')
  })

  /** The guard that matters: an incomplete run must never deactivate anything. */
  test('an incomplete run does not sweep', async () => {
    assert.equal(await sweepAbsent(db, sourceId, ['a'], { complete: false }), 0)
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where is_active`,
    )
    assert.equal(rows[0]?.n, 2)
  })

  /** An empty result set is what a broken adapter looks like. Never sweep on it. */
  test('an empty seen-set does not sweep everything away', async () => {
    assert.equal(await sweepAbsent(db, sourceId, [], { complete: true }), 0)
  })

  test('a record that comes back is reactivated and reported as an update', async () => {
    await sweepAbsent(db, sourceId, ['a'], { complete: true })
    const result = await writeRecords(db, sourceId, null, [{ externalKey: 'b', payload: { id: 'b' } }])
    assert.equal(result.updated, 1)
    const rows = await db.execute<{ is_active: boolean; gone_at: Date | null }>(
      sql`select is_active, gone_at from runtime.record where external_key = 'b'`,
    )
    assert.equal(rows[0]?.is_active, true)
    assert.equal(rows[0]?.gone_at, null)
  })

  test('the sweep is scoped to one source', async () => {
    const other = await createSource(db, {
      key: `other/${Math.random().toString(36).slice(2)}`,
      intent: 'other',
      entryUrl: 'https://other.test',
      outputSchema: SCHEMA,
    })
    await writeRecords(db, other, null, [{ externalKey: 'a', payload: { id: 'a' } }])
    await sweepAbsent(db, sourceId, ['a'], { complete: true })
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from runtime.record where source_id = ${other}::uuid and is_active`,
    )
    assert.equal(rows[0]?.n, 1)
  })
})

describe('adapters', { skip }, () => {
  test('only one adapter can be active per source', async () => {
    await assert.rejects(
      insertAdapter(db, {
        sourceId,
        fetchPlan: { tier: 'http', urlTemplate: 'x' },
        codeTs: 'x',
        codeJs: 'x',
        codeHash: 'h2',
        status: 'active',
      }),
      /adapter_one_active/,
    )
  })

  test('promoting a canary retires the previous canary', async () => {
    const first = await insertAdapter(db, {
      sourceId, fetchPlan: { tier: 'http', urlTemplate: 'x' },
      codeTs: 'x', codeJs: 'x', codeHash: 'h2',
    })
    const second = await insertAdapter(db, {
      sourceId, fetchPlan: { tier: 'http', urlTemplate: 'x' },
      codeTs: 'x', codeJs: 'x', codeHash: 'h3',
    })
    await promoteToCanary(db, first.id)
    await promoteToCanary(db, second.id)
    assert.equal((await canaryAdapter(db, sourceId))?.id, second.id)
  })

  test('promoting to active retires the incumbent', async () => {
    const next = await insertAdapter(db, {
      sourceId, fetchPlan: { tier: 'http', urlTemplate: 'x' },
      codeTs: 'x', codeJs: 'x', codeHash: 'h2',
    })
    await promoteToActive(db, next.id)
    assert.equal((await activeAdapter(db, sourceId))?.id, next.id)
    const rows = await db.execute<{ status: string }>(
      sql`select status from forge.adapter where id = ${adapterId}::uuid`,
    )
    assert.equal(rows[0]?.status, 'retired')
  })

  test('rollback restores the most recent retired version', async () => {
    const next = await insertAdapter(db, {
      sourceId, fetchPlan: { tier: 'http', urlTemplate: 'x' },
      codeTs: 'x', codeJs: 'x', codeHash: 'h2',
    })
    await promoteToActive(db, next.id)
    const restored = await rollback(db, sourceId)
    assert.equal(restored?.id, adapterId)
    assert.equal((await activeAdapter(db, sourceId))?.id, adapterId)
  })

  test('version numbers increment per source', async () => {
    const a = await insertAdapter(db, {
      sourceId, fetchPlan: { tier: 'http', urlTemplate: 'x' }, codeTs: 'x', codeJs: 'x', codeHash: 'h2',
    })
    assert.equal(a.version, 2)
  })
})

describe('scheduler tick', { skip }, () => {
  test('a source with no runs is due', async () => {
    const due = await dueSources(db)
    assert.equal(due.some((s) => s.id === sourceId), true)
  })

  test('a source run inside its cadence is not due', async () => {
    await recordRun(db, {
      jobId: null, sourceId, adapterId, adapterVersion: 1, canary: false, outcome: 'ok', items: 5, validItems: 5,
    })
    assert.equal((await dueSources(db)).some((s) => s.id === sourceId), false)
  })

  test('a source run longer ago than its cadence is due again', async () => {
    await recordRun(db, {
      jobId: null, sourceId, adapterId, adapterVersion: 1, canary: false, outcome: 'ok', items: 5, validItems: 5,
    })
    await db.execute(sql`update runtime.run set created_at = now() - interval '2 hours'`)
    assert.equal((await dueSources(db)).some((s) => s.id === sourceId), true)
  })

  test('a degraded source is not scheduled', async () => {
    await setSourceState(db, sourceId, 'degraded')
    assert.equal((await dueSources(db)).some((s) => s.id === sourceId), false)
  })
})

describe('runs', { skip }, () => {
  test('runs come back newest first, the order assessHealth expects', async () => {
    for (const items of [1, 2, 3]) {
      await recordRun(db, {
        jobId: null, sourceId, adapterId, adapterVersion: 1, canary: false,
        outcome: 'ok', items, validItems: items,
      })
    }
    const runs = await recentRuns(db, sourceId)
    assert.deepEqual(runs.map((r) => r.items), [3, 2, 1])
  })

  test('a blocked run is recorded with its tier, not silently dropped', async () => {
    await recordRun(db, {
      jobId: null, sourceId, adapterId, adapterVersion: 1, canary: false,
      outcome: 'blocked', tierUsed: 'http', escalated: true, complete: false,
    })
    const rows = await db.execute<{ outcome: string; escalated: boolean; complete: boolean }>(
      sql`select outcome, escalated, complete from runtime.run`,
    )
    assert.equal(rows[0]?.outcome, 'blocked')
    assert.equal(rows[0]?.escalated, true)
    assert.equal(rows[0]?.complete, false)
  })
})

describe('fixtures', { skip }, () => {
  test('bodies round-trip through gzip', async () => {
    const body = '<html><body>' + 'x'.repeat(5000) + '</body></html>'
    const id = await captureFixture(db, {
      sourceId, url: 'https://example.test/a', tier: 'http', statusCode: 200,
      headers: { 'content-type': 'text/html' }, body,
    })
    const fixtures = await fixturesForSource(db, sourceId)
    assert.equal(fixtures[0]?.id, id)
    assert.equal(fixtures[0]?.body, body)
    assert.equal(fixtures[0]?.expected, null)
  })

  test('expected output is set separately, by a human', async () => {
    const id = await captureFixture(db, {
      sourceId, url: 'https://example.test/a', tier: 'http', statusCode: 200, headers: {}, body: '{}',
    })
    await setExpected(db, id, [{ id: 'a' }])
    const fixtures = await fixturesForSource(db, sourceId)
    assert.deepEqual(fixtures[0]?.expected, [{ id: 'a' }])
  })
})

describe('compile runs', { skip }, () => {
  test('only one compile run can be open per source', async () => {
    const first = await queueCompileRun(db, { sourceId, kind: 'repair' })
    assert.ok(first)
    assert.equal(await queueCompileRun(db, { sourceId, kind: 'repair' }), null)
  })

  test('a finished run frees the source to queue another', async () => {
    const first = await queueCompileRun(db, { sourceId, kind: 'repair' })
    assert.ok(first)
    await failCompileRun(db, first, 'no fix found')
    assert.ok(await queueCompileRun(db, { sourceId, kind: 'repair' }))
  })

  test('claiming marks it running and only one worker wins', async () => {
    await queueCompileRun(db, { sourceId, kind: 'compile', trigger: { manual: true } })
    const claimed = await claimCompileRun(db, 'forge-1')
    assert.equal(claimed?.kind, 'compile')
    assert.deepEqual(claimed?.trigger, { manual: true })
    assert.equal(await claimCompileRun(db, 'forge-2'), null)
  })

  test('failed repairs are counted, for the 3-strikes rule', async () => {
    for (let i = 0; i < 2; i++) {
      const id = await queueCompileRun(db, { sourceId, kind: 'repair' })
      assert.ok(id)
      await failCompileRun(db, id, 'nope')
    }
    assert.equal(await failedRepairCount(db, sourceId), 2)
  })
})
