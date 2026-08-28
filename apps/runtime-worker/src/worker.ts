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
  sweepStale,
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
 * The URL comes from `adapter.fetch_plan.urlTemplate`, never from `source.entry_url`.
 * Those are different things and conflating them is a live bug: `entry_url` is the
 * human-facing page the *compile agent* starts exploring from, while `urlTemplate` is
 * what the adapter was actually compiled against — usually the JSON endpoint the agent
 * found behind that page. Fetching `entry_url` at runtime hands an adapter that expects
 * JSON a page of HTML, which fails as `exec_error` and reads like a broken adapter.
 *
 * When `urlTemplate` carries a `{key}`, the source has to say which keys the tick should
 * expand — `fetch_hints.entryKeys`. The master plan does not cover this: it defines the
 * template and it defines the tick, but never says where the entry job's key comes from.
 * Per-item jobs beyond these come from an adapter's `discover()` output.
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

    const template = adapter.fetch_plan.urlTemplate
    const hints = source.fetch_hints as { entryKeys?: unknown }
    const entryKeys = Array.isArray(hints.entryKeys) ? hints.entryKeys.map(String) : []

    if (template.includes('{key}') && entryKeys.length === 0) {
      log('source is misconfigured: urlTemplate needs {key} but fetch_hints.entryKeys is empty', {
        source: source.key,
        template,
      })
      continue
    }

    const keys = entryKeys.length > 0 ? entryKeys : [source.key]
    for (const key of keys) {
      const id = await enqueue(db, {
        sourceId: source.id,
        url: resolveUrl(adapter.fetch_plan, key),
        externalKey: key,
      })
      if (id !== null) queued++
    }
  }

  if (queued > 0) log('scheduler tick', { sources: sources.length, queued })
  return { queued, sources: sources.length }
}

export type JobReport = {
  jobId: number
  sourceId: string
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
      sourceId: source.id,
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
      sourceId: job.source_id,
      sourceKey: source?.key ?? String(job.source_id),
      outcome: 'exec_error',
      items: 0,
      written: 0,
      swept: 0,
      degraded: false,
    }
  }
}

/**
 * Sweep every source whose jobs all succeeded this tick.
 *
 * A source is only swept when *every* job it had this tick came back clean. One failed
 * or blocked job means the result set is incomplete, and an incomplete result set marking
 * records gone is the one genuinely destructive failure mode in the system.
 *
 * Returns the number of records marked gone, per source key.
 */
export async function sweepSources(
  db: Db,
  reports: JobReport[],
  since: Date,
  options: WorkerOptions = {},
): Promise<Record<string, number>> {
  const log = options.log ?? (() => {})
  const bySource = new Map<string, { key: string; complete: boolean }>()

  for (const report of reports) {
    const clean = report.outcome === 'ok'
    const existing = bySource.get(report.sourceId)
    if (existing) existing.complete &&= clean
    else bySource.set(report.sourceId, { key: report.sourceKey, complete: clean })
  }

  const swept: Record<string, number> = {}
  for (const [sourceId, info] of bySource) {
    if (!info.complete) {
      log('skipping absence sweep — not every job came back clean', { source: info.key })
      continue
    }
    const source = await getSource(db, sourceId)
    // A degraded source has stopped writing records, so its last_seen timestamps are
    // stale by design. Sweeping it would retire the entire source.
    if (!source || source.state !== 'active') continue

    const count = await sweepStale(db, sourceId, since, { complete: true })
    if (count > 0) {
      swept[info.key] = count
      log('records marked gone', { source: info.key, count })
    }
  }
  return swept
}

/** Tick once, then drain the queue. This is the shape a scheduled CI run wants. */
export async function runOnce(db: Db, options: WorkerOptions = {}): Promise<JobReport[]> {
  const maxJobs = options.maxJobs ?? 500
  // Taken before any work: anything not touched after this point was not in a response.
  const tickStart = new Date()
  await reclaimStaleJobs(db)
  await tick(db, options)

  const reports: JobReport[] = []
  while (reports.length < maxJobs) {
    if (options.signal?.aborted) break
    const report = await step(db, options)
    if (!report) break
    reports.push(report)
  }

  // Only sweep on a full drain. An aborted run has not seen the whole result set.
  if (!options.signal?.aborted) {
    const swept = await sweepSources(db, reports, tickStart, options)
    for (const report of reports) {
      report.swept = swept[report.sourceKey] ?? 0
      swept[report.sourceKey] = 0 // attribute the count once, not once per job
    }
  }
  return reports
}

export async function runForever(db: Db, options: WorkerOptions = {}): Promise<void> {
  const idleMs = options.idleMs ?? 5_000
  const log = options.log ?? (() => {})
  let sinceReclaim = 0

  while (!options.signal?.aborted) {
    if (sinceReclaim++ % 60 === 0) await reclaimStaleJobs(db)

    const tickStart = new Date()
    await tick(db, options)

    const reports: JobReport[] = []
    for (;;) {
      const report = await step(db, options)
      if (!report) break
      log('job done', { ...report })
      reports.push(report)
      if (options.signal?.aborted) break
    }

    // Drain first, then sweep: the same reason runOnce does. A source's result set is
    // spread across all of its jobs, so it is only whole once the queue is empty.
    if (reports.length > 0 && !options.signal?.aborted) {
      await sweepSources(db, reports, tickStart, options)
    }
    if (reports.length === 0) await sleep(idleMs, options.signal)
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
