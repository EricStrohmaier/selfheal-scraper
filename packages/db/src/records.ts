/**
 * Writing extracted data — master plan section 3, plus the absence sweep from
 * migrations/001.
 *
 * Change detection comes free from the upsert: an unchanged `content_hash` matches no
 * rows in the CTE, so no change event is written and nothing downstream wakes up.
 */

import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'

import type { Db } from './client.ts'
import { pgArray } from './sql-util.ts'

export type RecordInput = {
  externalKey: string
  payload: unknown
}

export type WriteResult = {
  inserted: number
  updated: number
  unchanged: number
}

/**
 * Hash of the payload, key order made irrelevant.
 *
 * `JSON.stringify` alone would report a change every time a site reorders its JSON keys,
 * which is a change event for every record for no reason.
 */
export function contentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(payload)), 'utf8').digest('hex')
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key])
    return out
  }
  return value
}

/**
 * Upsert records and emit the outbox rows, in one statement per record.
 *
 * This is the plan's own SQL. The `where content_hash is distinct from` clause is what
 * makes the whole thing work: an unchanged record returns zero rows from `up`, so the
 * insert into `change_event` selects nothing.
 *
 * A record coming back after an absence sweep is reactivated and reported as an update.
 */
export async function writeRecords(
  db: Db,
  sourceId: string,
  runId: number | null,
  records: RecordInput[],
): Promise<WriteResult> {
  const result: WriteResult = { inserted: 0, updated: 0, unchanged: 0 }
  if (records.length === 0) return result

  await db.transaction(async (tx) => {
    for (const item of records) {
      const hash = contentHash(item.payload)
      const rows = await tx.execute<{ kind: 'insert' | 'update' }>(sql`
        with up as (
          insert into runtime.record (source_id, external_key, payload, content_hash, last_run_id)
          values (${sourceId}::uuid, ${item.externalKey}, ${JSON.stringify(item.payload)}::jsonb, ${hash}, ${runId})
          on conflict (source_id, external_key) do update
            set payload      = excluded.payload,
                content_hash = excluded.content_hash,
                last_seen    = now(),
                last_run_id  = excluded.last_run_id,
                is_active    = true,
                gone_at      = null
            where runtime.record.content_hash is distinct from excluded.content_hash
               or runtime.record.is_active = false
          returning id, source_id, (xmax = 0) as is_insert
        ),
        evt as (
          insert into runtime.change_event (record_id, source_id, kind)
          select id, source_id, case when is_insert then 'insert' else 'update' end from up
          returning kind
        )
        select kind from evt
      `)

      const kind = rows[0]?.kind
      if (kind === 'insert') result.inserted++
      else if (kind === 'update') result.updated++
      else {
        result.unchanged++
        // Still record that we saw it, or the absence sweep would call it gone.
        await tx.execute(sql`
          update runtime.record
             set last_seen = now(), last_run_id = ${runId}
           where source_id = ${sourceId}::uuid and external_key = ${item.externalKey}
        `)
      }
    }
  })

  return result
}

/**
 * Mark records that this run did not see as gone, and emit a `gone` change event each.
 *
 * Only safe when the run collected the source's *whole* result set. A run that stopped
 * early — aborted, page budget spent, partial pagination — would otherwise deactivate
 * everything it simply did not reach. The caller passes `complete` and this refuses
 * without it; that guard is the entire reason the column exists.
 *
 * Returns the number of records newly marked gone.
 */
export async function sweepAbsent(
  db: Db,
  sourceId: string,
  seenKeys: string[],
  options: { complete: boolean },
): Promise<number> {
  if (!options.complete) return 0
  // An empty result set is indistinguishable from a broken adapter. Never sweep on it.
  if (seenKeys.length === 0) return 0

  const rows = await db.execute<{ id: number }>(sql`
    with gone as (
      update runtime.record
         set is_active = false, gone_at = now()
       where source_id = ${sourceId}::uuid
         and is_active
         and external_key <> all(${pgArray(seenKeys, 'text')})
      returning id, source_id
    )
    insert into runtime.change_event (record_id, source_id, kind)
    select id, source_id, 'gone' from gone
    returning id
  `)
  return rows.length
}

/**
 * Mark records this source has not been seen in since `since` as gone.
 *
 * The key-based `sweepAbsent` above is only correct when the caller holds the source's
 * *entire* result set. A source with several entry jobs — three search queries, five
 * cities — has its result set spread across several runs, and sweeping after each one
 * marks the previous job's records gone, then the next job marks those gone in turn.
 *
 * Sweeping by staleness instead needs no key list: `writeRecords` refreshes `last_seen`
 * on every record it sees, including unchanged ones, so anything still carrying a
 * timestamp from before this tick genuinely was not in any of the source's responses.
 * The `complete` guard is unchanged and still load-bearing.
 */
export async function sweepStale(
  db: Db,
  sourceId: string,
  since: Date,
  options: { complete: boolean },
): Promise<number> {
  if (!options.complete) return 0

  const rows = await db.execute<{ id: number }>(sql`
    with gone as (
      update runtime.record
         set is_active = false, gone_at = now()
       where source_id = ${sourceId}::uuid
         and is_active
         and last_seen < ${since.toISOString()}::timestamptz
      returning id, source_id
    )
    insert into runtime.change_event (record_id, source_id, kind)
    select id, source_id, 'gone' from gone
    returning id
  `)
  return rows.length
}

export type ChangeEventRow = {
  id: number
  record_id: number
  source_id: string
  kind: 'insert' | 'update' | 'gone'
}

/**
 * The outbox read side. LISTEN/NOTIFY is only ever a wakeup — this table stays the source
 * of truth because raw NOTIFY drops messages across a restart.
 */
export async function readChangeEvents(db: Db, limit = 100): Promise<ChangeEventRow[]> {
  return await db.execute<ChangeEventRow>(sql`
    select id, record_id, source_id, kind
      from runtime.change_event
     where consumed_at is null
     order by id
     limit ${limit}
  `)
}

export async function markConsumed(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await db.execute(sql`
    update runtime.change_event set consumed_at = now() where id = any(${pgArray(ids, 'bigint')})
  `)
}
