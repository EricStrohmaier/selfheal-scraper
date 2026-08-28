/**
 * The agent's entire capability surface — master plan section 9.
 *
 * Five tools, and that is the whole allowlist: no shell, no filesystem, no free network.
 * Every call is written to `forge.compile_step`, which is what makes the agent loop
 * debuggable after the fact.
 *
 * The load-bearing constraint, from section 9's repair objective: **nothing here may
 * write `output_schema` or `required_fields`.** If the site genuinely stopped publishing
 * a required field, the correct outcome is a failed repair with that finding — not a
 * loosened schema. Without that rule self-healing degrades into extracting garbage that
 * still validates, which is worse than a source that visibly breaks. `save_adapter` is
 * the only tool that writes anything, and it writes exactly one row to `forge.adapter`.
 */

import { parseHTML } from 'linkedom'
import {
  MIN_FIXTURES,
  runAdapter,
  runGate,
  transpile,
  validateAdapterSource,
  type FetchPlan,
  type GateFixture,
  type GateResult,
} from '@forge/core'
import {
  captureFixture,
  fixturesByIds,
  fixturesForSource,
  insertAdapter,
  type Db,
  type SourceRow,
} from '@forge/db'
import { executeFetchPlan, type FetchHints } from '@forge/fetch'

import { bodyExcerpt, outlinePage } from './outline.ts'
import type { ToolDefinition } from './model.ts'

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fetch_page',
    description:
      'Fetch a URL and store it as a fixture. Returns a structured outline of the page ' +
      '(embedded JSON, repeated semantic attributes, element census) plus a truncated body. ' +
      'Use tier "http" unless the page needs JavaScript to render.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tier: { type: 'string', enum: ['http', 'browser'] },
      },
      required: ['url', 'tier'],
      additionalProperties: false,
    },
  },
  {
    name: 'probe_network',
    description:
      'Load a URL in a browser and report the XHR and fetch calls the page made, with ' +
      'response shapes. Call this BEFORE writing any DOM selector: an internal JSON ' +
      'endpoint costs ~80ms and 3MB against ~2-4s and 300MB for a browser run.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'query_dom',
    description:
      'Test a CSS selector against a stored fixture without writing code. Returns the ' +
      'match count and a sample of matched elements.',
    input_schema: {
      type: 'object',
      properties: {
        fixture_id: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['fixture_id', 'selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_extract',
    description:
      'Sandbox-execute candidate adapter code against fixtures and return the items it ' +
      'produced plus a validation report. Use this to iterate before saving.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'TypeScript source exporting extract, optionally discover' },
        fixture_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_adapter',
    description:
      'Write the adapter as a draft and run the promotion gate. Succeeds only if the ' +
      'static rules pass and the gate passes. Write notes explaining what anchors each ' +
      'field — the repair agent reads them.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        fetch_plan: {
          type: 'object',
          properties: {
            tier: { type: 'string', enum: ['http', 'browser'] },
            urlTemplate: { type: 'string' },
            method: { type: 'string', enum: ['GET', 'POST'] },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string' },
            waitFor: { type: 'string' },
          },
          required: ['tier', 'urlTemplate'],
        },
        notes: { type: 'string' },
      },
      required: ['code', 'fetch_plan', 'notes'],
      additionalProperties: false,
    },
  },
]

export type ToolContext = {
  db: Db
  source: SourceRow
  compileRunId: string
  /** repair runs write a canary; fresh compiles write a draft */
  saveAs: 'draft' | 'canary'
  /** injectable so the loop can be tested with no network */
  fetcher?: typeof executeFetchPlan
  probe?: (url: string) => Promise<NetworkProbeResult>
}

export type NetworkProbeResult = {
  requests: Array<{
    url: string
    method: string
    status: number
    contentType: string
    bytes: number
    /** shape of the response, when it was JSON */
    shape?: unknown
  }>
  note?: string
}

export type ToolResult = {
  /** what goes back to the model */
  output: unknown
  /** compact form written to forge.compile_step.output_summary */
  summary: Record<string, unknown>
  /** set by save_adapter when the gate passes */
  savedAdapterId?: string
}

function fetchPlanFor(url: string, tier: 'http' | 'browser'): FetchPlan {
  return { tier, urlTemplate: url }
}

