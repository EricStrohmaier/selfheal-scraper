import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { transpile, stripTypes, sha256, TranspileError } from '../src/transpile.ts'

const SRC = `
import type { ExtractInput } from '@forge/core'

type Hit = { objectID: string; title: string | null }

export function extract(input: ExtractInput): unknown[] {
  const data = input.json() as { hits: Hit[] }
  return data.hits.map((h) => ({ id: h.objectID, title: h.title ?? '' }))
}
`

describe('transpile', () => {
  test('strips types and keeps the module in ESM for the validator', () => {
    const stripped = stripTypes(SRC)
    assert.ok(stripped.includes('export function extract'))
    assert.ok(!stripped.includes(': ExtractInput'))
    assert.ok(!stripped.includes('type Hit'))
    assert.ok(!stripped.includes('import type'))
  })

  test('emits CommonJS for the sandbox', () => {
    const { codeJs } = transpile(SRC)
    assert.ok(codeJs.includes('module.exports'))
    assert.ok(!codeJs.includes('export function'))
  })

  test('code_hash is sha256 of code_js, matching the schema.sql comment', () => {
    const { codeJs, codeHash } = transpile(SRC)
    assert.equal(codeHash, createHash('sha256').update(codeJs, 'utf8').digest('hex'))
    assert.equal(codeHash.length, 64)
  })

  test('code_hash is stable across runs', () => {
    assert.equal(transpile(SRC).codeHash, transpile(SRC).codeHash)
  })

  test('code_hash changes when behaviour changes', () => {
    const changed = SRC.replace("h.title ?? ''", "h.title ?? 'untitled'")
    assert.notEqual(SRC, changed)
    assert.notEqual(transpile(SRC).codeHash, transpile(changed).codeHash)
  })

  /**
   * code_hash is sha256 of code_js, and esbuild drops comments, so a comment-only edit to
   * code_ts leaves the hash alone. That is the right behaviour for a compiled-script cache
   * key — the two versions execute identically — but it does mean code_hash is not a version
   * identity. Version identity is `unique (source_id, version)` in schema.sql.
   */
  test('a comment-only change does not move the hash, because it does not move code_js', () => {
    const commented = `${SRC}\n// the repair agent reads this; the runtime never sees it`
    assert.equal(transpile(SRC).codeJs, transpile(commented).codeJs)
    assert.equal(transpile(SRC).codeHash, transpile(commented).codeHash)
  })

  test('sha256 is exposed on its own for hashing fixture bodies and payloads', () => {
    assert.equal(sha256('forge'), createHash('sha256').update('forge', 'utf8').digest('hex'))
  })

  test('a value import survives type stripping, so the validator can reject it', () => {
    assert.ok(stripTypes(`import fs from 'node:fs'\nexport function extract(i) { return [] }`).includes('node:fs'))
  })

  test('a type-only import is erased', () => {
    assert.ok(
      !stripTypes(`import type { A } from './a.ts'\nexport function extract(i) { return [] }`).includes('./a.ts'),
    )
  })

  test('source that does not compile raises TranspileError with a position', () => {
    assert.throws(
      () => transpile('export function extract( {{{'),
      (err: unknown) => {
        assert.ok(err instanceof TranspileError)
        assert.equal(typeof err.line, 'number')
        return true
      },
    )
  })
})
