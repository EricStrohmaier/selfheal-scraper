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
      // postgres.js hands int8 back as a string by default, and `postgres.BigInt` hands
      // it back as a BigInt — which then throws the moment it meets a Number
      // (`job.id % 100` in the canary router, for one). Every int8 here is a bigserial
      // surrogate key, so parse them as Numbers to match the declared row types.
      // Precision is exact below 2^53; this system would need ~9e15 rows to reach it.
      bigint: { to: 20, from: [20], serialize: String, parse: Number },
    },
  })

  // drizzle-orm exposes the underlying postgres.js handle as `$client`; nothing here
  // needs to reach past it except `close`.
  return drizzle(sql, { schema }) as unknown as Db
}

export async function close(db: Db): Promise<void> {
  await db.$client.end({ timeout: 5 })
}
