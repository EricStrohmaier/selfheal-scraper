/**
 * Insert a source and a compile_run. This is what section 10 means by "sources are added
 * by inserting a row, work is triggered by inserting a compile_run" — the agent is then
 * picked up by apps/forge-worker on its next tick.
 *
 * Reads the same source.json shape adapters/ uses, minus fetch_plan and extract.ts: the
 * whole point is that the agent works those out itself.
 *
 * Usage: node scripts/queue-compile.ts <source.json>
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { close, connect, createSource, getSourceByKey, migrate, queueCompileRun } from '@forge/db'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

type Brief = {
  key: string
  intent: string
  entry_url: string
  url_pattern?: string
  cadence?: string
  output_schema: Record<string, unknown>
  required_fields: string[]
  fetch_hints?: Record<string, unknown>
}

async function main(): Promise<number> {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('usage: node scripts/queue-compile.ts <source.json>\n')
    return 1
  }
  const brief = JSON.parse(readFileSync(path, 'utf8')) as Brief

  const db = connect()
  try {
    await migrate(db, { root })
    const existing = await getSourceByKey(db, brief.key)
    const sourceId =
      existing?.id ??
      (await createSource(db, {
        key: brief.key,
        intent: brief.intent,
        entryUrl: brief.entry_url,
        outputSchema: brief.output_schema,
        requiredFields: brief.required_fields,
        ...(brief.cadence ? { cadence: brief.cadence } : {}),
        ...(brief.url_pattern ? { urlPattern: brief.url_pattern } : {}),
        ...(brief.fetch_hints ? { fetchHints: brief.fetch_hints } : {}),
        state: 'new',
      }))

    const compileRunId = await queueCompileRun(db, {
      sourceId,
      kind: 'compile',
      trigger: { manual: true },
    })
    process.stdout.write(
      compileRunId
        ? `queued compile ${compileRunId} for ${brief.key} (source ${sourceId})\n`
        : `${brief.key} already has an open compile or repair\n`,
    )
    return 0
  } finally {
    await close(db)
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
