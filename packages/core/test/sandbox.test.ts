import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  runAdapter,
  clearScriptCache,
  scriptCacheSize,
  SCRIPT_CACHE_MAX,
  DEFAULT_TIMEOUT_MS,
} from '../src/sandbox.ts'
import { transpile } from '../src/transpile.ts'
import type { FixtureBody } from '../src/contract.ts'

const FIXTURE: FixtureBody = {
  url: 'https://example.test/items',
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"hits":[{"title":"a"},{"title":"b"}]}',
}

/**
 * These tests deliberately bypass the validator. The sandbox is the second of two
 * independent boundaries; it has to hold even when hostile source gets past the first.
 */
function run(codeTs: string, fixture: FixtureBody = FIXTURE): unknown[] {
  const { codeJs, codeHash } = transpile(codeTs)
  return runAdapter(codeJs, codeHash, fixture)
}

function body(expr: string): string {
  return `export function extract(input) { return [${expr}] }`
}

describe('sandbox: the adapter actually runs', () => {
  test('extract receives the fixture and returns items', () => {
    const items = run(`
      export function extract(input) {
        const data = input.json()
        return data.hits.map((h) => ({ title: h.title, from: input.url, status: input.status }))
      }
    `)
    assert.deepEqual(items, [
      { title: 'a', from: 'https://example.test/items', status: 200 },
      { title: 'b', from: 'https://example.test/items', status: 200 },
    ])
  })

  test('headers are readable', () => {
    assert.deepEqual(run(body(`input.headers['content-type']`)), ['application/json'])
  })

  test('json() is memoised — parsed once, same identity twice', () => {
    assert.deepEqual(run(body(`input.json() === input.json()`)), [true])
  })

  test('doc() parses HTML lazily', () => {
    const items = run(
      `export function extract(input) {
         return [...input.doc().querySelectorAll('[data-item]')].map((el) => el.textContent)
       }`,
      { ...FIXTURE, body: '<ul><li data-item>one</li><li data-item>two</li></ul>' },
    )
    assert.deepEqual(items, ['one', 'two'])
  })

  test('discover() can be invoked when present', () => {
    const { codeJs, codeHash } = transpile(`
      export function extract(input) { return [] }
      export function discover(input) { return [input.url + '/1'] }
    `)
    assert.deepEqual(runAdapter(codeJs, codeHash, FIXTURE, 'discover'), [
      'https://example.test/items/1',
    ])
  })

  test('a missing extract export is a clear error', () => {
    const { codeJs, codeHash } = transpile(`export function discover(input) { return [] }`)
    assert.throws(() => runAdapter(codeJs, codeHash, FIXTURE), /does not export "extract"/)
  })

  test('a non-array return is rejected', () => {
    assert.throws(() => run(`export function extract(input) { return { a: 1 } }`), /must return an array/)
  })

  test('an error thrown by the adapter surfaces as an ordinary error', () => {
    assert.throws(
      () => run(`export function extract(input) { throw new Error('no anchor') }`),
      /no anchor/,
    )
  })
})

