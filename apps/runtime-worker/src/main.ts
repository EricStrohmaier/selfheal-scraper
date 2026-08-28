/**
 * Entry point. `--once` for a scheduled run, no flag for a long-lived worker.
 *
 * The plan says there is no CLI in v1, and there is not one here: this takes no source
 * arguments and cannot create or edit anything. Sources are still added by inserting a
 * row. It is a process entry point, which a worker needs in order to be a process.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { close, connect, migrate } from '@forge/db'
import { closeBrowser } from '@forge/fetch'

import { runForever, runOnce } from './worker.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function log(message: string, detail?: Record<string, unknown>): void {
  const line = detail ? `${message} ${JSON.stringify(detail)}` : message
  process.stdout.write(`[runtime] ${line}\n`)
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const once = argv.includes('--once')
  const controller = new AbortController()

  // Cooperative shutdown: the signal reaches the fetcher, the in-flight job finishes, and
  // the queue is left with no rows stuck in `running`.
  let stopping = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130)
      stopping = true
      log(`${signal} received, finishing the current job`)
      controller.abort()
    })
  }

  const db = connect()
  try {
    const applied = await migrate(db, { root })
    if (applied.length > 0) log('migrations applied', { applied })

    if (once) {
      const reports = await runOnce(db, { signal: controller.signal, log })
      const failed = reports.filter((r) => r.outcome !== 'ok' && r.outcome !== 'schema_invalid')
      log('run complete', {
        jobs: reports.length,
        written: reports.reduce((n, r) => n + r.written, 0),
        swept: reports.reduce((n, r) => n + r.swept, 0),
        degraded: reports.filter((r) => r.degraded).map((r) => r.sourceKey),
        failed: failed.length,
      })
      // A scheduled run that scraped nothing successfully should be visibly red in CI.
      // Partial failure is normal and is not: sites go down, and the health window is
      // what decides whether that matters.
      return reports.length > 0 && failed.length === reports.length ? 1 : 0
    }

    log('worker started')
    await runForever(db, { signal: controller.signal, log })
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
      process.stderr.write(`[runtime] fatal: ${err instanceof Error ? err.stack : String(err)}\n`)
      process.exit(1)
    })
}
