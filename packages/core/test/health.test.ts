import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessCanary,
  assessHealth,
  CANARY_RUNS_REQUIRED,
  HEALTH_WINDOW,
  THRESHOLDS,
  type RunSummary,
} from '../src/health.ts'

function ok(items = 10, fieldNulls: Record<string, number> = {}): RunSummary {
  return { outcome: 'ok', items, validItems: items, fieldNulls }
}

function partial(items: number, validItems: number): RunSummary {
  return { outcome: 'schema_invalid', items, validItems, fieldNulls: {} }
}

function healthy(n = 10, items = 10): RunSummary[] {
  return Array.from({ length: n }, () => ok(items))
}

describe('health: the constants match master plan section 8', () => {
  test('window is 20 runs', () => {
    assert.equal(HEALTH_WINDOW, 20)
  })

  test('thresholds are as specified', () => {
    assert.equal(THRESHOLDS.schemaInvalidRate, 0.2)
    assert.equal(THRESHOLDS.requiredFieldNullRate, 0.15)
    assert.equal(THRESHOLDS.itemYieldRatio, 0.6)
    assert.equal(THRESHOLDS.consecutiveFailures, 3)
  })
})

describe('health: a healthy source does not trip', () => {
  test('ten clean runs', () => {
    const report = assessHealth(healthy(), ['id'])
    assert.equal(report.degraded, false)
    assert.deepEqual(report.trips, [])
    assert.equal(report.schemaInvalidRate, 0)
  })

  test('an empty history does not trip', () => {
    assert.equal(assessHealth([], ['id']).degraded, false)
  })

  test('only the newest 20 runs are considered', () => {
    const runs = [...healthy(20), ...Array.from({ length: 30 }, () => partial(10, 0))]
    const report = assessHealth(runs, ['id'])
    assert.equal(report.considered, 20)
    assert.equal(report.degraded, false)
  })
})

describe('health: schema_invalid_rate > 0.20', () => {
  test('trips above the threshold', () => {
    // 10 invalid of 40 items = 0.25
    const report = assessHealth([partial(10, 0), ...healthy(3, 10)], ['id'])
    assert.equal(report.schemaInvalidRate, 0.25)
    assert.equal(report.degraded, true)
    assert.ok(report.trips.some((t) => t.rule === 'schema-invalid-rate'))
  })

  test('does not trip exactly at the threshold', () => {
    // 10 of 50 items invalid = exactly 0.20, and the rule is strictly greater-than.
    const report = assessHealth([partial(10, 0), ...healthy(4, 10)], [])
    assert.equal(report.schemaInvalidRate, 0.2)
    assert.equal(report.trips.some((t) => t.rule === 'schema-invalid-rate'), false)
  })
})

describe('health: required field null_rate > 0.15', () => {
  test('trips when a required field goes mostly null', () => {
    const runs = [ok(10, { price: 0.9 }), ok(10, { price: 0.9 }), ok(10, { price: 0.9 })]
    const report = assessHealth(runs, ['price'])
    assert.equal(report.degraded, true)
    assert.ok(report.trips.some((t) => t.rule === 'required-field-null-rate'))
  })

  test('a field that is not required does not trip', () => {
    const runs = [ok(10, { extra: 0.9 }), ok(10, { extra: 0.9 })]
    assert.equal(assessHealth(runs, ['id']).degraded, false)
  })

  test('null rates are weighted by item count, not averaged per run', () => {
    // One run of 100 items with no nulls, one run of 1 item that is all null.
    // A per-run average would read 0.5 and trip; the weighted rate is ~0.01.
    const runs = [ok(1, { price: 1 }), ok(100, { price: 0 })]
    const report = assessHealth(runs, ['price'])
    assert.ok((report.fieldNullRates['price'] ?? 1) < 0.02)
    assert.equal(report.degraded, false)
  })
})

describe('health: item yield below 0.6x the trailing median', () => {
  test('trips when the latest run collapses', () => {
    const report = assessHealth([ok(2), ...healthy(9, 10)], [])
    assert.equal(report.medianItems, 10)
    assert.equal(report.latestItems, 2)
    assert.ok(report.trips.some((t) => t.rule === 'item-yield-collapse'))
  })

  test('does not trip on ordinary variation', () => {
    const report = assessHealth([ok(8), ...healthy(9, 10)], [])
    assert.equal(report.trips.some((t) => t.rule === 'item-yield-collapse'), false)
  })

  /**
   * The median deliberately excludes the newest run. Including it would let a big enough
   * collapse drag the median down far enough to hide itself.
   */
  test('the median is trailing, so a collapse cannot mask itself', () => {
    const report = assessHealth([ok(0), ok(0), ok(10), ok(10), ok(10)], [])
    assert.equal(report.medianItems, 10)
    assert.ok(report.trips.some((t) => t.rule === 'item-yield-collapse'))
  })

  test('a source that never produced anything is a compile problem, not a degradation', () => {
    const runs: RunSummary[] = Array.from({ length: 5 }, () => ok(0))
    const report = assessHealth(runs, [])
    assert.equal(report.trips.some((t) => t.rule === 'item-yield-collapse'), false)
  })

  test('needs at least two trailing runs before it fires', () => {
    const report = assessHealth([ok(0), ok(10)], [])
    assert.equal(report.trips.some((t) => t.rule === 'item-yield-collapse'), false)
  })
})

