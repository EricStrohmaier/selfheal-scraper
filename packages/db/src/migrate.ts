/**
 * Applies schema.sql once, then every file in migrations/ in name order.
 *
 * Deliberately dumb: no drizzle-kit, no generated diffs. schema.sql is hand-written and
 * reviewed, migrations are hand-written and reviewed, and the applied set is recorded so
 * this is safe to call on every worker boot.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import type { Db } from './client.ts'

const BASELINE = 'schema.sql'

export type MigrateOptions = {
  /** repository root — where schema.sql and migrations/ live */
  root: string
}

async function alreadyApplied(db: Db): Promise<Set<string>> {
  await db.execute(sql`
    create table if not exists public.schema_migration (
      name        text primary key,
      applied_at  timestamptz not null default now()
    )
  `)
  const rows = await db.execute<{ name: string }>(sql`select name from public.schema_migration`)
  return new Set(rows.map((r) => r.name))
}

export async function migrate(db: Db, options: MigrateOptions): Promise<string[]> {
  const applied = await alreadyApplied(db)
  const pending: Array<{ name: string; path: string }> = []

  const baselinePath = join(options.root, BASELINE)
  if (!applied.has(BASELINE) && existsSync(baselinePath)) {
    pending.push({ name: BASELINE, path: baselinePath })
  }

  const migrationsDir = join(options.root, 'migrations')
  if (existsSync(migrationsDir)) {
    for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      if (!applied.has(name)) pending.push({ name, path: join(migrationsDir, name) })
    }
  }

  const ran: string[] = []
  for (const migration of pending) {
    const ddl = readFileSync(migration.path, 'utf8')
    // One transaction per file: a half-applied migration is worse than a failed one.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(ddl))
      await tx.execute(sql`insert into public.schema_migration (name) values (${migration.name})`)
    })
    ran.push(migration.name)
  }
  return ran
}

/** Drops both schemas. Tests only — it is not exported from the package index. */
export async function dropAll(db: Db): Promise<void> {
  await db.execute(sql`drop schema if exists runtime cascade`)
  await db.execute(sql`drop schema if exists forge cascade`)
  await db.execute(sql`drop table if exists public.schema_migration`)
}
