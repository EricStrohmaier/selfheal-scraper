/**
 * `forge.fixture` — frozen pages, gzipped, belonging to the source rather than to any one
 * adapter version, so every version tests against the same corpus.
 */

import { gzipSync, gunzipSync } from 'node:zlib'
import { sql } from 'drizzle-orm'
import type { GateFixture } from '@forge/core'

import type { Db } from './client.ts'
import { pgArray } from './sql-util.ts'

export type CaptureFixtureInput = {
  sourceId: string
  url: string
  tier: 'http' | 'browser'
  statusCode: number
  headers: Record<string, string>
  body: string
}

export async function captureFixture(db: Db, input: CaptureFixtureInput): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into forge.fixture (source_id, url, tier, status_code, headers, body)
    values (${input.sourceId}::uuid, ${input.url}, ${input.tier}::forge.fetch_tier,
            ${input.statusCode}, ${JSON.stringify(input.headers)}::jsonb,
            ${gzipSync(Buffer.from(input.body, 'utf8'), { level: 9 })})
    returning id
  `)
  const id = rows[0]?.id
  if (!id) throw new Error('fixture insert returned no row')
  return id
}

type FixtureRow = {
  id: string
  url: string
  status_code: number | null
  headers: Record<string, string> | null
  body: Buffer | Uint8Array
  expected: unknown[] | null
}

function toGateFixture(row: FixtureRow): GateFixture {
  return {
    id: row.id,
    url: row.url,
    status: row.status_code ?? 200,
    headers: row.headers ?? {},
    body: gunzipSync(Buffer.from(row.body)).toString('utf8'),
    expected: row.expected,
  }
}

export async function fixturesForSource(db: Db, sourceId: string, limit = 20): Promise<GateFixture[]> {
  const rows = await db.execute<FixtureRow>(sql`
    select id, url, status_code, headers, body, expected
      from forge.fixture where source_id = ${sourceId}::uuid
     order by captured_at desc limit ${limit}
  `)
  return rows.map(toGateFixture)
}

export async function fixturesByIds(db: Db, ids: string[]): Promise<GateFixture[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<FixtureRow>(sql`
    select id, url, status_code, headers, body, expected
      from forge.fixture where id = any(${pgArray(ids, 'uuid')}) order by captured_at
  `)
  return rows.map(toGateFixture)
}

/** Golden output is human-confirmed, so this exists for a human, not for the agent. */
export async function setExpected(db: Db, fixtureId: string, expected: unknown[]): Promise<void> {
  await db.execute(sql`
    update forge.fixture set expected = ${JSON.stringify(expected)}::jsonb
     where id = ${fixtureId}::uuid
  `)
}
