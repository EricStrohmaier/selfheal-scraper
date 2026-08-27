import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  loadFixtures,
  runAdapter,
  runGate,
  transpile,
  validateAdapterSource,
  type GateFixture,
} from '@forge/core'

const here = dirname(fileURLToPath(import.meta.url))
const adapterDir = join(here, '..')

const codeTs = readFileSync(join(adapterDir, 'extract.ts'), 'utf8')
const source = JSON.parse(readFileSync(join(adapterDir, 'source.json'), 'utf8')) as {
  key: string
  output_schema: Record<string, unknown>
  required_fields: string[]
  fetch_plan: { tier: string; urlTemplate: string }
}
const fixtures: GateFixture[] = loadFixtures(join(adapterDir, 'fixtures'))
const { codeJs, codeHash } = transpile(codeTs)

/**
 * Definition of done for M1 says the suite runs with no network. Rather than trust that,
 * make a request impossible for the duration of the file.
 */
const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (() => {
    throw new Error('the fixture suite must run offline')
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

describe('hn-algolia: the corpus itself', () => {
  test('three fixtures are committed', () => {
    assert.equal(fixtures.length, 3)
  })

  test('all three are real 200 responses from the JSON endpoint', () => {
    for (const fixture of fixtures) {
      assert.equal(fixture.status, 200)
      assert.match(fixture.url, /^https:\/\/hn\.algolia\.com\/api\/v1\/search\?/)
      assert.match(fixture.headers['content-type'] ?? '', /application\/json/)
    }
  })

  test('the fetch plan uses the http tier, so no browser is involved', () => {
    assert.equal(source.fetch_plan.tier, 'http')
    assert.match(source.fetch_plan.urlTemplate, /^https:\/\/hn\.algolia\.com\/api\/v1\/search\?/)
  })
})

describe('hn-algolia: the source passes the static rules', () => {
  test('no violations', () => {
    const result = validateAdapterSource(codeTs)
    assert.deepEqual(result.violations, [])
    assert.equal(result.ok, true)
  })
})

describe('hn-algolia: extraction through the sandbox', () => {
  for (const fixture of fixtures) {
    test(`${fixture.id} yields valid items`, () => {
      const items = runAdapter(codeJs, codeHash, fixture) as Array<Record<string, unknown>>
      assert.ok(items.length > 0, 'expected at least one item')

      for (const item of items) {
        assert.equal(typeof item['id'], 'string')
        assert.match(String(item['id']), /^[0-9]+$/)
        assert.equal(typeof item['title'], 'string')
        assert.ok(String(item['title']).length > 0)
        assert.equal(typeof item['points'], 'number')
        assert.equal(typeof item['commentCount'], 'number')
        assert.equal(item['itemUrl'], `https://news.ycombinator.com/item?id=${String(item['id'])}`)
        assert.ok(item['url'] === null || typeof item['url'] === 'string')
        assert.ok(!('_highlightResult' in item), 'search-UI markup must not reach the payload')
      }
    })
  }

  test('discover() returns one item URL per hit', () => {
    const fixture = fixtures[0]
    assert.ok(fixture)
    const urls = runAdapter(codeJs, codeHash, fixture, 'discover') as string[]
    assert.ok(urls.length > 0)
    for (const url of urls) {
      assert.match(url, /^https:\/\/news\.ycombinator\.com\/item\?id=[0-9]+$/)
    }
  })

  test('a text post keeps a null url rather than inventing one', () => {
    const withNullUrl = fixtures.flatMap(
      (f) => runAdapter(codeJs, codeHash, f) as Array<Record<string, unknown>>,
    )
    assert.ok(
      withNullUrl.some((item) => item['url'] === null),
      'the committed corpus is meant to include at least one text post',
    )
  })

  test('a hit with no title is dropped, not emitted blank', () => {
    const fixture = fixtures[0]
    assert.ok(fixture)
    const payload = JSON.parse(fixture.body) as { hits: unknown[] }
    const doctored = {
      ...fixture,
      body: JSON.stringify({ hits: [...payload.hits, { objectID: '999', title: null }] }),
    }
    const items = runAdapter(codeJs, codeHash, doctored) as Array<Record<string, unknown>>
    assert.equal(items.some((item) => item['id'] === '999'), false)
  })

  test('a garbage response yields no items instead of throwing', () => {
    const fixture = fixtures[0]
    assert.ok(fixture)
    const items = runAdapter(codeJs, codeHash, { ...fixture, body: '{"hits":"not-an-array"}' })
    assert.deepEqual(items, [])
  })
})

describe('hn-algolia: the promotion gate', () => {
  const result = runGate({
    codeJs,
    codeHash,
    outputSchema: source.output_schema,
    requiredFields: source.required_fields,
    fixtures,
  })

  test('the gate passes', () => {
    assert.deepEqual(result.failures, [])
    assert.equal(result.passed, true)
  })

  test('every fixture yielded items and every item validates', () => {
    assert.equal(result.totals.fixtures, 3)
    assert.ok(result.totals.items >= 3)
    assert.equal(result.totals.validItems, result.totals.items)
    assert.equal(result.totals.schemaInvalidRate, 0)
    for (const report of result.fixtures) {
      assert.equal(report.outcome, 'ok')
      assert.ok(report.items > 0)
    }
  })

  test('the golden expected output matches where a human has set it', () => {
    const golden = result.fixtures.filter((f) => f.expected !== 'unset')
    assert.ok(golden.length > 0, 'at least one fixture should carry confirmed expected output')
    for (const report of golden) assert.equal(report.expected, 'match')
  })

  test('no required field is null anywhere in the corpus', () => {
    for (const report of result.fixtures) {
      for (const field of source.required_fields) {
        assert.equal(report.fieldNulls[field], 0, `${field} is null in ${report.fixtureId}`)
      }
    }
  })
})
