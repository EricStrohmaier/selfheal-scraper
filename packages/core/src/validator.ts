/**
 * Static rules enforced before an adapter row is written — master plan section 5.
 *
 * Adapter source is model-generated and therefore untrusted input. This is the first of
 * two independent boundaries; `sandbox.ts` is the second. Neither is allowed to rely on
 * the other being correct.
 *
 * The plan says "parsed with acorn". acorn parses JavaScript, not TypeScript, so the
 * source is type-stripped with esbuild first and the rules run against that. Types are
 * erasable by construction, so nothing a rule cares about survives only in the types —
 * with one deliberate consequence: `import type { ExtractInput } from '@forge/core'`
 * disappears and is therefore allowed, which is the behaviour you want.
 *
 * Reported line and column numbers refer to the type-stripped source, not to `code_ts`.
 * They are close but not identical.
 */

import { Parser } from 'acorn'

import { stripTypes, TranspileError } from './transpile.ts'

export type ValidationRule =
  | 'parse-error'
  | 'exports'
  | 'forbidden-import'
  | 'forbidden-identifier'
  | 'forbidden-code-generation'
  | 'forbidden-async'
  | 'forbidden-timer'
  | 'unbounded-loop'
  | 'positional-selector'
  | 'too-long'
  | 'schema-reference'

export type Violation = {
  rule: ValidationRule
  message: string
  /** 1-based, in the type-stripped source */
  line: number
  /** 0-based, in the type-stripped source */
  column: number
}

export type ValidationResult = {
  ok: boolean
  violations: Violation[]
  /** the source the AST rules actually ran against; undefined when it would not parse */
  strippedTs?: string
}

export type ValidateOptions = {
  /** master plan section 5: "code_ts under 400 lines" */
  maxLines?: number
}

export const MAX_LINES = 400

/** Referencing any of these at all is a violation. Fail closed: shadowing them also trips. */
const FORBIDDEN_GLOBALS = new Set(['require', 'fetch', 'process', 'globalThis', 'eval'])
const FORBIDDEN_TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'])
const SCHEMA_NAMES = new Set(['output_schema', 'outputSchema'])
const ALLOWED_EXPORTS = new Set(['extract', 'discover'])
const QUERY_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest', 'matches'])

const LOOP_TYPES = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
])
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

type Node = {
  type: string
  loc?: { start: { line: number; column: number } }
  [key: string]: unknown
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

/**
 * Depth-first walk with an ancestor stack. Returning false from `visit` skips the
 * subtree. Hand-rolled rather than pulling in acorn-walk — the dependency budget in the
 * master plan is tight and this is fifteen lines.
 */
function walk(node: Node, visit: (n: Node, ancestors: Node[]) => boolean | void, ancestors: Node[] = []): void {
  if (visit(node, ancestors) === false) return
  const next = [...ancestors, node]
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'type') continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, next)
    } else if (isNode(value)) {
      walk(value, visit, next)
    }
  }
}

function countLines(source: string): number {
  const parts = source.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

/** True when the identifier is being read or written, rather than naming a property or a label. */
function isReference(node: Node, parent: Node | undefined): boolean {
  if (!parent) return true
  switch (parent.type) {
    case 'MemberExpression':
      return parent['computed'] === true || parent['property'] !== node
    case 'Property':
      return parent['computed'] === true || parent['key'] !== node
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return parent['computed'] === true || parent['key'] !== node
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return parent['label'] !== node
    case 'ExportSpecifier':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return false
    default:
      return true
  }
}

/** A constant-truthy loop test: `while (true)`, `while (1)`, `for (;;)`. */
function isAlwaysTrue(test: unknown): boolean {
  if (test === null || test === undefined) return true // for (;;)
  if (!isNode(test)) return false
  if (test.type !== 'Literal') return false
  return Boolean(test['value'])
}

/**
 * Does this loop body contain something that can end the loop?
 *
 * `return` and `throw` count from anywhere except a nested function. An unlabeled
 * `break` only counts when it is not swallowed by a nested loop or switch — which is
 * exactly why `while (true) { for (const x of xs) break }` is still unbounded.
 */
function hasLoopExit(body: Node): boolean {
  let found = false
  walk(body, (n, ancestors) => {
    if (found) return false
    if (FUNCTION_TYPES.has(n.type)) return false
    if (n.type === 'ReturnStatement' || n.type === 'ThrowStatement') {
      found = true
      return false
    }
    if (n.type === 'BreakStatement') {
      if (n['label']) {
        found = true // a labeled break can target this loop; accept it
        return false
      }
      const swallowed = ancestors.some(
        (a) => a !== body && (LOOP_TYPES.has(a.type) || a.type === 'SwitchStatement'),
      )
      if (!swallowed) {
        found = true
        return false
      }
    }
    return undefined
  })
  return found
}

/** Flatten a string literal or a template literal into the selector text it represents. */
function selectorText(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  if (node.type === 'Literal') {
    return typeof node['value'] === 'string' ? (node['value'] as string) : undefined
  }
  if (node.type === 'TemplateLiteral') {
    const quasis = node['quasis']
    if (!Array.isArray(quasis)) return undefined
    // Interpolations become a wildcard placeholder so a `${x}` cannot hide a bare chain.
    return quasis
      .map((q) => (isNode(q) ? String((q['value'] as { cooked?: string } | undefined)?.cooked ?? '') : ''))
      .join('*')
  }
  return undefined
}

const BARE_TYPE_SELECTOR = /^(?:[a-z][a-z0-9-]*|\*)$/i

/**
 * "chains of bare `> div`" — two or more consecutive child combinators whose right-hand
 * side is a naked element name. One anchored hop (`[data-list] > li`) is fine; it is the
 * chain that encodes position rather than meaning.
 */
function hasBareChildChain(selector: string): boolean {
  for (const branch of selector.split(',')) {
    const parts = branch.split('>').map((p) => p.trim())
    if (parts.length < 3) continue
    let consecutive = 0
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]
      if (part !== undefined && BARE_TYPE_SELECTOR.test(part)) {
        consecutive++
        if (consecutive >= 2) return true
      } else {
        consecutive = 0
      }
    }
  }
  return false
}

