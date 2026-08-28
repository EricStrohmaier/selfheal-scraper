/**
 * Entry point for the agent tier. `--once` drains the compile queue and exits.
 *
 * Separate process from the runtime worker, deliberately. The runtime tier must not be
 * able to reach a model even by accident, and the surest way to guarantee that is for the
 * SDK not to be loaded in its process at all.
 */

import { close, connect } from '@forge/db'
import { closeBrowser } from '@forge/fetch'

import { AnthropicModelClient, DEFAULT_MODEL } from './model.ts'
import { runForever, runOnce } from './worker.ts'

function log(message: string, detail?: Record<string, unknown>): void {
  const line = detail ? `${message} ${JSON.stringify(detail)}` : message
  process.stdout.write(`[forge] ${line}\n`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const once = argv.includes('--once')
  const modelArg = argv.find((a) => a.startsWith('--model='))?.split('=')[1]

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

  const model = new AnthropicModelClient({ model: modelArg ?? DEFAULT_MODEL })
  const db = connect()

  try {
    if (once) {
      const reports = await runOnce({ db, model, signal: controller.signal, log })
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

    log('forge worker started', { model: model.model })
    await runForever({ db, model, signal: controller.signal, log })
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
