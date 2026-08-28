/**
 * The agent loop — master plan section 9. One loop, two prompts, a fixed tool allowlist.
 *
 * Iteration caps are hard: 12 for a compile, 8 for a repair, "then fail and record why".
 * The cap is the cost control for the whole agent tier, so it is enforced here rather
 * than trusted to the prompt.
 *
 * Every tool call is written to `forge.compile_step` as it happens, not batched at the
 * end. A run that dies halfway still leaves a complete trace of what it tried.
 */

import { activeAdapter, fixturesForSource, logCompileStep, type Db, type SourceRow } from '@forge/db'

import { costUsd, type ModelClient, type ModelMessage } from './model.ts'
import {
  COMPILE_SYSTEM_PROMPT,
  REPAIR_SYSTEM_PROMPT,
  compileUserMessage,
  repairUserMessage,
} from './prompts.ts'
import { TOOL_DEFINITIONS, executeTool, type NetworkProbeResult, type ToolContext } from './tools.ts'
import { executeFetchPlan } from '@forge/fetch'

/** Master plan section 9: "Iteration cap: 12 tool calls." */
export const COMPILE_ITERATION_CAP = 12
/** Section 9, repair objective: "Iteration cap: 8 tool calls." */
export const REPAIR_ITERATION_CAP = 8

export type AgentOutcome = {
  succeeded: boolean
  adapterId: string | null
  iterations: number
  tokensIn: number
  tokensOut: number
  costUsd: number | null
  model: string
  /** why it failed, or the agent's closing message when it succeeded */
  message: string
}

export type RunAgentOptions = {
  db: Db
  model: ModelClient
  source: SourceRow
  compileRunId: string
  kind: 'compile' | 'repair'
  /** health snapshot from the compile_run row */
  trigger?: Record<string, unknown>
  failingFields?: string[]
  iterationCap?: number
  fetcher?: typeof executeFetchPlan
  probe?: (url: string) => Promise<NetworkProbeResult>
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export async function runAgent(options: RunAgentOptions): Promise<AgentOutcome> {
  const { db, model, source, compileRunId, kind } = options
  const log = options.log ?? (() => {})
  const cap =
    options.iterationCap ?? (kind === 'repair' ? REPAIR_ITERATION_CAP : COMPILE_ITERATION_CAP)

  const context: ToolContext = {
    db,
    source,
    compileRunId,
    // A repair produces `version + 1` as a canary (section 8, step 4) so it proves itself
    // on live traffic before displacing the adapter that is at least partly working.
    // A fresh compile has no incumbent to protect, so it lands as a draft.
    saveAs: kind === 'repair' ? 'canary' : 'draft',
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
  }

  const system = kind === 'repair' ? REPAIR_SYSTEM_PROMPT : COMPILE_SYSTEM_PROMPT
  const messages: ModelMessage[] = [{ role: 'user', content: await openingMessage(options) }]

  let tokensIn = 0
  let tokensOut = 0
  let iterations = 0
  let adapterId: string | null = null
  let lastText = ''

  while (iterations < cap) {
    const response = await model.complete({ system, messages, tools: TOOL_DEFINITIONS })
    tokensIn += response.usage.inputTokens
    tokensOut += response.usage.outputTokens

    if (response.refusal) {
      return outcome({
        succeeded: false,
        adapterId: null,
        iterations,
        tokensIn,
        tokensOut,
        model: model.model,
        message: `the model declined this request (${response.refusal.category ?? 'unspecified'}): ${response.refusal.explanation ?? ''}`,
      })
    }

    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length > 0) lastText = text.trim()

    const toolUses = response.content.filter(
      (block): block is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
        block.type === 'tool_use',
    )

    if (toolUses.length === 0) {
      // No tools requested: the agent has said its piece. For a repair that is a
      // legitimate terminal state — "the site stopped publishing this field" is the
      // correct answer, and section 9 requires it be reported rather than papered over.
      return outcome({
        succeeded: adapterId !== null,
        adapterId,
        iterations,
        tokensIn,
        tokensOut,
        model: model.model,
        message: lastText || 'the agent stopped without saving an adapter',
      })
    }

    messages.push({ role: 'assistant', content: response.content })

    const results: unknown[] = []
    for (const toolUse of toolUses) {
      // The cap counts tool calls, and a parallel batch spends one per call. Stopping
      // mid-batch would leave the model without results it is waiting on, so the batch
      // finishes and the cap is checked at the top of the loop.
      iterations++
      const result = await executeTool(context, toolUse.name, toolUse.input)
      if (result.savedAdapterId) adapterId = result.savedAdapterId

      await logCompileStep(db, compileRunId, iterations, toolUse.name, toolUse.input, result.summary)
      log('tool', { n: iterations, tool: toolUse.name, ...result.summary })

      results.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result.output),
      })
    }

    // All results go back in ONE user message. Splitting them teaches the model to stop
    // making parallel calls.
    messages.push({ role: 'user', content: results })

    if (adapterId !== null) {
      return outcome({
        succeeded: true,
        adapterId,
        iterations,
        tokensIn,
        tokensOut,
        model: model.model,
        message: lastText || 'adapter saved and the promotion gate passed',
      })
    }
  }

  return outcome({
    succeeded: false,
    adapterId: null,
    iterations,
    tokensIn,
    tokensOut,
    model: model.model,
    message: `hit the ${cap}-call iteration cap without a saved adapter. Last message: ${lastText || '(none)'}`,
  })
}

function outcome(partial: Omit<AgentOutcome, 'costUsd'>): AgentOutcome {
  return { ...partial, costUsd: costUsd(partial.model, partial.tokensIn, partial.tokensOut) }
}

async function openingMessage(options: RunAgentOptions): Promise<string> {
  if (options.kind === 'compile') return compileUserMessage(options.source)

  const [current, fixtures] = await Promise.all([
    activeAdapter(options.db, options.source.id),
    fixturesForSource(options.db, options.source.id, 10),
  ])

  return repairUserMessage({
    source: options.source,
    currentCode: current?.code_ts ?? '(the current adapter source could not be loaded)',
    currentNotes: current?.notes ?? null,
    currentFetchPlan: current?.fetch_plan ?? null,
    trigger: options.trigger ?? {},
    failingFields: options.failingFields ?? [],
    fixtures,
  })
}
