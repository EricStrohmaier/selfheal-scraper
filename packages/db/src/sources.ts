/**
 * Sources and the scheduler tick — master plan section 6, first line.
 *
 * `source.output_schema` and `source.required_fields` are human-owned. Nothing in this
 * file writes them, and nothing in `apps/forge-worker` may either. The only writer is a
 * human with a SQL client.
 */

import { sql } from 'drizzle-orm'

import type { Db } from './client.ts'
import { pgArray } from './sql-util.ts'

export type SourceState = 'new' | 'compiling' | 'active' | 'degraded' | 'repairing' | 'disabled'

export type SourceRow = {
  id: string
  key: string
  intent: string
  entry_url: string
  url_pattern: string | null
  output_schema: Record<string, unknown>
  required_fields: string[]
  cadence: string
  state: SourceState
  fetch_hints: Record<string, unknown>
}

export async function getSource(db: Db, id: string): Promise<SourceRow | null> {
  const rows = await db.execute<SourceRow>(sql`
    select id, key, intent, entry_url, url_pattern, output_schema, required_fields,
           cadence::text as cadence, state, fetch_hints
      from forge.source where id = ${id}::uuid
  `)
  return rows[0] ?? null
}

export async function getSourceByKey(db: Db, key: string): Promise<SourceRow | null> {
  const rows = await db.execute<SourceRow>(sql`
    select id, key, intent, entry_url, url_pattern, output_schema, required_fields,
           cadence::text as cadence, state, fetch_hints
      from forge.source where key = ${key}
  `)
  return rows[0] ?? null
}

/**
 * Sources whose cadence is due — no run inside one cadence window.
 *
 * `degraded` and `disabled` sources are excluded on purpose. A degraded source has
 * stopped writing records (section 8), so continuing to fetch it burns requests to
 * produce runs nobody will act on until the repair lands.
 */
export async function dueSources(db: Db, limit = 50): Promise<SourceRow[]> {
  return await db.execute<SourceRow>(sql`
    select s.id, s.key, s.intent, s.entry_url, s.url_pattern, s.output_schema,
           s.required_fields, s.cadence::text as cadence, s.state, s.fetch_hints
      from forge.source s
     where s.state in ('active', 'repairing')
       and not exists (
         select 1 from runtime.run r
          where r.source_id = s.id and r.created_at > now() - s.cadence
       )
     order by s.updated_at
     limit ${limit}
  `)
}

export async function setSourceState(db: Db, sourceId: string, state: SourceState): Promise<void> {
  await db.execute(sql`
    update forge.source set state = ${state}::forge.source_state, updated_at = now()
     where id = ${sourceId}::uuid
  `)
}

/** Test and seed helper. Writes output_schema, so it is never called from agent code. */
export async function createSource(
  db: Db,
  input: {
    key: string
    intent: string
    entryUrl: string
    outputSchema: Record<string, unknown>
    requiredFields?: string[]
    cadence?: string
    state?: SourceState
    urlPattern?: string
    fetchHints?: Record<string, unknown>
  },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into forge.source (key, intent, entry_url, url_pattern, output_schema,
                              required_fields, cadence, state, fetch_hints)
    values (${input.key}, ${input.intent}, ${input.entryUrl}, ${input.urlPattern ?? null},
            ${JSON.stringify(input.outputSchema)}::jsonb,
            ${pgArray(input.requiredFields ?? [], 'text')},
            ${input.cadence ?? '1 day'}::interval,
            ${input.state ?? 'active'}::forge.source_state,
            ${JSON.stringify(input.fetchHints ?? {})}::jsonb)
    returning id
  `)
  const id = rows[0]?.id
  if (!id) throw new Error(`failed to create source ${input.key}`)
  return id
}
