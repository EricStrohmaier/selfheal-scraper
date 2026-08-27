/**
 * Executing model-written adapter code — master plan section 7.
 *
 * Read section 7's own warning first: `node:vm` is a correctness boundary, not a security
 * boundary. The real containment is a dedicated child process with no credentials and no
 * network egress, and that is not M1. What this file does is close every hole that can be
 * closed from inside the process, and pin the one that cannot.
 *
 * Three things here deviate from the letter of section 7, all deliberately:
 *
 * 1. The plan says the context should contain "only JSON, Object, Array, ...". Read as
 *    *injecting* the host intrinsics, that is a complete escape — host `Object.constructor`
 *    is the host `Function`, and `Object.constructor('return process.env.HOME')()` returns
 *    the host home directory. A fresh vm context already has its own realm intrinsics, so
 *    the allowlist is applied by *subtracting* from those, never by injecting host ones.
 *
 * 2. `Object.create(null)` on `ExtractInput` is necessary but not sufficient. `json` and
 *    `doc` are functions hanging off that object; if they were host functions then
 *    `input.json.constructor` would be the host `Function` and the null prototype would
 *    have bought nothing. `ExtractInput` is therefore *built inside the realm* by a factory
 *    the bootstrap returns, and `json()` parses with the sandbox's own `JSON`.
 *
 * 3. A fresh context per run, not one shared context. Contexts are cheap; compilation is
 *    the expensive part and that is what the LRU caches. This is what stops one adapter
 *    poisoning `Object.prototype` for the next one.
 *
 * The residual hole is `doc()`: linkedom parses on the host, so the Document it returns
 * carries host prototypes. Section 7 says as much. `sandbox.test.ts` pins it.
 */

import vm from 'node:vm'
import { parseHTML } from 'linkedom'

import type { ExtractDocument, FixtureBody } from './contract.ts'

/** Master plan section 7: 2s CPU cap. */
export const DEFAULT_TIMEOUT_MS = 2000

/** Compiled scripts are cached by `code_hash`; this bounds that cache. */
export const SCRIPT_CACHE_MAX = 64

export type SandboxOptions = {
  timeoutMs?: number
}

export type AdapterEntryPoint = 'extract' | 'discover'

/**
 * Everything the realm keeps. Anything not named here is deleted from the sandbox global.
 *
 * This is section 7's list plus the error constructors, `Symbol`, the numeric literals and
 * the URI helpers. Adapters throw, and `discover()` builds URLs; none of those additions is
 * a capability. Notably absent and deliberately so: `Function`, `eval`, `globalThis`,
 * `console`, `Promise`, `Proxy`, `Reflect`, `WebAssembly`, `Atomics`, `SharedArrayBuffer`,
 * `Intl`, `BigInt`, and every typed array.
 */
const REALM_ALLOWLIST = [
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'JSON',
  'Math',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'undefined',
  'NaN',
  'Infinity',
  'encodeURI',
  'encodeURIComponent',
  'decodeURI',
  'decodeURIComponent',
]

/**
 * Runs once per context. Strips the global down to the allowlist, installs the `__forge`
 * slot the invoke script reads through, builds the in-realm `ExtractInput` factory, and
 * freezes the global.
 */
