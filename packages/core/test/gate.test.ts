import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { runGate, MIN_FIXTURES, type GateFixture, type GateFailureRule } from '../src/gate.ts'
import { transpile } from '../src/transpile.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', minLength: 1 },
    points: { type: 'integer' },
  },
  required: ['id', 'title'],
  additionalProperties: false,
} as const

function fixture(id: string, items: Array<Record<string, unknown>>, expected?: unknown[]): GateFixture {
  return {
    id,
    url: `https://example.test/${id}`,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items }),
    ...(expected === undefined ? {} : { expected }),
  }
}

const PASSTHROUGH = transpile(`
  export function extract(input) {
    return input.json().items
  }
`)

function gate(fixtures: GateFixture[], adapter = PASSTHROUGH) {
  return runGate({
    codeJs: adapter.codeJs,
    codeHash: adapter.codeHash,
    outputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    requiredFields: ['id', 'title'],
    fixtures,
  })
}

const GOOD = [
  fixture('a', [{ id: '1', title: 'one' }, { id: '2', title: 'two' }]),
  fixture('b', [{ id: '3', title: 'three', points: 9 }]),
  fixture('c', [{ id: '4', title: 'four' }]),
]

function failureRules(result: { failures: Array<{ rule: GateFailureRule }> }): GateFailureRule[] {
  return result.failures.map((f) => f.rule)
}

describe('gate: the passing case', () => {
  test('three good fixtures pass', () => {
    const result = gate(GOOD)
    assert.deepEqual(result.failures, [])
    assert.equal(result.passed, true)
    assert.equal(result.totals.fixtures, 3)
    assert.equal(result.totals.items, 4)
    assert.equal(result.totals.validItems, 4)
    assert.equal(result.totals.schemaInvalidRate, 0)
    assert.deepEqual(
      result.fixtures.map((f) => f.outcome),
      ['ok', 'ok', 'ok'],
    )
  })
})

describe('gate: at least 3 fixtures', () => {
  test('MIN_FIXTURES is 3, per master plan section 5', () => {
    assert.equal(MIN_FIXTURES, 3)
  })

  test('fail — two fixtures', () => {
    const result = gate(GOOD.slice(0, 2))
    assert.equal(result.passed, false)
    assert.ok(failureRules(result).includes('too-few-fixtures'))
  })

  test('the fixtures that are present are still run and reported', () => {
    const result = gate(GOOD.slice(0, 2))
    assert.equal(result.fixtures.length, 2)
    assert.equal(result.totals.items, 3)
  })
})

describe('gate: every fixture yields at least 1 item', () => {
  test('fail — one fixture is empty', () => {
    const result = gate([...GOOD.slice(0, 2), fixture('empty', [])])
    assert.equal(result.passed, false)
    assert.ok(failureRules(result).includes('empty-fixture'))
    assert.equal(result.fixtures[2]?.outcome, 'empty')
  })

  test('the failure names the offending fixture', () => {
    const result = gate([...GOOD.slice(0, 2), fixture('empty', [])])
    const failure = result.failures.find((f) => f.rule === 'empty-fixture')
    assert.equal(failure?.fixtureId, 'empty')
  })
})

describe('gate: 100% schema validation', () => {
  test('fail — a single invalid item among many', () => {
    const result = gate([
      ...GOOD.slice(0, 2),
      fixture('c', [{ id: '4', title: 'four' }, { id: '5' }]),
    ])
    assert.equal(result.passed, false)
    assert.ok(failureRules(result).includes('schema-invalid'))
    assert.equal(result.fixtures[2]?.outcome, 'schema_invalid')
    assert.equal(result.fixtures[2]?.validItems, 1)
    assert.equal(result.fixtures[2]?.items, 2)
  })

  test('fail — a wrong type is caught', () => {
    const result = gate([...GOOD.slice(0, 2), fixture('c', [{ id: '4', title: 'four', points: 'nine' }])])
    assert.equal(result.passed, false)
    assert.ok(result.fixtures[2]?.schemaErrors.some((e) => e.includes('points')))
  })

  test('fail — an extra property is caught when additionalProperties is false', () => {
    const result = gate([...GOOD.slice(0, 2), fixture('c', [{ id: '4', title: 'four', junk: 1 }])])
    assert.equal(result.passed, false)
    assert.ok(failureRules(result).includes('schema-invalid'))
  })

  test('schemaInvalidRate is computed over the whole corpus', () => {
    const result = gate([
      fixture('a', [{ id: '1', title: 'one' }]),
      fixture('b', [{ id: '2', title: 'two' }]),
      fixture('c', [{ id: '3' }, { id: '4' }]),
    ])
    assert.equal(result.totals.items, 4)
    assert.equal(result.totals.validItems, 2)
    assert.equal(result.totals.schemaInvalidRate, 0.5)
  })
})

