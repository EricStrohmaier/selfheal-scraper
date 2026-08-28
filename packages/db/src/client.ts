/**
 * Postgres connection. The only infrastructure dependency in the system.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema.ts'

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql }

export type ConnectOptions = {
  url?: string
  /** postgres.js pool size; the worker is single-threaded so this stays small */
  max?: number
  /** applied to every statement, so a wedged query cannot pin a worker forever */
  statementTimeoutMs?: number
}

export function connect(options: ConnectOptions = {}): Db {
  const url = options.url ?? process.env['DATABASE_URL']
  if (!url) {
    throw new Error('DATABASE_URL is not set and no url was passed to connect()')
  }

  const sql = postgres(url, {
    max: options.max ?? 4,
    // Nothing in this system streams; a query that has not returned in 30s is stuck.
    connection: { statement_timeout: options.statementTimeoutMs ?? 30_000 },
    onnotice: () => {},
    types: {
      // bigserial ids come back as strings by default, which then compare wrong
      // against numbers. Everything here fits comfortably in a double.
      bigint: postgres.BigInt,
    },
  })

  // drizzle-orm exposes the underlying postgres.js handle as `$client`; nothing here
  // needs to reach past it except `close`.
  return drizzle(sql, { schema }) as unknown as Db
}

export async function close(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 })
}
