import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { validateAdapterSource, type ValidationRule } from '../src/validator.ts'

/** Minimal adapter that violates nothing. Every "passing case" builds on this shape. */
const OK = `
export function extract(input: ExtractInput): unknown[] {
  const data = input.json() as { hits: { title: string }[] }
  return data.hits.map((h) => ({ title: h.title }))
}
`

function rules(src: string): ValidationRule[] {
  return validateAdapterSource(src).violations.map((v) => v.rule)
}

function assertRejects(src: string, rule: ValidationRule): void {
  const result = validateAdapterSource(src)
  assert.equal(result.ok, false, `expected ${rule} to be rejected`)
  assert.ok(
    result.violations.some((v) => v.rule === rule),
    `expected a ${rule} violation, got: ${JSON.stringify(result.violations)}`,
  )
}

function assertAccepts(src: string): void {
  const result = validateAdapterSource(src)
  assert.deepEqual(result.violations, [], 'expected no violations')
  assert.equal(result.ok, true)
}

describe('validator: baseline', () => {
  test('the minimal well-formed adapter passes', () => {
    assertAccepts(OK)
  })

  test('returns a structured violation list, not a boolean', () => {
    const result = validateAdapterSource(`export function extract(i) { return [process.env] }`)
    assert.equal(Array.isArray(result.violations), true)
    const v = result.violations[0]
    assert.ok(v)
    assert.equal(typeof v.rule, 'string')
    assert.equal(typeof v.message, 'string')
    assert.equal(typeof v.line, 'number')
    assert.equal(typeof v.column, 'number')
  })

  test('unparseable source is a violation, not a throw', () => {
    const result = validateAdapterSource('export function extract( {{{')
    assert.equal(result.ok, false)
    assert.deepEqual(rules('export function extract( {{{'), ['parse-error'])
  })
})

describe('rule: exports exactly extract, optionally discover, nothing else', () => {
  test('pass — extract alone', () => {
    assertAccepts(OK)
  })

  test('pass — extract plus discover', () => {
    assertAccepts(`
      export function extract(input) { return [] }
      export function discover(input) { return [] }
    `)
  })

  test('fail — missing extract', () => {
    assertRejects(`export function discover(input) { return [] }`, 'exports')
  })

  test('fail — an extra named export', () => {
    assertRejects(
      `export function extract(input) { return [] }
       export const VERSION = 1`,
      'exports',
    )
  })

  test('fail — a default export', () => {
    assertRejects(
      `export function extract(input) { return [] }
       export default extract`,
      'exports',
    )
  })

  test('fail — extract is not a function', () => {
    assertRejects(`export const extract = 42`, 'exports')
  })

  test('pass — non-exported helpers are fine', () => {
    assertAccepts(`
      function clean(s) { return s.trim() }
      export function extract(input) { return [clean(input.body)] }
    `)
  })
})

describe('rule: forbidden identifiers and syntax', () => {
  const cases: Array<[label: string, src: string, rule: ValidationRule]> = [
    ['import declaration', `import fs from 'node:fs'\nexport function extract(i) { return [] }`, 'forbidden-import'],
    ['dynamic import', `export function extract(i) { return [import('node:fs')] }`, 'forbidden-import'],
    ['require', `export function extract(i) { return [require('node:fs')] }`, 'forbidden-identifier'],
    ['fetch', `export function extract(i) { return [fetch(i.url)] }`, 'forbidden-identifier'],
    ['process', `export function extract(i) { return [process.env.HOME] }`, 'forbidden-identifier'],
    ['globalThis', `export function extract(i) { return [globalThis] }`, 'forbidden-identifier'],
    ['eval', `export function extract(i) { return [eval('1+1')] }`, 'forbidden-identifier'],
    ['new Function', `export function extract(i) { return [new Function('return 1')] }`, 'forbidden-code-generation'],
    ['Function call', `export function extract(i) { return [Function('return 1')] }`, 'forbidden-code-generation'],
    ['async function', `export async function extract(i) { return [] }`, 'forbidden-async'],
    ['await', `const x = await 1\nexport function extract(i) { return [x] }`, 'forbidden-async'],
    ['setTimeout', `export function extract(i) { setTimeout(() => {}, 1); return [] }`, 'forbidden-timer'],
    ['setInterval', `export function extract(i) { setInterval(() => {}, 1); return [] }`, 'forbidden-timer'],
  ]

  for (const [label, src, rule] of cases) {
    test(`fail — ${label}`, () => {
      assertRejects(src, rule)
    })
  }

  test('pass — a type-only import is erased and allowed', () => {
    assertAccepts(`
      import type { ExtractInput } from '@forge/core'
      export function extract(input: ExtractInput): unknown[] { return [input.url] }
    `)
  })

  test('pass — allowlisted globals are not flagged', () => {
    assertAccepts(`
      export function extract(input) {
        return [JSON.stringify({ n: parseInt('1', 10), d: Date.now(), m: Math.max(1, 2) })]
      }
    `)
  })

  test('pass — a local property named process is not the global', () => {
    assertAccepts(`export function extract(input) { return [{ process: input.url }] }`)
  })
})

