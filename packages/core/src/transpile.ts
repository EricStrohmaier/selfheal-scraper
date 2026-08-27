/**
 * code_ts -> code_js, plus the sha256 that becomes `forge.adapter.code_hash`.
 *
 * Two different outputs come out of the same source, and they are not interchangeable:
 *
 *  - `strippedTs` keeps the module in ESM with only the type annotations removed. This is
 *    what the validator parses, because acorn cannot read TypeScript.
 *  - `codeJs` is CommonJS. This is what is stored in `forge.adapter.code_js` and what the
 *    sandbox executes, because `vm.Script` runs classic scripts, not modules.
 */

import { createHash } from 'node:crypto'
import { transformSync } from 'esbuild'

export type Transpiled = {
  codeTs: string
  /** ESM with types erased — the validator's parse target */
  strippedTs: string
  /** CommonJS — the sandbox's execution target, and `forge.adapter.code_js` */
  codeJs: string
  /** sha256(codeJs) — `forge.adapter.code_hash`, and the runtime's script-cache key */
  codeHash: string
}

export class TranspileError extends Error {
  override readonly name = 'TranspileError'
  readonly line: number | undefined
  readonly column: number | undefined

  constructor(message: string, line?: number, column?: number) {
    super(message)
    this.line = line
    this.column = column
  }
}

function transform(
  codeTs: string,
  format: 'cjs' | undefined,
  compilerOptions: Record<string, unknown> = {},
): string {
  try {
    return transformSync(codeTs, {
      loader: 'ts',
      format,
      target: 'node22',
      tsconfigRaw: { compilerOptions },
      // Adapters are stored and repaired as source; readable output makes diffs reviewable.
      minify: false,
      sourcefile: 'adapter.ts',
    }).code
  } catch (err) {
    const first = (err as { errors?: Array<{ text: string; location: { line: number; column: number } | null }> })
      .errors?.[0]
    if (first) throw new TranspileError(first.text, first.location?.line, first.location?.column)
    throw new TranspileError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Erase type annotations, keep the module in ESM. Used by the validator.
 *
 * `verbatimModuleSyntax` matters here. Without it esbuild drops an *unused* value import
 * as though it were a type import, and `import fs from 'node:fs'` would vanish before the
 * validator ever saw it. With it, only `import type` is erased — which is exactly the
 * distinction the "no import" rule is trying to draw.
 */
export function stripTypes(codeTs: string): string {
  return transform(codeTs, undefined, { verbatimModuleSyntax: true })
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

export function transpile(codeTs: string): Transpiled {
  const strippedTs = stripTypes(codeTs)
  const codeJs = transform(codeTs, 'cjs')
  return { codeTs, strippedTs, codeJs, codeHash: sha256(codeJs) }
}
