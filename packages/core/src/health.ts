/**
 * Health math — master plan section 8.
 *
 * Pure functions over a window of run summaries. No database, no clock, no I/O, so the
 * degradation rules can be tested exhaustively offline; `packages/db` supplies the window
 * and `apps/runtime-worker` acts on the verdict.
 *
 * One addition to section 8: runs whose outcome is `blocked` are dropped from the window
 * before anything is computed. A bot challenge returns 200 with no items, which looks
 * exactly like a broken selector — and section 8 would answer it by queueing a repair the
 * agent cannot possibly complete, because the adapter was never wrong. Blocked is a
 * fetch-tier problem and has to be excluded from an adapter-quality signal.
 */

/** Master plan section 8: "the last 20 runs per source". */
export const HEALTH_WINDOW = 20

export const THRESHOLDS = {
  schemaInvalidRate: 0.2,
  requiredFieldNullRate: 0.15,
  itemYieldRatio: 0.6,
  consecutiveFailures: 3,
} as const

export type RunOutcome =
  | 'ok'
  | 'schema_invalid'
  | 'empty'
  | 'fetch_error'
  | 'exec_error'
  | 'timeout'
  | 'blocked'

export type RunSummary = {
  outcome: RunOutcome
  items: number
  validItems: number
  fieldNulls: Record<string, number> | null
}

export type HealthTripRule =
  | 'schema-invalid-rate'
  | 'required-field-null-rate'
  | 'item-yield-collapse'
  | 'consecutive-failures'

export type HealthTrip = {
  rule: HealthTripRule
  detail: string
}

