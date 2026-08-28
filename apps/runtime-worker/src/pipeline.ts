/**
 * One job: fetch, extract, validate, write, record. Master plan section 6.
 *
 * No model is called here, and nothing in this file may ever call one. The runtime tier
 * runs stored code and nothing else — that separation is the whole design.
 *
 * The fetcher is injected rather than imported so the pipeline can be tested end to end
 * against a real database with no network at all.
 */

import {
  createValidator,
  fieldNullRates,
  runAdapter,
  SandboxError,
  type FetchPlan,
  type RunOutcome,
} from '@forge/core'
import {
  activeAdapter,
  canaryAdapter,
  captureFixture,
  recordRun,
  writeRecords,
  type AdapterRow,
  type Db,
  type JobRow,
  type SourceRow,
} from '@forge/db'
import { executeFetchPlan, resolveUrl, type ExecuteResult, type FetchHints } from '@forge/fetch'

export type Fetcher = (
  plan: FetchPlan,
  url: string,
  options: { hints?: FetchHints; signal?: AbortSignal },
) => Promise<ExecuteResult>

export const defaultFetcher: Fetcher = (plan, url, options) => executeFetchPlan(plan, url, options)

export type ProcessJobOptions = {
  fetcher?: Fetcher
  signal?: AbortSignal
  /** deterministic canary routing; see pickAdapter */
  canaryShare?: number
  /** capture the response as a fixture when the run goes wrong */
  captureFixtureOnFailure?: boolean
}

export type ProcessJobResult = {
  runId: number
  outcome: RunOutcome
  items: number
  validItems: number
  written: { inserted: number; updated: number; unchanged: number }
  /** always 0 — the worker sweeps per source, not per job */
  swept: number
  adapter: AdapterRow
  canary: boolean
  error?: string
}

/**
 * Master plan section 6: "active, or canary for 10% of jobs on sources with a canary".
 *
 * Deterministic on the job id rather than random. The same job routes the same way every
 * time, so a canary that only breaks on one particular URL is reproducible instead of
 * being a heisenbug that clears on retry.
 */
export function pickAdapter(
  active: AdapterRow | null,
  canary: AdapterRow | null,
  jobId: number,
  share = 0.1,
): { adapter: AdapterRow; isCanary: boolean } | null {
  if (canary && active) {
    const bucket = jobId % 100
    if (bucket < Math.round(share * 100)) return { adapter: canary, isCanary: true }
  }
  if (active) return { adapter: active, isCanary: false }
  if (canary) return { adapter: canary, isCanary: true }
  return null
}

/**
 * How `runtime.record.external_key` is derived from an extracted item.
 *
 * The master plan never says. It requires `unique(source_id, external_key)` and it has
 * adapters return opaque `unknown[]`, but nothing connects the two. Left unspecified,
 * every adapter would invent its own convention and the uniqueness constraint would mean
 * different things per source.
 *
 * The rule here: `source.fetch_hints.externalKeyField`, else the first of `externalKey`,
 * `id`, `key`. Falling back to a content hash would make every edit look like a new
 * record, so an item with no usable key is treated as invalid instead.
 */