/**
 * Dispatch one tool call.
 *
 * Nothing in here is allowed to throw. The agent passes whatever it likes as arguments —
 * a fixture id it invented, a selector that does not parse — and an exception would end
 * the entire compile run over one bad argument. Errors come back as tool output so the
 * model can see what it got wrong and try again, which is the whole point of a loop.
 */
export async function executeTool(
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await dispatch(context, name, input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      output: { error: message },
      summary: { tool: name, error: message.slice(0, 500) },
    }
  }
}

async function dispatch(
  context: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'fetch_page':
      return fetchPage(context, input)
    case 'probe_network':
      return probeNetwork(context, input)
    case 'query_dom':
      return queryDom(context, input)
    case 'run_extract':
      return runExtract(context, input)
    case 'save_adapter':
      return saveAdapter(context, input)
    default:
      return {
        output: { error: `unknown tool "${name}"` },
        summary: { error: 'unknown tool', name },
      }
  }
}

async function fetchPage(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input['url'] ?? '')
  const tier = input['tier'] === 'browser' ? 'browser' : 'http'
  const fetcher = context.fetcher ?? executeFetchPlan

  const result = await fetcher(fetchPlanFor(url, tier), url, {
    hints: context.source.fetch_hints as FetchHints,
  })

  if (!result.ok || result.body === undefined) {
    return {
      output: {
        error: result.error ?? result.outcome,
        outcome: result.outcome,
        status: result.status,
        hint:
          result.outcome === 'blocked'
            ? 'The site refused or served a challenge. This is a fetch problem, not an extraction problem — try tier "browser", or report it rather than writing selectors against a challenge page.'
            : undefined,
      },
      summary: { url, tier, outcome: result.outcome, error: result.error },
    }
  }

  const fixtureId = await captureFixture(context.db, {
    sourceId: context.source.id,
    url,
    tier,
    statusCode: result.status ?? 200,
    headers: result.headers ?? {},
    body: result.body,
  })

  const outline = outlinePage(result.body, result.headers?.['content-type'] ?? '')
  return {
    output: {
      fixture_id: fixtureId,
      status: result.status,
      tier_used: result.tier,
      outline,
      body_excerpt: bodyExcerpt(result.body),
    },
    summary: {
      url,
      tier: result.tier,
      fixture_id: fixtureId,
      bytes: result.bytes,
      kind: outline.kind,
      anchors: outline.anchors?.length ?? 0,
    },
  }
}

