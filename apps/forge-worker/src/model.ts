/**
 * The provider boundary.
 *
 * `ModelClient` is the only thing the agent loop knows about. Everything provider-shaped
 * — SDK types, message envelopes, tool-call encodings, token accounting — lives in an
 * implementation of it.
 *
 * The transcript type here matters as much as the interface. An earlier version of this
 * file isolated the SDK but let the loop build Anthropic-shaped message objects, which
 * meant "swap the provider" was still a change to the loop. `AgentTurn` is deliberately
 * neutral: a user turn is text, an assistant turn is text and tool calls, and a results
 * turn is a list of outputs keyed by tool-call id. Both providers can express that, and
 * neither one's vocabulary appears in it.
 */

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ModelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** One entry in the conversation, in provider-neutral form. */
export type AgentTurn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; content: ModelContentBlock[] }
  | { role: 'tool_results'; results: Array<{ toolUseId: string; output: unknown }> }

export type ModelResponse = {
  stopReason: string
  content: ModelContentBlock[]
  usage: { inputTokens: number; outputTokens: number }
  /** populated only when the provider declined the request */
  refusal?: { category: string | null; explanation: string | null }
}

export type CompleteRequest = {
  system: string
  turns: AgentTurn[]
  tools: ToolDefinition[]
  maxTokens?: number
}

export interface ModelClient {
  readonly model: string
  complete(request: CompleteRequest): Promise<ModelResponse>
}

export type Rate = { inputPerMTok: number; outputPerMTok: number }

/**
 * Per-million-token rates, for `forge.compile_run.cost_usd`.
 *
 * A compile is meant to be expensive and rare while a run is cheap and constant, so the
 * cost of the agent tier has to be visible per invocation or that claim is unfalsifiable.
 *
 * Only rates that have been checked against the provider's published pricing belong here.
 * An unknown model reports `null` rather than a plausible wrong number — a made-up cost in
 * a column a human reads to decide whether the agent tier is worth running is worse than
 * no cost at all. Supply rates for anything missing via FORGE_MODEL_PRICING.
 */
export const PRICING: Record<string, Rate> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

/** FORGE_MODEL_PRICING='{"gpt-5.5":{"inputPerMTok":1.25,"outputPerMTok":10}}' */
function overrides(): Record<string, Rate> {
  const raw = process.env['FORGE_MODEL_PRICING']
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, Rate>
  } catch {
    return {}
  }
}

export function rateFor(model: string): Rate | null {
  return overrides()[model] ?? PRICING[model] ?? null
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const rate = rateFor(model)
  if (!rate) return null
  return (inputTokens / 1e6) * rate.inputPerMTok + (outputTokens / 1e6) * rate.outputPerMTok
}
