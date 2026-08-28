/**
 * What happens after a run is recorded — master plan sections 6 (last line) and 8.
 *
 * Degradation and canary promotion are decided by the pure functions in
 * `@forge/core/health`; this file is only the part that touches the database. Keeping the
 * arithmetic out of here is what makes the thresholds testable without a Postgres.
 */

import { assessCanary, assessHealth, type HealthReport } from '@forge/core'
import {
  canaryAdapter,
  activeAdapter,
  captureFixture,
  failedRepairCount,
  fixturesForSource,
  promoteToActive,
  queueCompileRun,
  recentRuns,
  rejectAdapter,
  runsForAdapter,
  setSourceState,
  type Db,
  type SourceRow,
} from '@forge/db'

/** Section 8: "After 3 failed repairs the source goes to `disabled`". */
export const MAX_FAILED_REPAIRS = 3

export type HealthAction =
  | { action: 'none'; report: HealthReport }
  | { action: 'degraded'; report: HealthReport; compileRunId: string | null; fixtureIds: string[] }
  | { action: 'disabled'; report: HealthReport; reason: string }

export type UpdateHealthOptions = {
  /** the body from the run that tripped, so the repair has something fresh to work on */
  freshBody?: { url: string; tier: 'http' | 'browser'; status: number; headers: Record<string, string>; body: string }
}

/**
 * Recompute the rolling window and act on it.
 *
 * The `compile_one_open` partial unique index does the heavy lifting: `queueCompileRun`
 * returns null when a repair is already open, so a source failing every run queues exactly
 * one repair rather than one per run. That index is load-bearing, not defensive.
 */
export async function updateHealth(
  db: Db,
  source: SourceRow,
  options: UpdateHealthOptions = {},
): Promise<HealthAction> {
  const runs = await recentRuns(db, source.id, 20, { canary: false })
  const report = assessHealth(runs, source.required_fields)

  if (!report.degraded) return { action: 'none', report }
  // Already degraded or repairing: the repair is open, nothing more to do.
  if (source.state !== 'active') return { action: 'none', report }

  const failures = await failedRepairCount(db, source.id)
  if (failures >= MAX_FAILED_REPAIRS) {
    await setSourceState(db, source.id, 'disabled')
    return {
      action: 'disabled',
      report,
      reason: `${failures} repairs have already failed; a human needs to look at this`,
    }
  }

  // Section 8, step 1: record writes for this source stop here.
  await setSourceState(db, source.id, 'degraded')

  // Step 2: capture fresh fixtures. The body that tripped the window is the most useful
  // one there is — it is literally the page the adapter now fails on.
  const fixtureIds: string[] = []
  if (options.freshBody) {
    fixtureIds.push(
      await captureFixture(db, {
        sourceId: source.id,
        url: options.freshBody.url,
        tier: options.freshBody.tier,
        statusCode: options.freshBody.status,
        headers: options.freshBody.headers,
        body: options.freshBody.body,
      }),
    )
  }
  // The pre-break corpus goes in too. A repair that passes only the new fixture and
  // breaks the old ones is not a repair (section 9, repair objective).
  for (const fixture of await fixturesForSource(db, source.id, 6)) {
    if (!fixtureIds.includes(fixture.id)) fixtureIds.push(fixture.id)
  }

  const active = await activeAdapter(db, source.id)
  const compileRunId = await queueCompileRun(db, {
    sourceId: source.id,
    kind: 'repair',
    trigger: {
      trips: report.trips,
      schemaInvalidRate: report.schemaInvalidRate,
      medianItems: report.medianItems,
      latestItems: report.latestItems,
      fieldNullRates: report.fieldNullRates,
      blockedRuns: report.blocked,
    },
    input: {
      priorAdapterId: active?.id ?? null,
      failingFields: Object.entries(report.fieldNullRates)
        .filter(([, rate]) => rate > 0.15)
        .map(([field]) => field),
      fixtureIds,
    },
  })

  return { action: 'degraded', report, compileRunId, fixtureIds }
}

export type CanaryAction =
  | { action: 'wait'; reason: string }
  | { action: 'promoted'; adapterId: string; reason: string }
  | { action: 'rejected'; adapterId: string; reason: string }
  | { action: 'none'; reason: string }

/**
 * Section 6: promote after 20 canary runs when the canary is no worse than the active
 * adapter on schema validity and within 10% on yield. Otherwise reject it and leave the
 * active adapter alone.
 */
export async function evaluateCanary(db: Db, source: SourceRow): Promise<CanaryAction> {
  const canary = await canaryAdapter(db, source.id)
  if (!canary) return { action: 'none', reason: 'no canary' }

  const active = await activeAdapter(db, source.id)
  const [canaryRuns, activeRuns] = await Promise.all([
    runsForAdapter(db, canary.id, 100),
    active ? runsForAdapter(db, active.id, 100) : Promise.resolve([]),
  ])

  const verdict = assessCanary(canaryRuns, activeRuns)
  if (verdict.decision === 'wait') return { action: 'wait', reason: verdict.reason }

  if (verdict.decision === 'reject') {
    await rejectAdapter(db, canary.id)
    return { action: 'rejected', adapterId: canary.id, reason: verdict.reason }
  }

  await promoteToActive(db, canary.id)
  // Section 8, step 5: the source comes back to active once the canary is promoted.
  if (source.state !== 'active') await setSourceState(db, source.id, 'active')
  return { action: 'promoted', adapterId: canary.id, reason: verdict.reason }
}