describe('sandbox: host capabilities are unreachable', () => {
  const blocked: Array<[label: string, expr: string, pattern: RegExp]> = [
    ['require', `require('node:fs')`, /require is not defined/],
    ['fetch', `fetch('https://example.test')`, /fetch is not defined/],
    ['process', `process.env.HOME`, /process is not defined/],
    // `eval` and `Function` are removed from the global outright, so they fail earlier
    // than codeGeneration:{strings:false} would have caught them. The intrinsics remain
    // reachable indirectly, and that path is covered in the prototype-escape suite below.
    ['eval', `eval('1+1')`, /eval is not defined/],
    ['new Function', `new Function('return process.env.HOME')()`, /Function is not defined/],
    ['Function call', `Function('return process.env.HOME')()`, /Function is not defined/],
    ['globalThis', `globalThis`, /globalThis is not defined/],
    ['console', `console.log('x')`, /console is not defined/],
    ['Promise', `Promise.resolve(1)`, /Promise is not defined/],
    ['Reflect', `Reflect.ownKeys({})`, /Reflect is not defined/],
    ['Proxy', `new Proxy({}, {})`, /Proxy is not defined/],
    ['WebAssembly', `WebAssembly.compile()`, /WebAssembly is not defined/],
    ['Atomics', `Atomics.wait()`, /Atomics is not defined/],
    ['SharedArrayBuffer', `new SharedArrayBuffer(8)`, /SharedArrayBuffer is not defined/],
    ['Intl', `Intl.DateTimeFormat`, /Intl is not defined/],
  ]

  for (const [label, expr, pattern] of blocked) {
    test(`${label} is blocked`, () => {
      assert.throws(() => run(body(expr)), pattern)
    })
  }

  test('an infinite loop is terminated by the CPU cap', () => {
    assert.throws(
      () => run(`export function extract(input) { while (true) {} }`),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal((err as NodeJS.ErrnoException).code, 'ERR_SCRIPT_EXECUTION_TIMEOUT')
        return true
      },
    )
  })

  test('a loop that the validator would miss is still terminated', () => {
    assert.throws(
      () => run(`export function extract(input) { let n = 0; for (let i = 0; i < 1e18; i++) n++; return [n] }`),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT',
    )
  })

  test('the default CPU cap is 2s, per master plan section 7', () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 2000)
  })
})

describe('sandbox: prototype-chain escapes', () => {
  /**
   * The escape the master plan calls out by name. Against a naive implementation that
   * passes a normal host object in, this returns the host HOME directory.
   */
  test('input.constructor.constructor is blocked — ExtractInput has no prototype', () => {
    assert.throws(
      () => run(body(`input.constructor.constructor('return process.env.HOME')()`)),
      /Cannot read properties of undefined \(reading 'constructor'\)/,
    )
  })

  test('input.headers has no prototype either', () => {
    assert.throws(
      () => run(body(`input.headers.constructor.constructor('return process.env.HOME')()`)),
      /Cannot read properties of undefined \(reading 'constructor'\)/,
    )
  })

  test('the returned item array is not a lever back into the host realm', () => {
    // [].constructor is the *sandbox* Array, so its constructor is the sandbox Function,
    // which codeGeneration:{strings:false} has already disarmed.
    assert.throws(
      () => run(body(`[].constructor.constructor('return process.env.HOME')()`)),
      /Code generation from strings disallowed/,
    )
  })

  /**
   * Master plan section 7 says the context should hold "only JSON, Object, Array, ...".
   * Read literally — injecting the *host* intrinsics — that is itself a full escape:
   * host `Object.constructor` is the host Function. A fresh vm context already has its
   * own intrinsics, so the correct move is to subtract from them, never to inject.
   */
  test('intrinsics inside the sandbox belong to the sandbox realm, not the host', () => {
    assert.throws(
      () => run(body(`Object.constructor('return process.env.HOME')()`)),
      /Code generation from strings disallowed/,
    )
    assert.deepEqual(run(body(`Object.constructor === (function () {}).constructor`)), [true])
  })

  /**
   * json() and doc() are functions hanging off ExtractInput. If they were host functions,
   * `input.json.constructor` would be the *host* Function and Object.create(null) would
   * have bought nothing. They are built inside the realm instead.
   */
  test('json() is an in-realm function, so it is not a bridge to the host', () => {
    assert.deepEqual(run(body(`input.json.constructor === (function () {}).constructor`)), [true])
    assert.throws(
      () => run(body(`input.json.constructor('return process.env.HOME')()`)),
      /Code generation from strings disallowed/,
    )
  })

  test('json() parses inside the realm, so parsed values carry no host prototypes', () => {
    assert.deepEqual(
      run(body(`input.json().constructor === ({}).constructor`)),
      [true],
    )
  })

  test('no escape attempt ever yields the host environment', () => {
    const attempts = [
      `input.constructor && input.constructor.constructor('return process.env.HOME')()`,
      `input.json.constructor('return process.env.HOME')()`,
      `Object.constructor('return process.env.HOME')()`,
      `({}).constructor.constructor('return process.env.HOME')()`,
      `[].constructor.constructor('return process.env.HOME')()`,
      `(function () {}).constructor('return process.env.HOME')()`,
    ]
    const home = process.env['HOME']
    assert.ok(home, 'this test needs HOME set to be meaningful')
    for (const attempt of attempts) {
      let result: unknown[] | undefined
      try {
        result = run(body(attempt))
      } catch {
        continue // throwing is the expected outcome
      }
      assert.notDeepEqual(result, [home], `escape succeeded: ${attempt}`)
    }
  })
})

