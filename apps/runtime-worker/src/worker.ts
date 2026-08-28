/**
 * The runtime worker loop — master plan section 6.
 *
 * Two modes, one loop body:
 *
 *   - `runForever()` for a long-lived process.
 *   - `runOnce()` drains the queue and returns, which is what a scheduled CI job wants.
 *     A cron-triggered GitHub Actions run costs nothing between ticks and needs no host,
 *     and that is a genuinely good fit for a scraper on a daily cadence.
 *
 * Shutdown is cooperative. An AbortSignal is threaded all the way into the fetcher, and a
 * job already claimed is finished rather than abandoned — a killed worker that leaves rows
 * in `running` is exactly what `reclaimStaleJobs` then has to clean up 15 minutes later.
 */

import {
  claimJob,
  dueSources,
  enqueue,
  failJob,
  finishJob,
  getSource,
  reclaimStaleJobs,
  type Db,
  type SourceRow,
} from '@forge/db'
import { resolveUrl } from '@forge/fetch'

import { evaluateCanary, updateHealth } from './health-step.ts'
import { processJob, type Fetcher } from './pipeline.ts'
import { activeAdapter, canaryAdapter } from '@forge/db'

export type WorkerOptions = {
  workerId?: string
  fetcher?: Fetcher
  signal?: AbortSignal
  /** how long to sleep when the queue is empty */
  idleMs?: number
  /** stop after this many jobs; runOnce uses it as a safety cap */
  maxJobs?: number
  canaryShare?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export type TickResult = { queued: number; sources: number }

/**
 * Scheduler tick: enqueue work for every source whose cadence is due.
 *
 * One job per source per tick, against the source's entry URL. Multi-page and per-item
 * jobs come from an adapter's `discover()` output, which the caller enqueues; the tick
 * itself stays trivial because it runs on every loop iteration.
 */
export async function tick(db: Db, options: WorkerOptions = {}): Promise<TickResult> {
  const log = options.log ?? (() => {})
  const sources = await dueSources(db)
  let queued = 0

  for (const source of sources) {
    const adapter = (await activeAdapter(db, source.id)) ?? (await canaryAdapter(db, source.id))
    if (!adapter) {
      log('source is due but has no adapter', { source: source.key })
      continue
    }
    const url = source.entry_url || resolveUrl(adapter.fetch_plan, source.key)
    const id = await enqueue(db, { sourceId: source.id, url, externalKey: source.key })
    if (id !== null) queued++
  }

  if (queued > 0) log('scheduler tick', { sources: sources.length, queued })
  return { queued, sources: sources.length }
}

export type JobReport = {
  jobId: number
  sourceKey: string
  outcome: string
  items: number
  written: number
  swept: number
  degraded: boolean
}

/** Claim and process exactly one job. Returns null when the queue is empty. */
export async function step(db: Db, options: WorkerOptions = {}): Promise<JobReport | null> {
  const workerId = options.workerId ?? `worker-${process.pid}`
  const log = options.log ?? (() => {})

  const job = await claimJob(db, workerId)
  if (!job) return null

  let source: SourceRow | null = null
  try {
    source = await getSource(db, job.source_id)
    if (!source) throw new Error(`job ${job.id} points at a source that no longer exists`)

    const result = await processJob(db, source, job, {
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.canaryShare === undefined ? {} : { canaryShare: options.canaryShare }),
      captureFixtureOnFailure: true,
    })

    // A run that produced nothing usable is a job failure as far as the queue is
    // concerned, so it backs off and retries. The run row is already written either way —
    // the health signal does not depend on the queue's opinion.
    if (result.outcome === 'ok' || result.outcome === 'schema_invalid') {
      await finishJob(db, job.id)
    } else {
      await failJob(db, job.id, result.error ?? result.outcome)
    }

    const health = await updateHealth(db, source)
    if (health.action === 'degraded') {
      log('source degraded', {
        source: source.key,
        trips: health.report.trips.map((t) => t.rule),
        compileRun: health.compileRunId,
      })
    } else if (health.action === 'disabled') {
      log('source disabled', { source: source.key, reason: health.reason })
    }

    // Canary bookkeeping is cheap and only does anything when a canary exists.
    const canary = await evaluateCanary(db, source)
    if (canary.action === 'promoted' || canary.action === 'rejected') {
      log(`canary ${canary.action}`, { source: source.key, reason: canary.reason })
    }

    return {
      jobId: job.id,
      sourceKey: source.key,
      outcome: result.outcome,
      items: result.items,
      written: result.written.inserted + result.written.updated,
      swept: result.swept,
      degraded: health.action === 'degraded',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('job failed', { job: job.id, error: message })
    await failJob(db, job.id, message)
    return {
      jobId: job.id,
      sourceKey: source?.key ?? String(job.source_id),
      outcome: 'exec_error',
      items: 0,
      written: 0,
      swept: 0,
      degraded: false,
    }
  }
}

/** Tick once, then drain the queue. This is the shape a scheduled CI run wants. */
export async function runOnce(db: Db, options: WorkerOptions = {}): Promise<JobReport[]> {
  const maxJobs = options.maxJobs ?? 500
  await reclaimStaleJobs(db)
  await tick(db, options)

  const reports: JobReport[] = []
  while (reports.length < maxJobs) {
    if (options.signal?.aborted) break
    const report = await step(db, options)
    if (!report) break
    reports.push(report)
  }
  return reports
}

export async function runForever(db: Db, options: WorkerOptions = {}): Promise<void> {
  const idleMs = options.idleMs ?? 5_000
  const log = options.log ?? (() => {})
  let sinceReclaim = 0

  while (!options.signal?.aborted) {
    if (sinceReclaim++ % 60 === 0) await reclaimStaleJobs(db)
    await tick(db, options)

    const report = await step(db, options)
    if (report) {
      log('job done', { ...report })
      continue
    }
    await sleep(idleMs, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
