/**
 * Register a committed adapter directory as a source plus an active adapter.
 *
 * This is not a CLI in the sense section 10 rules out — it creates nothing you could not
 * create with two INSERTs, and it takes no arguments beyond a directory. It exists so the
 * hand-written adapters in `adapters/` can be loaded into a database without retyping
 * their output_schema, which is the sort of transcription that goes wrong silently.
 *
 * Usage: node scripts/register-adapter.ts adapters/hn-algolia
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadFixtures, transpile, validateAdapterSource, runGate, type FetchPlan } from '@forge/core'
import {
  captureFixture,
  close,
  connect,
  createSource,
  getSourceByKey,
  insertAdapter,
  migrate,
  promoteToActive,
  setExpected,
} from '@forge/db'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

type SourceFile = {
  key: string
  intent: string
  entry_url: string
  url_pattern?: string
  cadence?: string
  output_schema: Record<string, unknown>
  required_fields: string[]
  fetch_plan: FetchPlan
  fetch_hints?: Record<string, unknown>
}

async function main(): Promise<number> {
  const dir = process.argv[2]
  if (!dir) {
    process.stderr.write('usage: node scripts/register-adapter.ts <adapter-dir>\n')
    return 1
  }

  const source = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as SourceFile
  const codeTs = readFileSync(join(dir, 'extract.ts'), 'utf8')

  // Refuse to load code that would not have survived the compile agent's own gate.
  const validation = validateAdapterSource(codeTs)
  if (!validation.ok) {
    process.stderr.write(`static rules failed:\n${JSON.stringify(validation.violations, null, 2)}\n`)
    return 1
  }

  const db = connect()
  try {
    await migrate(db, { root })

    const existing = await getSourceByKey(db, source.key)
    if (existing) {
      process.stdout.write(`source ${source.key} already exists (${existing.id})\n`)
      return 0
    }

    const sourceId = await createSource(db, {
      key: source.key,
      intent: source.intent,
      entryUrl: source.entry_url,
      outputSchema: source.output_schema,
      requiredFields: source.required_fields,
      ...(source.cadence ? { cadence: source.cadence } : {}),
      ...(source.url_pattern ? { urlPattern: source.url_pattern } : {}),
      ...(source.fetch_hints ? { fetchHints: source.fetch_hints } : {}),
      state: 'active',
    })

    // The committed fixtures come with the adapter, so the gate can be run before the
    // adapter is ever made active — same bar the agent has to clear.
    const fixtures = loadFixtures(join(dir, 'fixtures'))
    const idByName = new Map<string, string>()
    for (const fixture of fixtures) {
      const id = await captureFixture(db, {
        sourceId,
        url: fixture.url,
        tier: source.fetch_plan.tier,
        statusCode: fixture.status,
        headers: fixture.headers,
        body: fixture.body,
      })
      idByName.set(fixture.id, id)
      if (fixture.expected) await setExpected(db, id, fixture.expected)
    }

    const { codeJs, codeHash } = transpile(codeTs)
    const gate = runGate({
      codeJs,
      codeHash,
      outputSchema: source.output_schema,
      requiredFields: source.required_fields,
      fixtures: fixtures.map((f) => ({ ...f, id: idByName.get(f.id) ?? f.id })),
    })
    if (!gate.passed) {
      process.stderr.write(`promotion gate failed:\n${JSON.stringify(gate.failures, null, 2)}\n`)
      return 1
    }

    const adapter = await insertAdapter(db, {
      sourceId,
      fetchPlan: source.fetch_plan,
      codeTs,
      codeJs,
      codeHash,
      notes: `hand-written, registered from ${dir}`,
    })
    await promoteToActive(db, adapter.id)

    process.stdout.write(
      `registered ${source.key}: source ${sourceId}, adapter v${adapter.version}, ` +
        `${fixtures.length} fixtures, gate passed (${gate.totals.items} items)\n`,
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