describe('sandbox: known limitation, pinned deliberately', () => {
  /**
   * Master plan section 7: the Object.create(null) mitigation "does not cover doc(),
   * which returns a linkedom object". That is still true here — linkedom parses on the
   * host, so the Document it returns carries host prototypes. The actual boundary for
   * this is the dedicated child process (section 7, second mitigation), which is not M1.
   *
   * This test pins the limitation so it fails loudly the day someone closes it, rather
   * than letting the codebase quietly disagree with its own security note.
   */
  test('doc() still returns a host object — the documented residual hole', () => {
    const escaped = run(
      body(`input.doc().constructor === ({}).constructor`),
      { ...FIXTURE, body: '<p>hi</p>' },
    )
    assert.deepEqual(escaped, [false], 'doc() returned an in-realm object — update section 7')
  })
})

describe('sandbox: compiled script cache', () => {
  test('a script is compiled once per code_hash', () => {
    clearScriptCache()
    const { codeJs, codeHash } = transpile(body(`input.url`))
    runAdapter(codeJs, codeHash, FIXTURE)
    assert.equal(scriptCacheSize(), 1)
    runAdapter(codeJs, codeHash, FIXTURE)
    assert.equal(scriptCacheSize(), 1)
  })

  test('the cache is keyed by code_hash, not by the source text', () => {
    clearScriptCache()
    const first = transpile(body(`'first'`))
    runAdapter(first.codeJs, 'pinned-hash', FIXTURE)
    const second = transpile(body(`'second'`))
    // Same hash, different source: the cached compilation must win.
    assert.deepEqual(runAdapter(second.codeJs, 'pinned-hash', FIXTURE), ['first'])
  })

  test('the cache is bounded and evicts least-recently-used', () => {
    clearScriptCache()
    for (let i = 0; i < SCRIPT_CACHE_MAX + 5; i++) {
      const { codeJs } = transpile(body(`${i}`))
      runAdapter(codeJs, `hash-${i}`, FIXTURE)
    }
    assert.equal(scriptCacheSize(), SCRIPT_CACHE_MAX)

    // hash-0 was evicted, so re-running it recompiles from whatever source we hand over now.
    const { codeJs } = transpile(body(`'recompiled'`))
    assert.deepEqual(runAdapter(codeJs, 'hash-0', FIXTURE), ['recompiled'])
  })

  test('a recently used entry survives eviction pressure', () => {
    clearScriptCache()
    const keep = transpile(body(`'keep'`))
    runAdapter(keep.codeJs, 'keep', FIXTURE)
    for (let i = 0; i < SCRIPT_CACHE_MAX + 3; i++) {
      const { codeJs } = transpile(body(`${i}`))
      runAdapter(codeJs, `filler-${i}`, FIXTURE)
      runAdapter(keep.codeJs, 'keep', FIXTURE) // keep it hot
    }
    const decoy = transpile(body(`'recompiled'`))
    assert.deepEqual(runAdapter(decoy.codeJs, 'keep', FIXTURE), ['keep'])
  })
})

describe('sandbox: isolation between runs', () => {
  test('module state does not leak from one run to the next', () => {
    const src = `
      let seen = 0
      export function extract(input) { seen++; return [seen] }
    `
    const { codeJs, codeHash } = transpile(src)
    assert.deepEqual(runAdapter(codeJs, codeHash, FIXTURE), [1])
    assert.deepEqual(runAdapter(codeJs, codeHash, FIXTURE), [1])
  })

  test('one adapter cannot see another adapter through the shared realm', () => {
    const a = transpile(`export function extract(input) { return [typeof leaked] }`)
    const planter = transpile(`
      let leaked = 'planted'
      export function extract(input) { return [leaked] }
    `)
    runAdapter(planter.codeJs, planter.codeHash, FIXTURE)
    assert.deepEqual(runAdapter(a.codeJs, a.codeHash, FIXTURE), ['undefined'])
  })
})
