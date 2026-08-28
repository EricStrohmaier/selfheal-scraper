import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { costUsd, PRICING, rateFor, type AgentTurn } from '../src/model.ts'
import { toResponsesInput, turnKey } from '../src/openai-model.ts'

/**
 * The transcript the agent loop actually builds: a brief, an assistant turn that called
 * one tool, and the result of that call.
 */
const TRANSCRIPT: AgentTurn[] = [
  { role: 'user', text: 'Compile an adapter for example.test' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Fetching the entry page.' },
      { type: 'tool_use', id: 'call_1', name: 'fetch_page', input: { url: 'https://example.test', tier: 'http' } },
    ],
  },
  { role: 'tool_results', results: [{ toolUseId: 'call_1', output: { fixture_id: 'f1', status: 200 } }] },
]

describe('openai: transcript translation', () => {
  test('a user turn becomes a user message', () => {
    const input = toResponsesInput([{ role: 'user', text: 'hello' }])
    assert.deepEqual(input, [{ role: 'user', content: 'hello' }])
  })

  test('a tool call becomes a function_call item keyed by call_id', () => {
    const input = toResponsesInput(TRANSCRIPT)
    const call = input.find((item) => item['type'] === 'function_call')
    assert.ok(call)
    assert.equal(call['call_id'], 'call_1')
    assert.equal(call['name'], 'fetch_page')
    assert.deepEqual(JSON.parse(String(call['arguments'])), {
      url: 'https://example.test',
      tier: 'http',
    })
  })

  /**
   * The shape difference that matters. Anthropic wants results inside a user message;
   * the Responses API wants them as sibling items in the same flat array, matched by
   * call_id. Getting this wrong is a 400, not a subtle degradation.
   */
  test('a tool result is a sibling item, not a user message', () => {
    const input = toResponsesInput(TRANSCRIPT)
    const output = input.find((item) => item['type'] === 'function_call_output')
    assert.ok(output)
    assert.equal(output['call_id'], 'call_1')
    assert.deepEqual(JSON.parse(String(output['output'])), { fixture_id: 'f1', status: 200 })
    assert.equal(
      input.filter((item) => item['role'] === 'user').length,
      1,
      'the only user message is the brief',
    )
  })

  test('every call_id has exactly one matching output', () => {
    const input = toResponsesInput(TRANSCRIPT)
    const calls = input.filter((i) => i['type'] === 'function_call').map((i) => i['call_id'])
    const outputs = input.filter((i) => i['type'] === 'function_call_output').map((i) => i['call_id'])
    assert.deepEqual(calls, outputs)
  })

  test('parallel tool calls each get their own output item', () => {
    const parallel: AgentTurn[] = [
      { role: 'user', text: 'go' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'query_dom', input: {} },
          { type: 'tool_use', id: 'b', name: 'query_dom', input: {} },
        ],
      },
      { role: 'tool_results', results: [{ toolUseId: 'a', output: 1 }, { toolUseId: 'b', output: 2 }] },
    ]
    const input = toResponsesInput(parallel)
    assert.equal(input.filter((i) => i['type'] === 'function_call').length, 2)
    assert.equal(input.filter((i) => i['type'] === 'function_call_output').length, 2)
  })

  /**
   * Reasoning items cannot be reconstructed from the neutral transcript, so an assistant
   * turn whose raw response was cached is replayed verbatim instead. Without this the
   * gpt-5 family loses reasoning continuity across the loop, silently.
   */
  test('a cached raw turn is replayed verbatim, reasoning included', () => {
    const raw = [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', call_id: 'call_1', name: 'fetch_page', arguments: '{}' },
    ]
    const assistantTurn = TRANSCRIPT[1]
    assert.ok(assistantTurn && assistantTurn.role === 'assistant')
    const input = toResponsesInput(TRANSCRIPT, [{ key: turnKey(assistantTurn.content), items: raw }])

    assert.ok(input.some((item) => item['type'] === 'reasoning'), 'reasoning item survived')
    assert.equal(
      input.filter((item) => item['type'] === 'function_call').length,
      1,
      'the cached turn replaced the reconstruction rather than adding to it',
    )
  })

  test('an uncached turn is reconstructed rather than dropped', () => {
    const input = toResponsesInput(TRANSCRIPT, [{ key: 'some-other-turn', items: [] }])
    assert.equal(input.filter((item) => item['type'] === 'function_call').length, 1)
  })

  test('turnKey ignores text blocks, so it identifies a turn by its calls', () => {
    assert.equal(
      turnKey([
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_use', id: 'x', name: 'n', input: {} },
      ]),
      'x',
    )
  })
})

describe('cost accounting across providers', () => {
  test('a checked rate produces a cost', () => {
    assert.deepEqual(PRICING['claude-opus-5'], { inputPerMTok: 5, outputPerMTok: 25 })
    assert.equal(costUsd('claude-opus-5', 1_000_000, 1_000_000), 30)
  })

  /**
   * A model with no verified published rate reports null, not a guess. cost_usd is a
   * column a human reads to decide whether the agent tier is worth running, and a
   * plausible wrong number there is worse than an empty cell.
   */
  test('an unrated model reports null', () => {
    assert.equal(rateFor('gpt-5.5'), null)
    assert.equal(costUsd('gpt-5.5', 100_000, 10_000), null)
  })

  test('FORGE_MODEL_PRICING supplies rates the table does not carry', () => {
    const previous = process.env['FORGE_MODEL_PRICING']
    process.env['FORGE_MODEL_PRICING'] = JSON.stringify({
      'gpt-5.5': { inputPerMTok: 2, outputPerMTok: 8 },
    })
    try {
      assert.deepEqual(rateFor('gpt-5.5'), { inputPerMTok: 2, outputPerMTok: 8 })
      assert.equal(costUsd('gpt-5.5', 1_000_000, 1_000_000), 10)
    } finally {
      if (previous === undefined) delete process.env['FORGE_MODEL_PRICING']
      else process.env['FORGE_MODEL_PRICING'] = previous
    }
  })

  test('malformed FORGE_MODEL_PRICING is ignored rather than throwing', () => {
    const previous = process.env['FORGE_MODEL_PRICING']
    process.env['FORGE_MODEL_PRICING'] = 'not json'
    try {
      assert.equal(rateFor('gpt-5.5'), null)
      assert.equal(costUsd('claude-opus-5', 1_000_000, 0), 5)
    } finally {
      if (previous === undefined) delete process.env['FORGE_MODEL_PRICING']
      else process.env['FORGE_MODEL_PRICING'] = previous
    }
  })
})
