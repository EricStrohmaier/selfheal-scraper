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
  output_schema: Record<string, unknown>
  required_fields: string[]
  fetch_plan: { tier: string; waitFor?: string }
  fetch_hints: Record<string, unknown>
}
const fixtures: GateFixture[] = loadFixtures(join(adapterDir, 'fixtures'))
const { codeJs, codeHash } = transpile(codeTs)

const realFetch = globalThis.fetch
before(() => {
  globalThis.fetch = (() => {
    throw new Error('the fixture suite must run offline')
  }) as typeof fetch
})
after(() => {
  globalThis.fetch = realFetch
})

type Item = Record<string, unknown>

function itemsFrom(fixtureId: string): Item[] {
  const fixture = fixtures.find((f) => f.id === fixtureId)
  assert.ok(fixture, `no fixture ${fixtureId}`)
  return runAdapter(codeJs, codeHash, fixture) as Item[]
}

function allItems(): Item[] {
  return fixtures.flatMap((f) => runAdapter(codeJs, codeHash, f) as Item[])
}

describe('willhaben: the source passes the static rules', () => {
  test('no violations — in particular no positional selectors', () => {
    const result = validateAdapterSource(codeTs)
    assert.deepEqual(result.violations, [])
  })

  test('the fetch plan is the browser tier, with a selector to wait for', () => {
    assert.equal(source.fetch_plan.tier, 'browser')
    assert.match(source.fetch_plan.waitFor ?? '', /search-result-entry-header-/)
  })

  test('fetch_hints carry the Austrian locale and the consent selector', () => {
    assert.equal(source.fetch_hints['locale'], 'de-AT')
    assert.deepEqual(source.fetch_hints['consentSelectors'], ['#didomi-notice-agree-button'])
  })
})

describe('willhaben: extraction', () => {
  test('every fixture yields items', () => {
    for (const fixture of fixtures) {
      assert.ok((runAdapter(codeJs, codeHash, fixture) as Item[]).length > 0, fixture.id)
    }
  })

  test('an ad slot sharing the testid prefix is not extracted as a listing', () => {
    const items = itemsFrom('synthetic-page-1')
    assert.equal(items.length, 3)
    assert.equal(items.some((i) => i['title'] === 'Anzeige'), false)
    for (const item of items) assert.match(String(item['id']), /^[0-9]+$/)
  })

  test('relative hrefs are resolved against the willhaben origin', () => {
    for (const item of allItems()) {
      assert.match(String(item['url']), /^https:\/\/www\.willhaben\.at\/iad\//)
    }
  })

  test('the address yields a postal code and a district', () => {
    const item = itemsFrom('synthetic-page-1')[0]
    assert.equal(item?.['address'], '6020 Innsbruck, Wilten')
    assert.equal(item?.['postalCode'], '6020')
    assert.equal(item?.['district'], 'Wilten')
  })

  test('an address with no district leaves it null rather than guessing', () => {
    const sparse = itemsFrom('synthetic-sparse')[0]
    assert.equal(sparse?.['district'], null)
    assert.equal(sparse?.['postalCode'], '6330')
  })
})

describe('willhaben: de-AT number parsing', () => {
  /**
   * The failure mode worth a dedicated test: reading `1.450,00` the en-US way gives
   * 1.45 or 145000, both of which are plausible rents. It corrupts data silently
   * instead of throwing.
   */
  test('a thousands separator is not a decimal point', () => {
    const items = itemsFrom('synthetic-page-1')
    assert.equal(items[0]?.['price'], 1450)
    assert.equal(items[0]?.['priceText'], '€ 1.450,00')
  })

  test('the comma is the decimal separator', () => {
    assert.equal(itemsFrom('synthetic-page-1')[1]?.['price'], 2100.5)
  })

  test('"Preis auf Anfrage" is null, with the original text kept', () => {
    const item = itemsFrom('synthetic-page-1')[2]
    assert.equal(item?.['price'], null)
    assert.equal(item?.['priceText'], 'Preis auf Anfrage')
  })

  test('fractional room counts survive', () => {
    assert.equal(itemsFrom('synthetic-page-2')[0]?.['rooms'], 4.5)
    assert.equal(itemsFrom('synthetic-page-1')[0]?.['sizeM2'], 78.5)
  })

  test('a missing teaser strip leaves size and rooms null', () => {
    const sparse = itemsFrom('synthetic-sparse')[0]
    assert.equal(sparse?.['sizeM2'], null)
    assert.equal(sparse?.['rooms'], null)
    assert.deepEqual(sparse?.['features'], [])
  })

  test('teaser attributes are classified by content, not by position', () => {
    const item = itemsFrom('synthetic-page-1')[0]
    assert.equal(item?.['sizeM2'], 78.5)
    assert.equal(item?.['rooms'], 3)
    assert.deepEqual(item?.['features'], ['Balkon', 'Neubau'])
  })
})

describe('willhaben: discover', () => {
  test('returns one URL per listing plus the next page', () => {
    const fixture = fixtures.find((f) => f.id === 'synthetic-page-1')
    assert.ok(fixture)
    const urls = runAdapter(codeJs, codeHash, fixture, 'discover') as string[]
    assert.equal(urls.length, 4)
    assert.ok(urls.some((u) => u.includes('page=2')))
  })

  /** The next button stays in the DOM on the last page. Following it walks in a circle. */
  test('a disabled next button is not followed', () => {
    const fixture = fixtures.find((f) => f.id === 'synthetic-page-2')
    assert.ok(fixture)
    const urls = runAdapter(codeJs, codeHash, fixture, 'discover') as string[]
    assert.equal(urls.length, 2)
    assert.equal(urls.some((u) => u.includes('page=')), false)
  })
})

describe('willhaben: the promotion gate', () => {
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

  test('every item validates against output_schema', () => {
    assert.equal(result.totals.validItems, result.totals.items)
    assert.equal(result.totals.schemaInvalidRate, 0)
  })

  test('no required field is ever null', () => {
    for (const report of result.fixtures) {
      for (const field of source.required_fields) {
        assert.equal(report.fieldNulls[field], 0, `${field} in ${report.fixtureId}`)
      }
    }
  })

  /**
   * The sparse fixture exists to prove optional fields stay null. If the null rates for
   * price and rooms ever read 0 across the whole corpus, the fixtures have stopped
   * covering the case and the gate has quietly got easier.
   */
  test('optional fields are genuinely exercised as null somewhere in the corpus', () => {
    const sparse = result.fixtures.find((f) => f.fixtureId === 'synthetic-sparse')
    assert.equal(sparse?.fieldNulls['price'], 1)
    assert.equal(sparse?.fieldNulls['rooms'], 1)
  })
})

describe('willhaben: the fixtures are labelled synthetic', () => {
  /**
   * willhaben's robots.txt forbids automated access, so nothing here was captured from
   * the site. This test fails the day someone drops in real captures without updating
   * the manifest — at which point the README's caveat needs revisiting too.
   */
  test('the manifest says so', () => {
    const manifest = JSON.parse(
      readFileSync(join(adapterDir, 'fixtures', 'manifest.json'), 'utf8'),
    ) as Array<{ name: string; synthetic?: boolean }>
    for (const entry of manifest) {
      assert.equal(entry.synthetic, true, `${entry.name} is not marked synthetic`)
      assert.match(entry.name, /^synthetic-/)
    }
  })
})