describe('health: 3 consecutive empty or exec_error runs', () => {
  const empty: RunSummary = { outcome: 'empty', items: 0, validItems: 0, fieldNulls: {} }
  const crash: RunSummary = { outcome: 'exec_error', items: 0, validItems: 0, fieldNulls: {} }

  test('three in a row trips', () => {
    const report = assessHealth([empty, empty, empty, ...healthy(5)], [])
    assert.ok(report.trips.some((t) => t.rule === 'consecutive-failures'))
  })

  test('empty and exec_error count together', () => {
    const report = assessHealth([empty, crash, empty, ...healthy(5)], [])
    assert.ok(report.trips.some((t) => t.rule === 'consecutive-failures'))
  })

  test('two in a row does not trip', () => {
    const report = assessHealth([empty, empty, ...healthy(5)], [])
    assert.equal(report.trips.some((t) => t.rule === 'consecutive-failures'), false)
  })

  test('the streak must be current, not historical', () => {
    const report = assessHealth([ok(10), empty, empty, empty, ...healthy(5)], [])
    assert.equal(report.trips.some((t) => t.rule === 'consecutive-failures'), false)
  })
})

describe('health: blocked runs are excluded from the window', () => {
  const blocked: RunSummary = { outcome: 'blocked', items: 0, validItems: 0, fieldNulls: {} }

  /**
   * The whole reason `blocked` exists. Three bot challenges look identical to three
   * broken runs, and section 8 would answer them by queueing a repair that cannot
   * possibly succeed — the adapter was never wrong.
   */
  test('three blocked runs do not trip the consecutive-failure rule', () => {
    const report = assessHealth([blocked, blocked, blocked, ...healthy(5)], [])
    assert.equal(report.degraded, false)
    assert.equal(report.blocked, 3)
    assert.equal(report.considered, 5)
  })

  test('blocked runs do not drag the yield down either', () => {
    const report = assessHealth([blocked, blocked, ...healthy(9, 10)], [])
    assert.equal(report.latestItems, 10)
    assert.equal(report.degraded, false)
  })

  test('a genuine break behind a run of blocks is still caught', () => {
    const empty: RunSummary = { outcome: 'empty', items: 0, validItems: 0, fieldNulls: {} }
    const report = assessHealth([blocked, empty, empty, empty, ...healthy(5)], [])
    assert.ok(report.trips.some((t) => t.rule === 'consecutive-failures'))
  })
})

describe('canary promotion', () => {
  test('waits until 20 canary runs', () => {
    const verdict = assessCanary(healthy(19), healthy(20))
    assert.equal(verdict.decision, 'wait')
    assert.equal(verdict.canaryRuns, 19)
    assert.equal(CANARY_RUNS_REQUIRED, 20)
  })

  test('promotes when the canary matches the active adapter', () => {
    assert.equal(assessCanary(healthy(20), healthy(20)).decision, 'promote')
  })

  test('promotes when the canary is strictly better', () => {
    const verdict = assessCanary(healthy(20, 12), [...healthy(19, 10), partial(10, 5)])
    assert.equal(verdict.decision, 'promote')
  })

  test('rejects a canary with a worse schema_invalid_rate', () => {
    const canary = Array.from({ length: 20 }, () => partial(10, 8))
    assert.equal(assessCanary(canary, healthy(20)).decision, 'reject')
  })

  test('rejects a canary yielding more than 10% fewer items', () => {
    const verdict = assessCanary(healthy(20, 8), healthy(20, 10))
    assert.equal(verdict.decision, 'reject')
    assert.match(verdict.reason, /tolerance/)
  })

  test('accepts a canary within the 10% tolerance', () => {
    assert.equal(assessCanary(healthy(20, 9.5), healthy(20, 10)).decision, 'promote')
  })

  test('blocked runs do not count toward the canary run total', () => {
    const blocked: RunSummary = { outcome: 'blocked', items: 0, validItems: 0, fieldNulls: {} }
    const verdict = assessCanary([...Array.from({ length: 5 }, () => blocked), ...healthy(18)], healthy(20))
    assert.equal(verdict.decision, 'wait')
    assert.equal(verdict.canaryRuns, 18)
  })
})