const POSITIONAL_PSEUDO = /:nth-(?:child|of-type|last-child|last-of-type)\s*\(/i

type ExportedBinding = { name: string; isFunction: boolean; node: Node }

function collectExports(program: Node, add: (rule: ValidationRule, message: string, node: Node) => void): void {
  const body = program['body']
  if (!Array.isArray(body)) return

  const localFunctions = new Set<string>()
  for (const stmt of body) {
    if (!isNode(stmt)) continue
    if (stmt.type === 'FunctionDeclaration' && isNode(stmt['id'])) {
      localFunctions.add(String(stmt['id']['name']))
    }
    if (stmt.type === 'VariableDeclaration' && Array.isArray(stmt['declarations'])) {
      for (const d of stmt['declarations']) {
        if (isNode(d) && isNode(d['id']) && isNode(d['init']) && FUNCTION_TYPES.has(d['init'].type)) {
          localFunctions.add(String(d['id']['name']))
        }
      }
    }
  }

  const exported: ExportedBinding[] = []

  for (const stmt of body) {
    if (!isNode(stmt)) continue

    if (stmt.type === 'ExportDefaultDeclaration') {
      add('exports', 'default exports are not allowed; export `extract` by name', stmt)
      continue
    }
    if (stmt.type === 'ExportAllDeclaration') {
      add('exports', '`export *` is not allowed', stmt)
      continue
    }
    if (stmt.type !== 'ExportNamedDeclaration') continue

    const decl = stmt['declaration']
    if (isNode(decl)) {
      if (decl.type === 'FunctionDeclaration' && isNode(decl['id'])) {
        exported.push({ name: String(decl['id']['name']), isFunction: true, node: decl })
      } else if (decl.type === 'ClassDeclaration' && isNode(decl['id'])) {
        exported.push({ name: String(decl['id']['name']), isFunction: false, node: decl })
      } else if (decl.type === 'VariableDeclaration' && Array.isArray(decl['declarations'])) {
        for (const d of decl['declarations']) {
          if (!isNode(d) || !isNode(d['id'])) continue
          const init = d['init']
          exported.push({
            name: String(d['id']['name']),
            isFunction: isNode(init) && FUNCTION_TYPES.has(init.type),
            node: d,
          })
        }
      }
      continue
    }

    const specifiers = stmt['specifiers']
    if (Array.isArray(specifiers)) {
      for (const spec of specifiers) {
        if (!isNode(spec)) continue
        const exportedNode = spec['exported']
        const local = spec['local']
        const name = isNode(exportedNode) ? String(exportedNode['name'] ?? exportedNode['value']) : ''
        const localName = isNode(local) ? String(local['name']) : name
        exported.push({ name, isFunction: localFunctions.has(localName), node: spec })
      }
    }
  }

  const seen = new Set<string>()
  for (const binding of exported) {
    seen.add(binding.name)
    if (!ALLOWED_EXPORTS.has(binding.name)) {
      add(
        'exports',
        `unexpected export \`${binding.name}\`; an adapter exports \`extract\` and optionally \`discover\`, nothing else`,
        binding.node,
      )
      continue
    }
    if (!binding.isFunction) {
      add('exports', `\`${binding.name}\` must be a function`, binding.node)
    }
  }

  if (!seen.has('extract')) {
    add('exports', 'an adapter must export `extract`', program)
  }
}

export function validateAdapterSource(codeTs: string, options: ValidateOptions = {}): ValidationResult {
  const maxLines = options.maxLines ?? MAX_LINES
  const violations: Violation[] = []

  const push = (rule: ValidationRule, message: string, node?: Node): void => {
    violations.push({
      rule,
      message,
      line: node?.loc?.start.line ?? 1,
      column: node?.loc?.start.column ?? 0,
    })
  }

  const lines = countLines(codeTs)
  if (lines >= maxLines) {
    push('too-long', `code_ts is ${lines} lines; the limit is ${maxLines - 1}`)
  }

  let strippedTs: string
  try {
    strippedTs = stripTypes(codeTs)
  } catch (err) {
    const e = err as TranspileError
    violations.push({
      rule: 'parse-error',
      message: `source does not compile: ${e.message}`,
      line: e.line ?? 1,
      column: e.column ?? 0,
    })
    return { ok: false, violations }
  }

  let program: Node
  try {
    program = Parser.parse(strippedTs, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
      allowAwaitOutsideFunction: true,
    }) as unknown as Node
  } catch (err) {
    const e = err as SyntaxError & { loc?: { line: number; column: number } }
    violations.push({
      rule: 'parse-error',
      message: `source does not parse: ${e.message}`,
      line: e.loc?.line ?? 1,
      column: e.loc?.column ?? 0,
    })
    return { ok: false, violations }
  }

  collectExports(program, push)

  walk(program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1]

    switch (node.type) {
      case 'ImportDeclaration':
        push('forbidden-import', 'value imports are not allowed; an adapter is self-contained', node)
        return false
      case 'ImportExpression':
        push('forbidden-import', 'dynamic `import()` is not allowed', node)
        break
      case 'AwaitExpression':
        push('forbidden-async', '`await` is not allowed; extraction is synchronous', node)
        break
      case 'NewExpression':
      case 'CallExpression': {
        const callee = node['callee']
        if (isNode(callee) && callee.type === 'Identifier' && callee['name'] === 'Function') {
          push('forbidden-code-generation', '`Function` constructs code from strings', node)
        }
        if (isNode(callee) && callee.type === 'MemberExpression' && !callee['computed']) {
          const prop = callee['property']
          const method = isNode(prop) ? String(prop['name']) : ''
          if (QUERY_METHODS.has(method)) {
            const args = node['arguments']
            const first = Array.isArray(args) ? args[0] : undefined
            const selector = selectorText(first)
            if (selector !== undefined && hasBareChildChain(selector)) {
              push(
                'positional-selector',
                `selector \`${selector}\` is a chain of bare child combinators; anchor it on a data-*, itemprop or stable class instead`,
                isNode(first) ? first : node,
              )
            }
          }
        }
        break
      }
      case 'Identifier': {
        const name = String(node['name'])
        if (!isReference(node, parent)) {
          // Still catch `foo.output_schema` and `{ outputSchema: ... }`.
          if (SCHEMA_NAMES.has(name)) {
            push(
              'schema-reference',
              '`output_schema` is human-owned; validation is applied by the runtime, not the adapter',
              node,
            )
          }
          break
        }
        if (FORBIDDEN_GLOBALS.has(name)) {
          push('forbidden-identifier', `\`${name}\` is not available to an adapter`, node)
        }
        if (FORBIDDEN_TIMERS.has(name)) {
          push('forbidden-timer', `\`${name}\` is not available to an adapter`, node)
        }
        if (SCHEMA_NAMES.has(name)) {
          push(
            'schema-reference',
            '`output_schema` is human-owned; validation is applied by the runtime, not the adapter',
            node,
          )
        }
        break
      }
      case 'Literal': {
        const value = node['value']
        if (typeof value !== 'string') break
        if (SCHEMA_NAMES.has(value)) {
          push('schema-reference', '`output_schema` is human-owned and may not be referenced', node)
        }
        if (POSITIONAL_PSEUDO.test(value)) {
          push('positional-selector', `\`${value}\` selects by position; anchor on meaning instead`, node)
        }
        break
      }
      case 'TemplateElement': {
        const cooked = (node['value'] as { cooked?: string } | undefined)?.cooked ?? ''
        if (POSITIONAL_PSEUDO.test(cooked)) {
          push('positional-selector', `\`${cooked}\` selects by position; anchor on meaning instead`, node)
        }
        break
      }
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement': {
        if (!isAlwaysTrue(node['test'] ?? null)) break
        const body = node['body']
        if (isNode(body) && hasLoopExit(body)) break
        push('unbounded-loop', 'this loop has no exit; the sandbox CPU cap is not a design tool', node)
        break
      }
    }

    if (FUNCTION_TYPES.has(node.type) && node['async'] === true) {
      push('forbidden-async', '`async` is not allowed; extraction is synchronous', node)
    }
    if (node.type === 'ForOfStatement' && node['await'] === true) {
      push('forbidden-async', '`for await` is not allowed; extraction is synchronous', node)
    }

    return undefined
  })

  return { ok: violations.length === 0, violations, strippedTs }
}