describe('gate: fixture.expected match where set', () => {
  test('pass — expected matches, key order notwithstanding', () => {
    const result = gate([
      fixture('a', [{ id: '1', title: 'one' }], [{ title: 'one', id: '1' }]),
      ...GOOD.slice(1),
    ])
    assert.deepEqual(result.failures, [])
    assert.equal(result.fixtures[0]?.expected, 'match')
  })

  test('fail — expected does not match', () => {
    const result = gate([
      fixture('a', [{ id: '1', title: 'one' }], [{ id: '1', title: 'ONE' }]),
      ...GOOD.slice(1),
    ])
    assert.equal(result.passed, false)
    assert.ok(failureRules(result).includes('expected-mismatch'))
    assert.equal(result.fixtures[0]?.expected, 'mismatch')
  })

  test('unset expected is not a failure', () => {
    const result = gate(GOOD)
    assert.deepEqual(
      result.fixtures.map((f) => f.expected),
      ['unset', 'unset', 'unset'],
    )
    assert.equal(result.passed, true)
  })
})

describe('gate: adapter failures are outcomes, not crashes', () => {
  test('a thrown error becomes an exec_error outcome', () => {
    const thrower = transpile(`export function extract(input) { throw new Error('lost the anchor') }`)
    const result = gate(GOOD, thrower)
    assert.equal(result.passed, false)
    assert.deepEqual(
      result.fixtures.map((f) => f.outcome),
      ['exec_error', 'exec_error', 'exec_error'],
    )
    assert.ok(result.fixtures[0]?.error?.includes('lost the anchor'))
    assert.equal(failureRules(result).filter((r) => r === 'exec-error').length, 3)
  })

  test('an infinite loop becomes a timeout outcome, not a hung gate', () => {
    const spinner = transpile(`export function extract(input) { while (true) {} }`)
    const result = runGate({
      codeJs: spinner.codeJs,
      codeHash: spinner.codeHash,
      outputSchema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
      fixtures: GOOD,
      sandbox: { timeoutMs: 100 },
    })
    assert.equal(result.passed, false)
    assert.deepEqual(
      result.fixtures.map((f) => f.outcome),
      ['timeout', 'timeout', 'timeout'],
    )
  })
})

describe('gate: field null rates', () => {
  test('a field missing from half the items reports 0.5', () => {
    const result = gate([
      fixture('a', [{ id: '1', title: 'one', points: 3 }, { id: '2', title: 'two' }]),
      ...GOOD.slice(1),
    ])
    assert.equal(result.fixtures[0]?.fieldNulls['points'], 0.5)
    assert.equal(result.fixtures[0]?.fieldNulls['id'], 0)
  })

  test('a required field absent everywhere reports 1', () => {
    const adapter = transpile(`export function extract(input) { return input.json().items }`)
    const result = runGate({
      codeJs: adapter.codeJs,
      codeHash: adapter.codeHash,
      outputSchema: { type: 'object' },
      requiredFields: ['price'],
      fixtures: GOOD,
    })
    assert.equal(result.fixtures[0]?.fieldNulls['price'], 1)
  })
})

describe('gate: output_schema is read, never written', () => {
  test('the schema object handed in is not mutated', () => {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
    const before = JSON.stringify(schema)
    gate(GOOD)
    runGate({
      codeJs: PASSTHROUGH.codeJs,
      codeHash: PASSTHROUGH.codeHash,
      outputSchema: schema,
      fixtures: GOOD,
    })
    assert.equal(JSON.stringify(schema), before)
  })
})
