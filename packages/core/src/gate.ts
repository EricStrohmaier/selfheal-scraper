/**
 * The promotion gate — master plan section 5.
 *
 * An adapter cannot leave `draft` until:
 *   - it runs against at least 3 fixtures
 *   - every fixture yields at least 1 item
 *   - 100% of produced items validate against `source.output_schema`
 *   - where `fixture.expected` is set, output matches it
 *
 * The gate never writes to `output_schema` or `required_fields`; it only reads them. That
 * is the whole point of the rule in section 9 — an adapter that cannot satisfy the schema
 * is a failed compile, never a reason to loosen the schema.
 *
 * The last clause in the plan reads "or the compile run explains the diff". A prose
 * explanation is not something code can adjudicate, so the gate reports the mismatch as a
 * blocking failure and leaves the override to whoever reads the compile run. `passed` is
 * the machine's answer; `failures` is what a human or the agent needs in order to disagree.
 */

import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'

import type { FixtureBody } from './contract.ts'
import { runAdapter, SandboxError, type SandboxOptions } from './sandbox.ts'

/** Master plan section 5: "it runs against at least 3 fixtures". */
export const MIN_FIXTURES = 3

export type GateFixture = FixtureBody & {
  id: string
  /** golden output, set once a human confirms it; null/undefined means unset */
  expected?: unknown[] | null
}

export type GateInput = {
  codeJs: string
  codeHash: string
  /** `forge.source.output_schema`. Read-only here, always. */
  outputSchema: Record<string, unknown>
  /** `forge.source.required_fields`. Read-only, and reported on rather than gated on. */
  requiredFields?: string[]
  fixtures: GateFixture[]
  minFixtures?: number
  sandbox?: SandboxOptions
}

export type GateFailureRule =
  | 'too-few-fixtures'
  | 'exec-error'
  | 'empty-fixture'
  | 'schema-invalid'
  | 'expected-mismatch'

export type GateFailure = {
  rule: GateFailureRule
  message: string
  fixtureId?: string
}

/** Mirrors the `outcome` column on `runtime.run`. */
export type FixtureOutcome = 'ok' | 'empty' | 'schema_invalid' | 'exec_error' | 'timeout'

export type GateFixtureReport = {
  fixtureId: string
  url: string
  outcome: FixtureOutcome
  items: number
  validItems: number
  /** per-field fraction of items where the field is null, undefined or absent */
  fieldNulls: Record<string, number>
  expected: 'unset' | 'match' | 'mismatch'
  schemaErrors: string[]
  error?: string
}

export type GateResult = {
  passed: boolean
  failures: GateFailure[]
  fixtures: GateFixtureReport[]
  totals: {
    fixtures: number
    items: number
    validItems: number
    /** the health signal from section 8, computed over the whole fixture corpus */
    schemaInvalidRate: number
  }
}

function compileSchema(outputSchema: Record<string, unknown>): ValidateFunction {
  // strict:false — `output_schema` is human-written and may carry annotations ajv would
  // otherwise reject. allErrors so the agent gets the full picture in one pass.
  const ajv = new Ajv({ allErrors: true, strict: false })
  return ajv.compile(outputSchema)
}

function formatErrors(errors: ErrorObject[] | null | undefined, itemIndex: number): string[] {
  if (!errors) return []
  return errors.map((e) => `item[${itemIndex}]${e.instancePath || ''} ${e.message ?? 'is invalid'}`)
}

/** Stable stringify so `expected` comparison does not depend on key order. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key])
    return out
  }
  return value
}

/**
 * Fraction of items where each field is null, undefined or absent.
 *
 * The union of keys across all items is used, so a field that vanishes from half the items
 * shows up as 0.5 rather than disappearing — which is the failure mode section 8's
 * `null_rate` trip is built to catch.
 */
function fieldNullRates(items: unknown[], requiredFields: string[]): Record<string, number> {
  const keys = new Set<string>(requiredFields)
  for (const item of items) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of Object.keys(item)) keys.add(key)
    }
  }
  const rates: Record<string, number> = {}
  if (items.length === 0) {
    for (const key of keys) rates[key] = 1
    return rates
  }
  for (const key of keys) {
    let nulls = 0
    for (const item of items) {
      const value =
        item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined
      if (value === null || value === undefined) nulls++
    }
    rates[key] = nulls / items.length
  }
  return rates
}

export function runGate(input: GateInput): GateResult {
  const minFixtures = input.minFixtures ?? MIN_FIXTURES
  const requiredFields = input.requiredFields ?? []
  const failures: GateFailure[] = []
  const reports: GateFixtureReport[] = []

  if (input.fixtures.length < minFixtures) {
    failures.push({
      rule: 'too-few-fixtures',
      message: `the gate needs at least ${minFixtures} fixtures, got ${input.fixtures.length}`,
    })
  }

  const validate = compileSchema(input.outputSchema)

  let totalItems = 0
  let totalValid = 0

  for (const fixture of input.fixtures) {
    let items: unknown[]
    try {
      items = runAdapter(input.codeJs, input.codeHash, fixture, 'extract', input.sandbox ?? {})
    } catch (err) {
      const sandboxError = err instanceof SandboxError ? err : undefined
      const outcome: FixtureOutcome = sandboxError?.kind === 'timeout' ? 'timeout' : 'exec_error'
      reports.push({
        fixtureId: fixture.id,
        url: fixture.url,
        outcome,
        items: 0,
        validItems: 0,
        fieldNulls: fieldNullRates([], requiredFields),
        expected: fixture.expected == null ? 'unset' : 'mismatch',
        schemaErrors: [],
        error: err instanceof Error ? err.message : String(err),
      })
      failures.push({
        rule: 'exec-error',
        fixtureId: fixture.id,
        message: `fixture ${fixture.id} did not execute: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }

    const schemaErrors: string[] = []
    let validItems = 0
    items.forEach((item, index) => {
      if (validate(item)) validItems++
      else schemaErrors.push(...formatErrors(validate.errors, index))
    })

    totalItems += items.length
    totalValid += validItems

    let expected: GateFixtureReport['expected'] = 'unset'
    if (fixture.expected != null) {
      expected = canonical(items) === canonical(fixture.expected) ? 'match' : 'mismatch'
    }

    const outcome: FixtureOutcome =
      items.length === 0 ? 'empty' : validItems < items.length ? 'schema_invalid' : 'ok'

    reports.push({
      fixtureId: fixture.id,
      url: fixture.url,
      outcome,
      items: items.length,
      validItems,
      fieldNulls: fieldNullRates(items, requiredFields),
      expected,
      schemaErrors,
    })

    if (items.length === 0) {
      failures.push({
        rule: 'empty-fixture',
        fixtureId: fixture.id,
        message: `fixture ${fixture.id} yielded 0 items; every fixture must yield at least 1`,
      })
    }
    if (validItems < items.length) {
      failures.push({
        rule: 'schema-invalid',
        fixtureId: fixture.id,
        message: `fixture ${fixture.id}: ${items.length - validItems} of ${items.length} items fail output_schema (${schemaErrors.slice(0, 3).join('; ')})`,
      })
    }
    if (expected === 'mismatch') {
      failures.push({
        rule: 'expected-mismatch',
        fixtureId: fixture.id,
        message: `fixture ${fixture.id}: output does not match the golden expected output`,
      })
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    fixtures: reports,
    totals: {
      fixtures: input.fixtures.length,
      items: totalItems,
      validItems: totalValid,
      schemaInvalidRate: totalItems === 0 ? 1 : (totalItems - totalValid) / totalItems,
    },
  }
}