describe('rule: no unbounded while (true)', () => {
  test('fail — while (true) with no exit', () => {
    assertRejects(
      `export function extract(i) { let n = 0; while (true) { n++ } return [n] }`,
      'unbounded-loop',
    )
  })

  test('fail — for (;;) with no exit', () => {
    assertRejects(`export function extract(i) { for (;;) { i.url } return [] }`, 'unbounded-loop')
  })

  test('fail — while (1) with no exit', () => {
    assertRejects(`export function extract(i) { while (1) { i.url } return [] }`, 'unbounded-loop')
  })

  test('pass — while (true) with a break', () => {
    assertAccepts(`
      export function extract(input) {
        let n = 0
        while (true) { n++; if (n > 10) break }
        return [n]
      }
    `)
  })

  test('pass — while (true) with a return', () => {
    assertAccepts(`
      export function extract(input) {
        while (true) { return [input.url] }
      }
    `)
  })

  test('pass — an ordinary bounded loop', () => {
    assertAccepts(`
      export function extract(input) {
        const out = []
        for (let i = 0; i < 10; i++) out.push(i)
        return out
      }
    `)
  })

  test('fail — a break belonging to an inner loop does not bound the outer one', () => {
    assertRejects(
      `export function extract(i) {
         while (true) { for (const x of [1]) { break } }
         return []
       }`,
      'unbounded-loop',
    )
  })
})

describe('rule: no positional selectors', () => {
  test('fail — :nth-child', () => {
    assertRejects(
      `export function extract(i) { return [i.doc().querySelector('.row:nth-child(2)')] }`,
      'positional-selector',
    )
  })

  test('fail — :nth-of-type', () => {
    assertRejects(
      `export function extract(i) { return [i.doc().querySelector('li:nth-of-type(3)')] }`,
      'positional-selector',
    )
  })

  test('fail — a chain of bare child combinators', () => {
    assertRejects(
      `export function extract(i) { return [...i.doc().querySelectorAll('div > div > span')] }`,
      'positional-selector',
    )
  })

  test('fail — a bare chain in a template literal', () => {
    assertRejects(
      'export function extract(i) { return [i.doc().querySelector(`section > div > a`)] }',
      'positional-selector',
    )
  })

  test('pass — semantic attribute selectors', () => {
    assertAccepts(`
      export function extract(input) {
        return [...input.doc().querySelectorAll('[data-testid="listing"] .price[itemprop]')]
      }
    `)
  })

  test('pass — a single child combinator off an anchored parent', () => {
    assertAccepts(`
      export function extract(input) {
        return [...input.doc().querySelectorAll('[data-list] > li')]
      }
    `)
  })

  test('pass — a > in ordinary prose is not a selector', () => {
    assertAccepts(`
      export function extract(input) {
        return [input.body.split('a > b > c').length]
      }
    `)
  })
})

describe('rule: code_ts under 400 lines', () => {
  test('pass — 399 lines', () => {
    const filler = Array.from({ length: 394 }, (_, i) => `// line ${i}`).join('\n')
    assertAccepts(`${filler}\nexport function extract(input) {\n  return [input.url]\n}\n`)
  })

  test('fail — 401 lines', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `// line ${i}`).join('\n')
    assertRejects(`${filler}\nexport function extract(input) {\n  return [input.url]\n}\n`, 'too-long')
  })
})

describe('rule: does not reference output_schema', () => {
  test('fail — identifier', () => {
    assertRejects(
      `export function extract(i) { return [output_schema] }`,
      'schema-reference',
    )
  })

  test('fail — member access', () => {
    assertRejects(
      `export function extract(i) { return [i.source.output_schema] }`,
      'schema-reference',
    )
  })

  test('fail — camelCase spelling', () => {
    assertRejects(`export function extract(i) { return [i.outputSchema] }`, 'schema-reference')
  })

  test('fail — string form', () => {
    assertRejects(`export function extract(i) { return [i.meta['output_schema']] }`, 'schema-reference')
  })

  test('pass — a field merely named schema is fine', () => {
    assertAccepts(`export function extract(i) { return [{ schema: 'v1' }] }`)
  })
})

describe('validator: reports every violation, not just the first', () => {
  test('collects independent violations together', () => {
    const found = rules(`
      import fs from 'node:fs'
      export const EXTRA = 1
      export async function extract(i) {
        while (true) { process.exit() }
      }
    `)
    for (const expected of [
      'forbidden-import',
      'exports',
      'forbidden-async',
      'unbounded-loop',
      'forbidden-identifier',
    ] satisfies ValidationRule[]) {
      assert.ok(found.includes(expected), `missing ${expected} in ${JSON.stringify(found)}`)
    }
  })
})
