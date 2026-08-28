/**
 * Adapter rows — the artifact that connects the agent tier to the runtime tier.
 *
 * Two partial unique indexes carry the real invariants (`adapter_one_active`,
 * `adapter_one_canary`), so promotion has to move the incumbent out of the way inside the
 * same transaction. Everything here that changes status does exactly that.
 */

import { sql } from 'drizzle-orm'
import type { FetchPlan } from '@forge/core'

import type { Db } from './client.ts'

export type AdapterStatus = 'draft' | 'canary' | 'active' | 'retired' | 'rejected'

export type AdapterRow = {
  id: string
  source_id: string
  version: number
  status: AdapterStatus
  fetch_plan: FetchPlan
  code_ts: string
  code_js: string
  code_hash: string
  notes: string | null
}

const COLUMNS = sql`id, source_id, version, status, fetch_plan, code_ts, code_js, code_hash, notes`

export async function getAdapter(db: Db, id: string): Promise<AdapterRow | null> {
  const rows = await db.execute<AdapterRow>(sql`
    select ${COLUMNS} from forge.adapter where id = ${id}::uuid
  `)
  return rows[0] ?? null
}

export async function activeAdapter(db: Db, sourceId: string): Promise<AdapterRow | null> {
  const rows = await db.execute<AdapterRow>(sql`
    select ${COLUMNS} from forge.adapter
     where source_id = ${sourceId}::uuid and status = 'active'
  `)
  return rows[0] ?? null
}

export async function canaryAdapter(db: Db, sourceId: string): Promise<AdapterRow | null> {
  const rows = await db.execute<AdapterRow>(sql`
    select ${COLUMNS} from forge.adapter
     where source_id = ${sourceId}::uuid and status = 'canary'
  `)
  return rows[0] ?? null
}

export async function nextVersion(db: Db, sourceId: string): Promise<number> {
  const rows = await db.execute<{ v: number }>(sql`
    select coalesce(max(version), 0) + 1 as v from forge.adapter where source_id = ${sourceId}::uuid
  `)
  return rows[0]?.v ?? 1
}

export type InsertAdapterInput = {
  sourceId: string
  fetchPlan: FetchPlan
  codeTs: string
  codeJs: string
  codeHash: string
  notes?: string
  status?: AdapterStatus
  compileRunId?: string
  version?: number
}

export async function insertAdapter(db: Db, input: InsertAdapterInput): Promise<AdapterRow> {
  const version = input.version ?? (await nextVersion(db, input.sourceId))
  const rows = await db.execute<AdapterRow>(sql`
    insert into forge.adapter (source_id, version, status, fetch_plan, code_ts, code_js,
                               code_hash, notes, compile_run_id)
    values (${input.sourceId}::uuid, ${version}, ${input.status ?? 'draft'}::forge.adapter_status,
            ${JSON.stringify(input.fetchPlan)}::jsonb, ${input.codeTs}, ${input.codeJs},
            ${input.codeHash}, ${input.notes ?? null}, ${input.compileRunId ?? null}::uuid)
    returning ${COLUMNS}
  `)
  const row = rows[0]
  if (!row) throw new Error('adapter insert returned no row')
  return row
}

/**
 * Make `adapterId` the canary, retiring any existing one.
 *
 * `adapter_one_canary` means the old canary has to move in the same transaction — a
 * plain update would collide with the index rather than replace the row.
 */
export async function promoteToCanary(db: Db, adapterId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{ source_id: string }>(sql`
      select source_id from forge.adapter where id = ${adapterId}::uuid
    `)
    const sourceId = rows[0]?.source_id
    if (!sourceId) throw new Error(`no adapter ${adapterId}`)

    await tx.execute(sql`
      update forge.adapter set status = 'rejected'
       where source_id = ${sourceId}::uuid and status = 'canary'
    `)
    await tx.execute(sql`
      update forge.adapter set status = 'canary' where id = ${adapterId}::uuid
    `)
  })
}

/**
 * Make `adapterId` active and retire the incumbent.
 *
 * Rollback is the same operation pointed at an older version — which is exactly why the
 * plan can call rollback "flipping a status column".
 */
export async function promoteToActive(db: Db, adapterId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.execute<{ source_id: string }>(sql`
      select source_id from forge.adapter where id = ${adapterId}::uuid
    `)
    const sourceId = rows[0]?.source_id
    if (!sourceId) throw new Error(`no adapter ${adapterId}`)

    await tx.execute(sql`
      update forge.adapter set status = 'retired'
       where source_id = ${sourceId}::uuid and status = 'active' and id <> ${adapterId}::uuid
    `)
    await tx.execute(sql`
      update forge.adapter set status = 'active' where id = ${adapterId}::uuid
    `)
  })
}

export async function rejectAdapter(db: Db, adapterId: string): Promise<void> {
  await db.execute(sql`
    update forge.adapter set status = 'rejected' where id = ${adapterId}::uuid
  `)
}

/**
 * Roll back to the highest-versioned retired adapter.
 *
 * Used when a promoted adapter turns out to be worse than the one it replaced. Returns
 * the adapter now active, or null when there is nothing to roll back to.
 */
export async function rollback(db: Db, sourceId: string): Promise<AdapterRow | null> {
  const candidates = await db.execute<AdapterRow>(sql`
    select ${COLUMNS} from forge.adapter
     where source_id = ${sourceId}::uuid and status = 'retired'
     order by version desc limit 1
  `)
  const target = candidates[0]
  if (!target) return null

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update forge.adapter set status = 'rejected'
       where source_id = ${sourceId}::uuid and status = 'active'
    `)
    await tx.execute(sql`
      update forge.adapter set status = 'active' where id = ${target.id}::uuid
    `)
  })
  return { ...target, status: 'active' }
}