const BOOTSTRAP_SOURCE = `(function () {
  'use strict'
  var g = globalThis
  var allowed = ${JSON.stringify(REALM_ALLOWLIST)}
  var getOwnPropertyNames = Object.getOwnPropertyNames
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
  var defineProperty = Object.defineProperty
  var preventExtensions = Object.preventExtensions
  var create = Object.create
  var freeze = Object.freeze
  var keys = Object.keys
  var parse = JSON.parse

  var names = getOwnPropertyNames(g)
  for (var i = 0; i < names.length; i++) {
    var name = names[i]
    if (allowed.indexOf(name) !== -1 || name === 'globalThis') continue
    try { delete g[name] } catch (e) { /* non-configurable: codeGeneration still disarms it */ }
  }
  try { delete g.globalThis } catch (e) {}

  var slot = { mod: null, fn: 'extract', input: null }
  defineProperty(g, '__forge', { value: slot, writable: false, enumerable: false, configurable: false })

  function makeInput(url, status, headersJson, body, hostDoc) {
    var headers = create(null)
    var raw = parse(headersJson)
    var headerNames = keys(raw)
    for (var i = 0; i < headerNames.length; i++) headers[headerNames[i]] = raw[headerNames[i]]
    freeze(headers)

    var jsonDone = false
    var jsonValue
    var docDone = false
    var docValue

    var input = create(null)
    input.url = url
    input.status = status
    input.headers = headers
    input.body = body
    input.json = function json() {
      if (!jsonDone) { jsonValue = parse(body); jsonDone = true }
      return jsonValue
    }
    input.doc = function doc() {
      if (!docDone) { docValue = hostDoc(); docDone = true }
      return docValue
    }
    freeze(input)
    return input
  }

  // V8 refuses Object.freeze on a contextified global proxy ("Cannot freeze"), so the
  // global is hardened property by property instead: every survivor is pinned
  // non-writable and non-configurable, and the object is closed to new properties.
  var survivors = getOwnPropertyNames(g)
  for (var j = 0; j < survivors.length; j++) {
    var key = survivors[j]
    var descriptor = getOwnPropertyDescriptor(g, key)
    if (!descriptor || !descriptor.configurable || !('value' in descriptor)) continue
    try {
      defineProperty(g, key, {
        value: descriptor.value,
        writable: false,
        enumerable: descriptor.enumerable,
        configurable: false,
      })
    } catch (e) {}
  }
  try { preventExtensions(g) } catch (e) {}

  return { makeInput: makeInput, slot: slot }
})()`

/**
 * Note the shape: an expression evaluating to a function, so the module body runs in its
 * own scope with in-realm `module` / `exports`, and nothing touches the frozen global.
 */
function wrapperSource(codeJs: string): string {
  return `(function () {
  'use strict'
  var module = { exports: {} }
  var exports = module.exports
${codeJs}
  return module.exports
})`
}

type Bootstrap = {
  makeInput(
    url: string,
    status: number,
    headersJson: string,
    body: string,
    hostDoc: () => ExtractDocument,
  ): unknown
  slot: { mod: unknown; fn: AdapterEntryPoint; input: unknown }
}

const bootstrapScript = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'forge:bootstrap' })
const invokeScript = new vm.Script('__forge.mod[__forge.fn](__forge.input)', { filename: 'forge:invoke' })

/** LRU keyed by `code_hash`, exactly as the runtime worker loop in section 6 describes. */
const scriptCache = new Map<string, vm.Script>()

function cachedScript(codeJs: string, codeHash: string): vm.Script {
  const hit = scriptCache.get(codeHash)
  if (hit) {
    scriptCache.delete(codeHash)
    scriptCache.set(codeHash, hit)
    return hit
  }
  const script = new vm.Script(wrapperSource(codeJs), { filename: `forge:adapter:${codeHash}` })
  scriptCache.set(codeHash, script)
  if (scriptCache.size > SCRIPT_CACHE_MAX) {
    const oldest = scriptCache.keys().next()
    if (!oldest.done) scriptCache.delete(oldest.value)
  }
  return script
}

export function clearScriptCache(): void {
  scriptCache.clear()
}

export function scriptCacheSize(): number {
  return scriptCache.size
}

/**
 * `timeout` and `exec_error` are two of the `runtime.run.outcome` values in schema.sql;
 * `contract_error` is an adapter that ran but broke the section 5 contract.
 */
export type SandboxFailureKind = 'timeout' | 'exec_error' | 'contract_error'

export class SandboxError extends Error {
  override readonly name = 'SandboxError'
  readonly kind: SandboxFailureKind
  readonly code: string | undefined
  /** the adapter's own stack, as text — the original object is cross-realm */
  readonly adapterStack: string | undefined

