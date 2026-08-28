/**
 * `forge.compile_run` — one agent invocation, and the queue for the forge worker.
 *
 * `compile_one_open` is a partial unique index over `state in ('queued','running')`, so a
 * source can only ever have one open compile or repair. That index is what stops a
 * degraded source queueing a repair on every failing run, and it means `queueCompileRun`
 * has to treat a conflict as "already queued" rather than as an error.
 */

import { sql } from 'drizzle-orm'

import type { Db } from './client.ts'

export type CompileKind = 'compile' | 'repair'
export type CompileState = 'queued' | 'running' | 'succeeded' | 'failed' | 'abandoned'

export type CompileRunRow = {
  id: string
  source_id: string
  kind: CompileKind
  state: CompileState
  trigger: Record<string, unknown>
  input: Record<string, unknown>
  attempts: number
}

export type QueueCompileRunInput = {
  sourceId: string
  kind: CompileKind
  /** health snapshot, or {manual:true} */
  trigger?: Record<string, unknown>
  /** prior adapter id, failing fields, fixture ids */
  input?: Record<string, unknown>
}

/**
 * Returns the id of the newly queued run, or null when one was already open.
 *
 * Null is the normal, expected path for a source that keeps failing — not an error.
 */
export async function queueCompileRun(db: Db, input: QueueCompileRunInput): Promise<string | null> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into forge.compile_run (source_id, kind, trigger, input)
    values (${input.sourceId}::uuid, ${input.kind}::forge.compile_kind,
            ${JSON.stringify(input.trigger ?? {})}::jsonb,
            ${JSON.stringify(input.input ?? {})}::jsonb)
    on conflict do nothing
    returning id
  `)
  return rows[0]?.id ?? null
}

export async function claimCompileRun(db: Db, workerId: string): Promise<CompileRunRow | null> {
  const rows = await db.execute<CompileRunRow>(sql`
    with claimed as (
      select id from forge.compile_run
       where state = 'queued' and run_after <= now()
       order by created_at
       for update skip locked
       limit 1
    )
    update forge.compile_run c
       set state = 'running', locked_by = ${workerId}, locked_at = now(),
           started_at = now(), attempts = c.attempts + 1
      from claimed
     where c.id = claimed.id
    returning c.id, c.source_id, c.kind, c.state, c.trigger, c.input, c.attempts
  `)
  return rows[0] ?? null
}

export type FinishCompileRunInput = {
  compileRunId: string
  resultAdapterId?: string | null
  model?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  costUsd?: number | null
  iterations?: number
}

export async function finishCompileRun(db: Db, input: FinishCompileRunInput): Promise<void> {
  await db.execute(sql`
    update forge.compile_run
       set state = 'succeeded', finished_at = now(), locked_by = null, locked_at = null,
           result_adapter_id = ${input.resultAdapterId ?? null}::uuid,
           model = ${input.model ?? null}, tokens_in = ${input.tokensIn ?? null},
           tokens_out = ${input.tokensOut ?? null}, cost_usd = ${input.costUsd ?? null},
           iterations = ${input.iterations ?? 0}
     where id = ${input.compileRunId}::uuid
  `)
}

export async function failCompileRun(
  db: Db,
  compileRunId: string,
  error: string,
  stats: Omit<FinishCompileRunInput, 'compileRunId' | 'resultAdapterId'> = {},
): Promise<void> {
  await db.execute(sql`
    update forge.compile_run
       set state = 'failed', finished_at = now(), locked_by = null, locked_at = null,
           error = ${error.slice(0, 8000)},
           model = ${stats.model ?? null}, tokens_in = ${stats.tokensIn ?? null},
           tokens_out = ${stats.tokensOut ?? null}, cost_usd = ${stats.costUsd ?? null},
           iterations = ${stats.iterations ?? 0}
     where id = ${compileRunId}::uuid
  `)
}

/** Every tool call the agent made. This is the debuggability of the agent loop. */
export async function logCompileStep(
  db: Db,
  compileRunId: string,
  n: number,
  tool: string,
  input: unknown,
  outputSummary: unknown,
): Promise<void> {
  await db.execute(sql`
    insert into forge.compile_step (compile_run_id, n, tool, input, output_summary)
    values (${compileRunId}::uuid, ${n}, ${tool},
            ${JSON.stringify(input ?? null)}::jsonb, ${JSON.stringify(outputSummary ?? null)}::jsonb)
  `)
}

/**
 * How many repairs have already failed for this source.
 *
 * Section 8: "After 3 failed repairs the source goes to `disabled` and a human is notified."
 */
export async function failedRepairCount(db: Db, sourceId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from forge.compile_run
     where source_id = ${sourceId}::uuid and kind = 'repair' and state = 'failed'
  `)
  return rows[0]?.n ?? 0
}