export function externalKeyOf(item: unknown, field?: string): string | null {
  if (item === null || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const candidates = field ? [field] : ['externalKey', 'id', 'key']
  for (const candidate of candidates) {
    const value = record[candidate]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

export async function processJob(
  db: Db,
  source: SourceRow,
  job: JobRow,
  options: ProcessJobOptions = {},
): Promise<ProcessJobResult> {
  const fetcher = options.fetcher ?? defaultFetcher
  const [active, canary] = await Promise.all([
    activeAdapter(db, source.id),
    canaryAdapter(db, source.id),
  ])
  const chosen = pickAdapter(active, canary, job.id, options.canaryShare)
  if (!chosen) throw new Error(`source ${source.key} has no active or canary adapter`)
  const { adapter, isCanary } = chosen

  const hints = source.fetch_hints as FetchHints
  const url = job.url || resolveUrl(adapter.fetch_plan, job.external_key)

  const base = {
    jobId: job.id,
    sourceId: source.id,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    canary: isCanary,
  }
  const empty = { inserted: 0, updated: 0, unchanged: 0 }

  // ── fetch ────────────────────────────────────────────────────────────────────────
  const fetched = await fetcher(adapter.fetch_plan, url, { hints, signal: options.signal })

  if (!fetched.ok || fetched.body === undefined) {
    // A blocked fetch is still worth a fixture: it is the evidence a human needs to see
    // that the site started challenging us, and it must never become a repair input.
    if (options.captureFixtureOnFailure && fetched.body && fetched.outcome !== 'blocked') {
      await captureFixture(db, {
        sourceId: source.id,
        url,
        tier: adapter.fetch_plan.tier,
        statusCode: fetched.status ?? 0,
        headers: fetched.headers ?? {},
        body: fetched.body,
      })
    }
    const runId = await recordRun(db, {
      ...base,
      outcome: fetched.outcome,
      httpStatus: fetched.status,
      fetchMs: fetched.fetchMs,
      bytes: fetched.bytes,
      error: fetched.error ?? null,
      tierUsed: fetched.tier,
      escalated: fetched.escalated,
      complete: false,
    })
    return {
      runId,
      outcome: fetched.outcome,
      items: 0,
      validItems: 0,
      written: empty,
      swept: 0,
      adapter,
      canary: isCanary,
      ...(fetched.error === undefined ? {} : { error: fetched.error }),
    }
  }

  // ── extract ──────────────────────────────────────────────────────────────────────
  const parseStarted = Date.now()
  let items: unknown[]
  try {
    items = runAdapter(adapter.code_js, adapter.code_hash, {
      url,
      status: fetched.status ?? 200,
      headers: fetched.headers ?? {},
      body: fetched.body,
    })
  } catch (err) {
    const sandboxError = err instanceof SandboxError ? err : undefined
    const outcome: RunOutcome = sandboxError?.kind === 'timeout' ? 'timeout' : 'exec_error'
    const message = err instanceof Error ? err.message : String(err)
    if (options.captureFixtureOnFailure) {
      await captureFixture(db, {
        sourceId: source.id,
        url,
        tier: fetched.tier,
        statusCode: fetched.status ?? 200,
        headers: fetched.headers ?? {},
        body: fetched.body,
      })
    }
    const runId = await recordRun(db, {
      ...base,
      outcome,
      httpStatus: fetched.status,
      fetchMs: fetched.fetchMs,
      parseMs: Date.now() - parseStarted,
      bytes: fetched.bytes,
      error: message,
      tierUsed: fetched.tier,
      escalated: fetched.escalated,
      complete: false,
    })
    return {
      runId, outcome, items: 0, validItems: 0, written: empty, swept: 0,
      adapter, canary: isCanary, error: message,
    }
  }
  const parseMs = Date.now() - parseStarted

  // ── validate ─────────────────────────────────────────────────────────────────────
  const validate = createValidator(source.output_schema)
  const keyField = (source.fetch_hints as { externalKeyField?: string }).externalKeyField
  const valid: Array<{ externalKey: string; payload: unknown }> = []
  let invalidCount = 0

  for (const item of items) {
    const externalKey = externalKeyOf(item, keyField)
    // No usable key is a validation failure, not a silent drop: an item the runtime
    // cannot address is an item it cannot ever update or retire.
    if (externalKey === null || !validate(item)) {
      invalidCount++
      continue
    }
    valid.push({ externalKey, payload: item })
  }

  const outcome: RunOutcome =
    items.length === 0 ? 'empty' : invalidCount > 0 ? 'schema_invalid' : 'ok'

  // ── write ────────────────────────────────────────────────────────────────────────
  //
  // Section 6 says "only for valid items"; section 3 says "nothing is written to record
  // from a run whose items fail validation". Those are not the same rule. What is written
  // here follows section 6 — valid items go in — but the absence sweep needs section 3's
  // guarantee, so it only runs when the extraction was clean *and* complete. A partial
  // result set marking records gone is the one genuinely destructive failure mode.
  //
  // Record writes also stop entirely while a source is degraded (section 8, step 1).
  const degraded = source.state === 'degraded' || source.state === 'disabled'
  const written =
    degraded || isCanary || valid.length === 0
      ? empty
      : await writeRecords(db, source.id, null, valid)

  // The absence sweep is deliberately NOT done here. A source can have several entry
  // jobs, and one job's keys are not the source's whole result set — sweeping per job
  // would mark the previous job's records gone, then the next job would do the same to
  // those. The worker sweeps once per source after its queue drains; see worker.ts.
  const complete = outcome === 'ok' && fetched.ok

  const runId = await recordRun(db, {
    ...base,
    outcome,
    httpStatus: fetched.status,
    fetchMs: fetched.fetchMs,
    parseMs,
    bytes: fetched.bytes,
    items: items.length,
    validItems: valid.length,
    fieldNulls: fieldNullRates(items, source.required_fields),
    tierUsed: fetched.tier,
    escalated: fetched.escalated,
    complete,
    error: invalidCount > 0 ? `${invalidCount} of ${items.length} items failed validation` : null,
  })

  return { runId, outcome, items: items.length, validItems: valid.length, written, swept: 0, adapter, canary: isCanary }
}