  constructor(
    message: string,
    kind: SandboxFailureKind = 'contract_error',
    code?: string,
    adapterStack?: string,
  ) {
    super(message)
    this.kind = kind
    this.code = code
    this.adapterStack = adapterStack
  }
}

/**
 * Anything thrown inside the vm is constructed in the vm's realm, so `err instanceof Error`
 * is false on the host — and that is true even of Node's own CPU-cap error. Every failure
 * is re-thrown as a host `SandboxError` so callers can use ordinary instanceof checks and
 * map straight onto `runtime.run.outcome`.
 */
function normalizeError(err: unknown): SandboxError {
  if (err instanceof SandboxError) return err
  const shaped = err as { message?: unknown; code?: unknown; stack?: unknown } | null
  const code = typeof shaped?.code === 'string' ? shaped.code : undefined
  const message = typeof shaped?.message === 'string' ? shaped.message : String(err)
  const kind: SandboxFailureKind = code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'timeout' : 'exec_error'
  return new SandboxError(message, kind, code, typeof shaped?.stack === 'string' ? shaped.stack : undefined)
}

/**
 * Copy the result out of the sandbox realm.
 *
 * Items are headed for `runtime.record.payload`, which is jsonb, so a JSON round trip is
 * the same normalization the database would apply anyway. It also means nothing crossing
 * back into the host carries a sandbox prototype or keeps the context alive.
 */
function marshal(value: unknown[], codeHash: string, entryPoint: AdapterEntryPoint): unknown[] {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (err) {
    throw new SandboxError(
      `adapter ${codeHash} "${entryPoint}" returned a value that is not JSON-serialisable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  if (serialized === undefined) {
    throw new SandboxError(`adapter ${codeHash} "${entryPoint}" returned a value that is not JSON-serialisable`)
  }
  return JSON.parse(serialized) as unknown[]
}

/**
 * Execute one adapter entry point against one response.
 *
 * Throws on anything that goes wrong — a missing export, a non-array return, an error the
 * adapter threw, or the CPU cap firing (`ERR_SCRIPT_EXECUTION_TIMEOUT`). Callers that need
 * an outcome rather than an exception wrap this; `gate.ts` does.
 */
export function runAdapter(
  codeJs: string,
  codeHash: string,
  fixture: FixtureBody,
  entryPoint: AdapterEntryPoint = 'extract',
  options: SandboxOptions = {},
): unknown[] {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const context = vm.createContext(Object.create(null) as object, {
      name: `forge:${codeHash}`,
      codeGeneration: { strings: false, wasm: false },
    })

    const bootstrap = bootstrapScript.runInContext(context, { timeout }) as Bootstrap

    const hostDoc = (): ExtractDocument => parseHTML(fixture.body).document
    const input = bootstrap.makeInput(
      fixture.url,
      fixture.status,
      JSON.stringify(fixture.headers ?? {}),
      fixture.body,
      hostDoc,
    )

    const wrapper = cachedScript(codeJs, codeHash).runInContext(context, { timeout }) as () => Record<
      string,
      unknown
    >
    const moduleExports = wrapper()

    if (typeof moduleExports?.[entryPoint] !== 'function') {
      throw new SandboxError(`adapter ${codeHash} does not export "${entryPoint}"`)
    }

    bootstrap.slot.mod = moduleExports
    bootstrap.slot.fn = entryPoint
    bootstrap.slot.input = input

    // Run through a script rather than calling the function directly: only a script run
    // carries the CPU cap, and without it an infinite loop hangs the worker forever.
    const result = invokeScript.runInContext(context, { timeout })

    // Array.isArray sees through the realm boundary; instanceof would not.
    if (!Array.isArray(result)) {
      throw new SandboxError(
        `adapter ${codeHash} "${entryPoint}" must return an array, got ${typeof result}`,
      )
    }
    return marshal(result, codeHash, entryPoint)
  } catch (err) {
    throw normalizeError(err)
  }
}
