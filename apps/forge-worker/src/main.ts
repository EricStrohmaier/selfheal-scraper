/**
 * Entry point for the agent tier. `--once` drains the compile queue and exits.
 *
 * Separate process from the runtime worker, deliberately. The runtime tier must not be
 * able to reach a model even by accident, and the surest way to guarantee that is for the
 * SDK not to be loaded in its process at all.
 */

import { close, connect } from '@forge/db'
import { closeBrowser } from '@forge/fetch'

import { AnthropicModelClient, DEFAULT_ANTHROPIC_MODEL } from './anthropic-model.ts'
import { OpenAiModelClient, DEFAULT_OPENAI_MODEL } from './openai-model.ts'
import type { ModelClient } from './model.ts'
import { probeNetwork } from './probe.ts'
import { runForever, runOnce } from './worker.ts'

/**
 * Which provider runs the agent.
 *
 * Inferred from whichever key is present when `--provider` is not given, so a deployment
 * chooses by the secret it holds rather than by remembering a flag.
 */
function buildModel(provider: string | undefined, model: string | undefined): ModelClient {
  const chosen =
    provider ??
    (process.env['ANTHROPIC_API_KEY'] ? 'anthropic' : process.env['OPENAI_API_KEY'] ? 'openai' : 'anthropic')

  if (chosen === 'openai') return new OpenAiModelClient({ model: model ?? DEFAULT_OPENAI_MODEL })
  if (chosen === 'anthropic') return new AnthropicModelClient({ model: model ?? DEFAULT_ANTHROPIC_MODEL })
  throw new Error(`unknown provider "${chosen}" — use anthropic or openai`)
}

function log(message: string, detail?: Record<string, unknown>): void {
  const line = detail ? `${message} ${JSON.stringify(detail)}` : message
  process.stdout.write(`[forge] ${line}\n`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const once = argv.includes('--once')
  const modelArg = argv.find((a) => a.startsWith('--model='))?.split('=')[1]
  const providerArg = argv.find((a) => a.startsWith('--provider='))?.split('=')[1]

  const controller = new AbortController()
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130)
      stopping = true
      log(`${signal} received, finishing the current compile`)
      controller.abort()
    })
  }

  const model = buildModel(providerArg, modelArg)
  const db = connect()

  try {
    if (once) {
      const reports = await runOnce({ db, model, probe: probeNetwork, signal: controller.signal, log })
      const failed = reports.filter((r) => !r.outcome.succeeded)
      log('forge run complete', {
        runs: reports.length,
        succeeded: reports.length - failed.length,
        failed: failed.length,
        costUsd: Number(
          reports.reduce((sum, r) => sum + (r.outcome.costUsd ?? 0), 0).toFixed(4),
        ),
      })
      return failed.length > 0 && failed.length === reports.length ? 1 : 0
    }

    log('forge worker started', { provider: providerArg ?? 'auto', model: model.model })
    await runForever({ db, model, probe: probeNetwork, signal: controller.signal, log })
    return 0
  } finally {
    await closeBrowser()
    await close(db)
  }
}

if (import.meta.filename === process.argv[1]) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[forge] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
      process.exit(1)
    })
}
