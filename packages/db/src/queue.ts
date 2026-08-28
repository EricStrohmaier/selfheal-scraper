/**
 * The job queue — master plan section 6.
 *
 * `unique(source_id, url)` plus `FOR UPDATE SKIP LOCKED`. Re-scheduling is an upsert that
 * resets `state` and `run_after`, so enqueueing the same URL twice is a no-op rather than
 * a duplicate.
 */

import { sql } from 'drizzle-orm'

import type { Db } from './client.ts'
import { pgTimestamp } from './sql-util.ts'

export type JobRow = {
  id: number
  source_id: string
  url: string
  external_key: string
  priority: number
  attempts: number
}

export type EnqueueInput = {
  sourceId: string
  url: string
  externalKey: string
  priority?: number
  runAfter?: Date
}

/**
 * Idempotent by `(source_id, url)`.
 *
 * A job already running is left alone — resetting it under a worker that holds it would
 * produce two runs writing the same records. Everything else is reset to queued.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<number | null> {
  const rows = await db.execute<{ id: number }>(sql`
    insert into runtime.job (source_id, url, external_key, priority, run_after)
    values (
      ${input.sourceId}::uuid, ${input.url}, ${input.externalKey},
      ${input.priority ?? 100}, ${pgTimestamp(input.runAfter ?? new Date())}
    )
    on conflict (source_id, url) do update
      set state       = 'queued',
          run_after   = excluded.run_after,
          priority    = excluded.priority,
          attempts    = 0,
          locked_by   = null,
          locked_at   = null
      where runtime.job.state <> 'running'
    returning id
  `)
  return rows[0]?.id ?? null
}

export async function enqueueMany(db: Db, inputs: EnqueueInput[]): Promise<number> {
  let queued = 0
  for (const input of inputs) {
    if ((await enqueue(db, input)) !== null) queued++
  }
  return queued
}

/**
 * Claim one due job. `FOR UPDATE SKIP LOCKED` is what lets several workers share the
 * queue without a broker: each takes a different row instead of blocking on the same one.
 */
export async function claimJob(db: Db, workerId: string): Promise<JobRow | null> {
  const rows = await db.execute<JobRow>(sql`
    with claimed as (
      select id from runtime.job
      where state = 'queued' and run_after <= now()
      order by priority, id
      for update skip locked
      limit 1
    )
    update runtime.job j
       set state = 'running', locked_by = ${workerId}, locked_at = now(), attempts = j.attempts + 1
      from claimed
     where j.id = claimed.id
    returning j.id, j.source_id, j.url, j.external_key, j.priority, j.attempts
  `)
  return rows[0] ?? null
}

export async function finishJob(db: Db, jobId: number): Promise<void> {
  await db.execute(sql`
    update runtime.job
       set state = 'done', locked_by = null, locked_at = null, last_error = null
     where id = ${jobId}
  `)
}

export const MAX_ATTEMPTS = 5

/**
 * Exponential backoff, capped. A job that has burned through its attempts goes to `dead`
 * rather than spinning: a permanently 404ing URL should stop costing fetches.
 */
export async function failJob(
  db: Db,
  jobId: number,
  error: string,
  maxAttempts = MAX_ATTEMPTS,
): Promise<'retry' | 'dead'> {
  const rows = await db.execute<{ attempts: number }>(sql`
    select attempts from runtime.job where id = ${jobId}
  `)
  const attempts = rows[0]?.attempts ?? maxAttempts
  const dead = attempts >= maxAttempts
  const backoffSeconds = Math.min(2 ** attempts * 30, 3600)

  await db.execute(sql`
    update runtime.job
       set state      = ${dead ? 'dead' : 'queued'},
           run_after  = now() + make_interval(secs => ${dead ? 0 : backoffSeconds}),
           locked_by  = null,
           locked_at  = null,
           last_error = ${error.slice(0, 2000)}
     where id = ${jobId}
  `)
  return dead ? 'dead' : 'retry'
}

/**
 * Return jobs whose worker died mid-run. Without this a crash leaves rows stuck in
 * `running` forever, and the queue quietly drains to nothing.
 */
export async function reclaimStaleJobs(db: Db, olderThanSeconds = 900): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    update runtime.job
       set state = 'queued', locked_by = null, locked_at = null
     where state = 'running'
       and locked_at < now() - make_interval(secs => ${olderThanSeconds})
    returning id
  `)
  return rows.length
}

export async function queueDepth(db: Db, sourceId?: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sourceId
      ? sql`select count(*)::int as n from runtime.job where state = 'queued' and source_id = ${sourceId}::uuid`
      : sql`select count(*)::int as n from runtime.job where state = 'queued'`,
  )
  return rows[0]?.n ?? 0
}