async function probeNetwork(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const url = String(input['url'] ?? '')
  if (!context.probe) {
    return {
      output: {
        requests: [],
        note: 'Network probing needs a browser and none is available in this environment. Fall back to fetch_page, and look at the embedded JSON reported in the outline before writing DOM selectors.',
      },
      summary: { url, available: false },
    }
  }
  const result = await context.probe(url)
  return {
    output: result,
    summary: { url, requests: result.requests.length },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function queryDom(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const fixtureId = String(input['fixture_id'] ?? '')
  const selector = String(input['selector'] ?? '')
  // Fixture ids are uuids. An invented one is a "no such fixture", not a database error.
  if (!UUID.test(fixtureId)) {
    return {
      output: { error: `"${fixtureId}" is not a fixture id — use one returned by fetch_page` },
      summary: { fixtureId, error: 'malformed id' },
    }
  }
  const [fixture] = await fixturesByIds(context.db, [fixtureId])
  if (!fixture) {
    return { output: { error: `no fixture ${fixtureId}` }, summary: { fixtureId, error: 'not found' } }
  }

  try {
    const { document } = parseHTML(fixture.body)
    const matched = [...document.querySelectorAll(selector)]
    return {
      output: {
        count: matched.length,
        samples: matched.slice(0, 5).map((element) => ({
          text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
          html: element.outerHTML.slice(0, 400),
        })),
      },
      summary: { fixtureId, selector, count: matched.length },
    }
  } catch (err) {
    return {
      output: { error: `invalid selector: ${err instanceof Error ? err.message : String(err)}` },
      summary: { fixtureId, selector, error: 'invalid selector' },
    }
  }
}

async function fixturesFor(context: ToolContext, ids: unknown): Promise<GateFixture[]> {
  if (Array.isArray(ids) && ids.length > 0) {
    const valid = ids.map(String).filter((id) => UUID.test(id))
    if (valid.length > 0) return fixturesByIds(context.db, valid)
  }
  return fixturesForSource(context.db, context.source.id, 10)
}

async function runExtract(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const code = String(input['code'] ?? '')

  // Static rules first. Running code that would be rejected on save wastes an iteration
  // and teaches the model nothing, so the violations come back instead.
  const validation = validateAdapterSource(code)
  if (!validation.ok) {
    return {
      output: { rejected: true, violations: validation.violations },
      summary: { rejected: true, violations: validation.violations.map((v) => v.rule) },
    }
  }

  const fixtures = await fixturesFor(context, input['fixture_ids'])
  if (fixtures.length === 0) {
    return {
      output: { error: 'no fixtures available — call fetch_page first' },
      summary: { error: 'no fixtures' },
    }
  }

  const { codeJs, codeHash } = transpile(code)
  const gate = runGate({
    codeJs,
    codeHash,
    outputSchema: context.source.output_schema,
    requiredFields: context.source.required_fields,
    fixtures,
    // Report against whatever fixtures exist. The 3-fixture floor is a promotion rule,
    // and enforcing it here would just block iteration on the first page fetched.
    minFixtures: 1,
  })

  return {
    output: {
      passed: gate.passed,
      failures: gate.failures,
      fixtures: gate.fixtures.map((report) => ({
        fixture_id: report.fixtureId,
        outcome: report.outcome,
        items: report.items,
        valid_items: report.validItems,
        field_null_rates: report.fieldNulls,
        schema_errors: report.schemaErrors.slice(0, 10),
        error: report.error,
      })),
      sample_items: sampleItems(gate, fixtures, codeJs, codeHash),
    },
    summary: {
      fixtures: fixtures.length,
      items: gate.totals.items,
      valid: gate.totals.validItems,
      passed: gate.passed,
    },
  }
}

/** A couple of real extracted items, so the agent can see what it actually produced. */
function sampleItems(
  gate: GateResult,
  fixtures: GateFixture[],
  codeJs: string,
  codeHash: string,
): unknown[] {
  const first = fixtures[0]
  if (!first || gate.fixtures[0]?.items === 0) return []
  try {
    // Re-running is cheap next to a model call, and it keeps runGate's return shape
    // focused on the verdict rather than carrying payloads around. The script is already
    // compiled and cached by code_hash, so this costs almost nothing.
    return runAdapter(codeJs, codeHash, first).slice(0, 3)
  } catch {
    return []
  }
}

async function saveAdapter(context: ToolContext, input: Record<string, unknown>): Promise<ToolResult> {
  const code = String(input['code'] ?? '')
  const notes = String(input['notes'] ?? '')
  const fetchPlan = input['fetch_plan'] as FetchPlan | undefined

  if (!fetchPlan || typeof fetchPlan.urlTemplate !== 'string') {
    return { output: { error: 'fetch_plan.urlTemplate is required' }, summary: { error: 'bad fetch_plan' } }
  }

  const validation = validateAdapterSource(code)
  if (!validation.ok) {
    return {
      output: { saved: false, rejected: true, violations: validation.violations },
      summary: { saved: false, violations: validation.violations.map((v) => v.rule) },
    }
  }

  const fixtures = await fixturesForSource(context.db, context.source.id, 10)
  const { codeJs, codeHash } = transpile(code)
  const gate = runGate({
    codeJs,
    codeHash,
    outputSchema: context.source.output_schema,
    requiredFields: context.source.required_fields,
    fixtures,
  })

  if (!gate.passed) {
    return {
      output: {
        saved: false,
        gate_failures: gate.failures,
        fixtures_available: fixtures.length,
        hint:
          fixtures.length < MIN_FIXTURES
            ? `The gate needs at least ${MIN_FIXTURES} fixtures and only ${fixtures.length} exist. Fetch more pages.`
            : 'Fix the failures and call save_adapter again.',
      },
      summary: { saved: false, failures: gate.failures.map((f) => f.rule) },
    }
  }

  const adapter = await insertAdapter(context.db, {
    sourceId: context.source.id,
    fetchPlan,
    codeTs: code,
    codeJs,
    codeHash,
    notes,
    status: context.saveAs,
    compileRunId: context.compileRunId,
  })

  return {
    output: {
      saved: true,
      adapter_id: adapter.id,
      version: adapter.version,
      status: adapter.status,
      gate: {
        fixtures: gate.totals.fixtures,
        items: gate.totals.items,
        valid_items: gate.totals.validItems,
      },
    },
    summary: { saved: true, adapter_id: adapter.id, version: adapter.version },
    savedAdapterId: adapter.id,
  }
}
