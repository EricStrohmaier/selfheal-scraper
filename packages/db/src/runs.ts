/**
 * `runtime.run` — "this table is the health signal" (master plan section 3).
 *
 * Every run gets a row whatever happened to it, including the ones that never reached the
 * adapter. A fetch that got blocked is still evidence; dropping it would leave the health
 * window looking healthier than the source actually is.
 */

import { sql } from 'drizzle-orm'
import type { RunOutcome, RunSummary } from '@forge/core'

import type { Db } from './client.ts'

export type RecordRunInput = {
  jobId: number | null
  sourceId: string
  adapterId: string
  adapterVersion: number
  canary: boolean
  outcome: RunOutcome
  httpStatus?: number | null
  fetchMs?: number | null
  parseMs?: number | null
  bytes?: number | null
  items?: number
  validItems?: number
  fieldNulls?: Record<string, number> | null
  error?: string | null
  tierUsed?: string | null
  escalated?: boolean
  complete?: boolean
}

export async function recordRun(db: Db, input: RecordRunInput): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    insert into runtime.run (
      job_id, source_id, adapter_id, adapter_version, canary, http_status,
      fetch_ms, parse_ms, bytes, items, valid_items, field_nulls, outcome, error,
      tier_used, escalated, complete
    ) values (
      ${input.jobId}, ${input.sourceId}::uuid, ${input.adapterId}::uuid,
      ${input.adapterVersion}, ${input.canary}, ${input.httpStatus ?? null},
      ${input.fetchMs ?? null}, ${input.parseMs ?? null}, ${input.bytes ?? null},
      ${input.items ?? 0}, ${input.validItems ?? 0},
      ${input.fieldNulls ? JSON.stringify(input.fieldNulls) : null}::jsonb,
      ${input.outcome}, ${input.error?.slice(0, 4000) ?? null},
      ${input.tierUsed ?? null}, ${input.escalated ?? false}, ${input.complete ?? true}
    )
    returning id
  `)
  const id = rows[0]?.id
  if (id === undefined) throw new Error('run insert returned no row')
  return id
}

type RunSummaryRow = {
  outcome: RunOutcome
  items: number
  valid_items: number
  field_nulls: Record<string, number> | null
}

function toSummary(row: RunSummaryRow): RunSummary {
  return {
    outcome: row.outcome,
    items: row.items,
    validItems: row.valid_items,
    fieldNulls: row.field_nulls,
  }
}

/** Newest first, which is the order `assessHealth` expects. */
export async function recentRuns(
  db: Db,
  sourceId: string,
  limit = 20,
  options: { canary?: boolean } = {},
): Promise<RunSummary[]> {
  const rows = await db.execute<RunSummaryRow>(
    options.canary === undefined
      ? sql`select outcome, items, valid_items, field_nulls from runtime.run
             where source_id = ${sourceId}::uuid order by id desc limit ${limit}`
      : sql`select outcome, items, valid_items, field_nulls from runtime.run
             where source_id = ${sourceId}::uuid and canary = ${options.canary}
             order by id desc limit ${limit}`,
  )
  return rows.map(toSummary)
}

/** Canary runs since the canary adapter was created, which is the window section 6 means. */
export async function runsForAdapter(db: Db, adapterId: string, limit = 100): Promise<RunSummary[]> {
  const rows = await db.execute<RunSummaryRow>(sql`
    select outcome, items, valid_items, field_nulls from runtime.run
     where adapter_id = ${adapterId}::uuid order by id desc limit ${limit}
  `)
  return rows.map(toSummary)
}
