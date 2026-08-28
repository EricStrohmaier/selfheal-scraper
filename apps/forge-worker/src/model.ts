/**
 * The only file in the system that talks to a model.
 *
 * Everything above it works against the `ModelClient` interface, which is what lets the
 * whole agent loop — the tool dispatch, the iteration cap, the gate integration, the
 * compile_step log — be tested offline against a scripted fake. The Anthropic SDK is an
 * implementation detail of this file and nothing imports it elsewhere.
 *
 * `apps/runtime-worker` must never import this module. That is the tier boundary.
 */

import Anthropic from '@anthropic-ai/sdk'

export type ToolDefinition = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type ModelContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

export type ModelMessage = {
  role: 'user' | 'assistant'
  content: string | unknown[]
}

export type ModelResponse = {
  stopReason: string
  content: ModelContentBlock[]
  usage: { inputTokens: number; outputTokens: number }
  /** populated only when stopReason is 'refusal' */
  refusal?: { category: string | null; explanation: string | null }
}

export type CompleteRequest = {
  system: string
  messages: ModelMessage[]
  tools: ToolDefinition[]
  maxTokens?: number
}

export interface ModelClient {
  readonly model: string
  complete(request: CompleteRequest): Promise<ModelResponse>
}

/**
 * Per-million-token rates, for `forge.compile_run.cost_usd`.
 *
 * A compile is meant to be expensive and rare while a run is cheap and constant, so the
 * cost of the agent tier has to be visible per invocation or that claim is unfalsifiable.
 */
export const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const rate = PRICING[model]
  if (!rate) return null
  return (inputTokens / 1e6) * rate.inputPerMTok + (outputTokens / 1e6) * rate.outputPerMTok
}

export const DEFAULT_MODEL = 'claude-opus-5'

export type AnthropicClientOptions = {
  model?: string
  apiKey?: string
  maxTokens?: number
  /** low | medium | high | xhigh | max — compiling an adapter is worth thinking about */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string
  readonly #client: Anthropic
  readonly #maxTokens: number
  readonly #effort: NonNullable<AnthropicClientOptions['effort']>

  constructor(options: AnthropicClientOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL
    this.#maxTokens = options.maxTokens ?? 16_000
    this.#effort = options.effort ?? 'high'
    // No apiKey passed means the SDK resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile, in that order.
    this.#client = new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {})
  }

  async complete(request: CompleteRequest): Promise<ModelResponse> {
    const response = await this.#client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? this.#maxTokens,
      // Adaptive thinking, not a token budget: `budget_tokens` is rejected outright on
      // this model family. Effort is the depth lever instead.
      thinking: { type: 'adaptive' },
      output_config: { effort: this.#effort },
      system: [
        {
          type: 'text',
          text: request.system,
          // The system prompt and the tool list are byte-identical across every turn of
          // every compile, so they are the stable prefix worth caching. Anything
          // per-source goes in the first user message, after this breakpoint.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
      })),
      messages: request.messages as Anthropic.MessageParam[],
    })

    const content: ModelContentBlock[] = []
    for (const block of response.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        })
      }
      // thinking blocks are not replayed: this loop starts a fresh message list per
      // iteration rather than continuing one, so there is nothing to echo back.
    }

    const result: ModelResponse = {
      stopReason: response.stop_reason ?? 'end_turn',
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    }

    // A refusal arrives as HTTP 200 with stop_reason 'refusal', so it has to be checked
    // rather than caught. The agent records it and fails the compile run cleanly.
    if (response.stop_reason === 'refusal') {
      result.refusal = {
        category: response.stop_details?.category ?? null,
        explanation: response.stop_details?.explanation ?? null,
      }
    }

    return result
  }
}