export type HealthReport = {
  /** true when any rule tripped and the source should go `degraded` */
  degraded: boolean
  trips: HealthTrip[]
  /** runs actually considered, after blocked runs are dropped */
  considered: number
  blocked: number
  schemaInvalidRate: number
  medianItems: number
  latestItems: number
  fieldNullRates: Record<string, number>
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/**
 * `runs` must be newest-first — the order `run_health` returns them in.
 */
export function assessHealth(
  runs: RunSummary[],
  requiredFields: string[] = [],
  window = HEALTH_WINDOW,
): HealthReport {
  const recent = runs.slice(0, window)
  const blocked = recent.filter((r) => r.outcome === 'blocked').length
  const considered = recent.filter((r) => r.outcome !== 'blocked')

  const trips: HealthTrip[] = []

  const totalItems = considered.reduce((sum, r) => sum + r.items, 0)
  const totalValid = considered.reduce((sum, r) => sum + r.validItems, 0)
  const schemaInvalidRate = totalItems === 0 ? 0 : (totalItems - totalValid) / totalItems

  // Per-field null rate, weighted by how many items each run produced — a run with 100
  // items should not count the same as a run with 1.
  const fieldNullRates: Record<string, number> = {}
  for (const field of requiredFields) {
    let weighted = 0
    let weight = 0
    for (const run of considered) {
      const rate = run.fieldNulls?.[field]
      if (rate === undefined || run.items === 0) continue
      weighted += rate * run.items
      weight += run.items
    }
    fieldNullRates[field] = weight === 0 ? 0 : weighted / weight
  }

  const itemCounts = considered.map((r) => r.items)
  // The trailing median deliberately excludes the newest run: comparing the latest
  // against a median that already contains it hides exactly the collapse we look for.
  const trailing = itemCounts.slice(1)
  const medianItems = median(trailing)
  const latestItems = itemCounts[0] ?? 0

  if (considered.length > 0 && schemaInvalidRate > THRESHOLDS.schemaInvalidRate) {
    trips.push({
      rule: 'schema-invalid-rate',
      detail: `${(schemaInvalidRate * 100).toFixed(1)}% of items fail output_schema (limit ${THRESHOLDS.schemaInvalidRate * 100}%)`,
    })
  }

  for (const [field, rate] of Object.entries(fieldNullRates)) {
    if (rate > THRESHOLDS.requiredFieldNullRate) {
      trips.push({
        rule: 'required-field-null-rate',
        detail: `required field \`${field}\` is null in ${(rate * 100).toFixed(1)}% of items (limit ${THRESHOLDS.requiredFieldNullRate * 100}%)`,
      })
    }
  }

  // Needs a trailing median to compare against, and a median of 0 means the source has
  // never produced anything — that is a compile problem, not a degradation.
  if (trailing.length >= 2 && medianItems > 0 && latestItems < medianItems * THRESHOLDS.itemYieldRatio) {
    trips.push({
      rule: 'item-yield-collapse',
      detail: `latest run produced ${latestItems} items against a trailing median of ${medianItems} (limit ${THRESHOLDS.itemYieldRatio}x)`,
    })
  }

  let streak = 0
  for (const run of considered) {
    if (run.outcome === 'empty' || run.outcome === 'exec_error') streak++
    else break
  }
  if (streak >= THRESHOLDS.consecutiveFailures) {
    trips.push({
      rule: 'consecutive-failures',
      detail: `${streak} consecutive runs with outcome empty or exec_error`,
    })
  }

  return {
    degraded: trips.length > 0,
    trips,
    considered: considered.length,
    blocked,
    schemaInvalidRate,
    medianItems,
    latestItems,
    fieldNullRates,
  }
}

/**
 * Canary promotion — master plan section 6.
 *
 * "Promote after 20 canary runs when its schema_invalid_rate is at or below the active
 * adapter's and its item yield is within 10%."
 */
export const CANARY_RUNS_REQUIRED = 20
export const CANARY_YIELD_TOLERANCE = 0.1

export type CanaryVerdict = {
  decision: 'promote' | 'reject' | 'wait'
  reason: string
  canaryRuns: number
}

export function assessCanary(
  canaryRuns: RunSummary[],
  activeRuns: RunSummary[],
  runsRequired = CANARY_RUNS_REQUIRED,
): CanaryVerdict {
  const canary = canaryRuns.filter((r) => r.outcome !== 'blocked')
  const active = activeRuns.filter((r) => r.outcome !== 'blocked')

  if (canary.length < runsRequired) {
    return {
      decision: 'wait',
      reason: `${canary.length} of ${runsRequired} canary runs so far`,
      canaryRuns: canary.length,
    }
  }

  const rate = (runs: RunSummary[]): number => {
    const items = runs.reduce((s, r) => s + r.items, 0)
    const valid = runs.reduce((s, r) => s + r.validItems, 0)
    return items === 0 ? 1 : (items - valid) / items
  }
  const meanItems = (runs: RunSummary[]): number =>
    runs.length === 0 ? 0 : runs.reduce((s, r) => s + r.items, 0) / runs.length

  const canaryInvalid = rate(canary)
  const activeInvalid = rate(active)
  if (canaryInvalid > activeInvalid) {
    return {
      decision: 'reject',
      reason: `canary schema_invalid_rate ${canaryInvalid.toFixed(3)} is worse than active ${activeInvalid.toFixed(3)}`,
      canaryRuns: canary.length,
    }
  }

  const canaryYield = meanItems(canary)
  const activeYield = meanItems(active)
  if (activeYield > 0 && canaryYield < activeYield * (1 - CANARY_YIELD_TOLERANCE)) {
    return {
      decision: 'reject',
      reason: `canary yields ${canaryYield.toFixed(1)} items against active ${activeYield.toFixed(1)}, outside the ${CANARY_YIELD_TOLERANCE * 100}% tolerance`,
      canaryRuns: canary.length,
    }
  }

  return {
    decision: 'promote',
    reason: `canary matched active over ${canary.length} runs (invalid ${canaryInvalid.toFixed(3)} vs ${activeInvalid.toFixed(3)}, yield ${canaryYield.toFixed(1)} vs ${activeYield.toFixed(1)})`,
    canaryRuns: canary.length,
  }
}
