/**
 * The forge worker loop — claim a compile_run, run the agent, record the result.
 *
 * Expensive and rare, against the runtime worker's cheap and constant. The two never
 * share a process, and this is the only one that may reach a model.
 */

import {
  claimCompileRun,
  failCompileRun,
  finishCompileRun,
  getSource,
  promoteToActive,
  setSourceState,
  type Db,
} from '@forge/db'

import { runAgent, type AgentOutcome } from './agent.ts'
import type { ModelClient } from './model.ts'
import type { NetworkProbeResult } from './tools.ts'
import type { executeFetchPlan } from '@forge/fetch'

export type ForgeWorkerOptions = {
  db: Db
  model: ModelClient
  workerId?: string
  fetcher?: typeof executeFetchPlan
  probe?: (url: string) => Promise<NetworkProbeResult>
  signal?: AbortSignal
  idleMs?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export type CompileReport = {
  compileRunId: string
  sourceKey: string
  kind: 'compile' | 'repair'
  outcome: AgentOutcome
}

/** Claim and run one compile_run. Returns null when the queue is empty. */
export async function step(options: ForgeWorkerOptions): Promise<CompileReport | null> {
  const { db, model } = options
  const log = options.log ?? (() => {})
  const workerId = options.workerId ?? `forge-${process.pid}`

  const claimed = await claimCompileRun(db, workerId)
  if (!claimed) return null

  const source = await getSource(db, claimed.source_id)
  if (!source) {
    await failCompileRun(db, claimed.id, 'the source no longer exists')
    return null
  }

  log('compile started', { source: source.key, kind: claimed.kind, run: claimed.id })

  // `compiling` and `repairing` are visible states, so a human looking at forge.source
  // can see that work is in flight rather than inferring it from the compile_run table.
  await setSourceState(db, source.id, claimed.kind === 'repair' ? 'repairing' : 'compiling')

  let outcome: AgentOutcome
  try {
    outcome = await runAgent({
      db,
      model,
      source,
      compileRunId: claimed.id,
      kind: claimed.kind,
      trigger: claimed.trigger,
      failingFields: Array.isArray(claimed.input['failingFields'])
        ? (claimed.input['failingFields'] as string[])
        : [],
      ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      ...(options.probe ? { probe: options.probe } : {}),
      log,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await failCompileRun(db, claimed.id, message)
    // Back to degraded, not active: the adapter is still broken, and leaving the source
    // in `repairing` would stop the health monitor ever queueing another attempt.
    await setSourceState(db, source.id, claimed.kind === 'repair' ? 'degraded' : 'new')
    log('compile crashed', { source: source.key, error: message })
    return {
      compileRunId: claimed.id,
      sourceKey: source.key,
      kind: claimed.kind,
      outcome: {
        succeeded: false,
        adapterId: null,
        iterations: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: null,
        model: model.model,
        message,
      },
    }
  }

  const stats = {
    model: outcome.model,
    tokensIn: outcome.tokensIn,
    tokensOut: outcome.tokensOut,
    costUsd: outcome.costUsd,
    iterations: outcome.iterations,
  }

  if (outcome.succeeded && outcome.adapterId) {
    await finishCompileRun(db, {
      compileRunId: claimed.id,
      resultAdapterId: outcome.adapterId,
      ...stats,
    })

    if (claimed.kind === 'repair') {
      // The repair landed as a canary. It stays there until 20 canary runs say it is at
      // least as good as the incumbent (section 6), so the source goes back to `active`
      // to resume scheduling — the canary router is what routes 10% of that traffic to it.
      await setSourceState(db, source.id, 'active')
    } else {
      // A fresh compile has no incumbent to prove itself against, so the draft becomes
      // active directly. It already passed the gate, which is the bar for leaving draft.
      await promoteToActive(db, outcome.adapterId)
      await setSourceState(db, source.id, 'active')
    }
    log('compile succeeded', {
      source: source.key,
      adapter: outcome.adapterId,
      iterations: outcome.iterations,
      cost: outcome.costUsd,
    })
  } else {
    await failCompileRun(db, claimed.id, outcome.message, stats)
    await setSourceState(db, source.id, claimed.kind === 'repair' ? 'degraded' : 'new')
    log('compile failed', {
      source: source.key,
      reason: outcome.message,
      iterations: outcome.iterations,
      cost: outcome.costUsd,
    })
  }

  return { compileRunId: claimed.id, sourceKey: source.key, kind: claimed.kind, outcome }
}

export async function runOnce(options: ForgeWorkerOptions, maxRuns = 20): Promise<CompileReport[]> {
  const reports: CompileReport[] = []
  while (reports.length < maxRuns) {
    if (options.signal?.aborted) break
    const report = await step(options)
    if (!report) break
    reports.push(report)
  }
  return reports
}

export async function runForever(options: ForgeWorkerOptions): Promise<void> {
  const idleMs = options.idleMs ?? 10_000
  while (!options.signal?.aborted) {
    const report = await step(options)
    if (report) continue
    await sleep(idleMs, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
