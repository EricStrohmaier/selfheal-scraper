/**
 * `ModelClient` over the OpenAI Responses API.
 *
 * Two things differ from the Anthropic client in ways that matter, rather than in ways
 * that are just naming:
 *
 * 1. **Tool results are top-level input items, not a user message.** A `function_call`
 *    and its `function_call_output` sit in the same flat `input` array, matched by
 *    `call_id`. There is no "user turn containing tool results" to build, which is why
 *    `AgentTurn` has a `tool_results` case instead of pretending results are user text.
 *
 * 2. **Reasoning items have to be replayed verbatim.** On the gpt-5 family a response
 *    can contain `reasoning` items that the next request needs back, and they cannot be
 *    reconstructed from the neutral transcript — the neutral form deliberately does not
 *    carry them. So each response's raw output items are cached against the tool-call ids
 *    they contained, and replayed exactly when that turn comes round again. Dropping them
 *    is not an error, it just quietly costs reasoning continuity across the loop.
 */

import OpenAI from 'openai'

import type {
  AgentTurn,
  CompleteRequest,
  ModelClient,
  ModelContentBlock,
  ModelResponse,
} from './model.ts'

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5'

export type OpenAiClientOptions = {
  model?: string
  apiKey?: string
  maxOutputTokens?: number
  /** gpt-5 family reasoning depth */
  effort?: 'minimal' | 'low' | 'medium' | 'high'
}

export type RawItem = Record<string, unknown>

/** The tool-call ids an assistant turn contained; used to match a cached raw response. */
export function turnKey(content: ModelContentBlock[]): string {
  return content
    .filter((block): block is Extract<ModelContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
    .map((block) => block.id)
    .join(',')
}

/**
 * Translate the neutral transcript into Responses API input items.
 *
 * Pure, and exported, so the mapping can be tested without a network call — it is the
 * only part of this client with logic worth being wrong about.
 *
 * `rawTurns` carries verbatim output items from earlier responses. When an assistant turn
 * matches one, its raw items are replayed instead of being reconstructed, which is what
 * keeps reasoning items intact across the loop.
 */
export function toResponsesInput(
  turns: AgentTurn[],
  rawTurns: ReadonlyArray<{ key: string; items: RawItem[] }> = [],
): RawItem[] {
  const input: RawItem[] = []

  for (const turn of turns) {
    if (turn.role === 'user') {
      input.push({ role: 'user', content: turn.text })
      continue
    }

    if (turn.role === 'assistant') {
      const cached = rawTurns.find((entry) => entry.key === turnKey(turn.content))
      if (cached) {
        input.push(...cached.items)
        continue
      }
      for (const block of turn.content) {
        if (block.type === 'text') {
          input.push({ role: 'assistant', content: block.text })
        } else {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          })
        }
      }
      continue
    }

    // A function_call and its function_call_output are sibling items in one flat array,
    // matched by call_id — there is no "user message containing results" to build.
    for (const result of turn.results) {
      input.push({
        type: 'function_call_output',
        call_id: result.toolUseId,
        output: JSON.stringify(result.output),
      })
    }
  }

  return input
}

export class OpenAiModelClient implements ModelClient {
  readonly model: string
  readonly #client: OpenAI
  readonly #maxOutputTokens: number
  readonly #effort: NonNullable<OpenAiClientOptions['effort']>
  /** raw output items keyed by the tool-call ids they contained, for verbatim replay */
  readonly #rawTurns: Array<{ key: string; items: RawItem[] }> = []

  constructor(options: OpenAiClientOptions = {}) {
    this.model = options.model ?? DEFAULT_OPENAI_MODEL
    this.#maxOutputTokens = options.maxOutputTokens ?? 16_000
    this.#effort = options.effort ?? 'high'
    // No apiKey passed means the SDK reads OPENAI_API_KEY.
    this.#client = new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {})
  }

  async complete(request: CompleteRequest): Promise<ModelResponse> {
    const response = await this.#client.responses.create({
      model: this.model,
      instructions: request.system,
      input: toResponsesInput(request.turns, this.#rawTurns) as never,
      max_output_tokens: request.maxTokens ?? this.#maxOutputTokens,
      reasoning: { effort: this.#effort },
      tools: request.tools.map((tool) => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        // `strict` would require every property to be in `required` and forbid nested
        // optionals. save_adapter's fetch_plan has genuinely optional fields (method,
        // headers, waitFor), so the schema is advisory here and the tools validate their
        // own arguments — which they have to do anyway, since a model can always send
        // something unexpected.
        strict: false,
      })),
    })

    const content: ModelContentBlock[] = []
    const rawItems: RawItem[] = []

    for (const item of response.output as unknown as RawItem[]) {
      rawItems.push(item)
      if (item['type'] === 'function_call') {
        let parsed: Record<string, unknown> = {}
        try {
          // Never string-match tool arguments — escaping varies by model.
          parsed = JSON.parse(String(item['arguments'] ?? '{}')) as Record<string, unknown>
        } catch {
          parsed = {}
        }
        content.push({
          type: 'tool_use',
          id: String(item['call_id']),
          name: String(item['name']),
          input: parsed,
        })
      } else if (item['type'] === 'message') {
        const blocks = (item['content'] ?? []) as Array<Record<string, unknown>>
        const text = blocks
          .filter((block) => block['type'] === 'output_text')
          .map((block) => String(block['text']))
          .join('\n')
        if (text.length > 0) content.push({ type: 'text', text })
        // A refusal arrives as a content block, not an HTTP error.
        const refused = blocks.find((block) => block['type'] === 'refusal')
        if (refused) {
          return {
            stopReason: 'refusal',
            content,
            usage: {
              inputTokens: response.usage?.input_tokens ?? 0,
              outputTokens: response.usage?.output_tokens ?? 0,
            },
            refusal: { category: null, explanation: String(refused['refusal'] ?? '') },
          }
        }
      }
    }

    const key = turnKey(content)
    if (key.length > 0) this.#rawTurns.push({ key, items: rawItems })

    const hasToolCall = content.some((block) => block.type === 'tool_use')
    return {
      // `incomplete` means the output cap was hit mid-turn; surfacing it as its own stop
      // reason keeps it out of the "the agent chose to stop" path in the loop.
      stopReason: response.status === 'incomplete' ? 'max_tokens' : hasToolCall ? 'tool_use' : 'end_turn',
      content,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        // Reasoning tokens are billed as output and are already included here.
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    }
  }
}
