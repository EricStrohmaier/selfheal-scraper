/**
 * `ModelClient` over the Anthropic Messages API.
 */

import Anthropic from '@anthropic-ai/sdk'

import type {
  AgentTurn,
  CompleteRequest,
  ModelClient,
  ModelContentBlock,
  ModelResponse,
} from './model.ts'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5'

export type AnthropicClientOptions = {
  model?: string
  apiKey?: string
  maxTokens?: number
  /** low | medium | high | xhigh | max — compiling an adapter is worth thinking about */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

function toMessages(turns: AgentTurn[]): Anthropic.MessageParam[] {
  return turns.map((turn): Anthropic.MessageParam => {
    if (turn.role === 'user') return { role: 'user', content: turn.text }
    if (turn.role === 'assistant') {
      return {
        role: 'assistant',
        content: turn.content.map((block) =>
          block.type === 'text'
            ? { type: 'text', text: block.text }
            : { type: 'tool_use', id: block.id, name: block.name, input: block.input },
        ),
      }
    }
    // All results go back in ONE user message. Splitting them teaches the model to stop
    // making parallel calls.
    return {
      role: 'user',
      content: turn.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolUseId,
        content: JSON.stringify(result.output),
      })),
    }
  })
}

export class AnthropicModelClient implements ModelClient {
  readonly model: string
  readonly #client: Anthropic
  readonly #maxTokens: number
  readonly #effort: NonNullable<AnthropicClientOptions['effort']>

  constructor(options: AnthropicClientOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL
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
          // every compile, so they are the stable prefix worth caching.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
      })),
      messages: toMessages(request.turns),
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
    // rather than caught.
    if (response.stop_reason === 'refusal') {
      result.refusal = {
        category: response.stop_details?.category ?? null,
        explanation: response.stop_details?.explanation ?? null,
      }
    }

    return result
  }
}
