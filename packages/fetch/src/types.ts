import type { RunOutcome } from '@forge/core'

export type Tier = 'http' | 'browser'

export type FetchRequest = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** minimum gap between requests to the same host; see politeDelay */
  minIntervalMs?: number
  signal?: AbortSignal
  /** browser tier only — a selector to wait for before reading the DOM */
  waitFor?: string
}

export type FetchOutcome = {
  ok: boolean
  /** maps straight onto `runtime.run.outcome` */
  outcome: Extract<RunOutcome, 'ok' | 'fetch_error' | 'blocked' | 'timeout'>
  tier: Tier
  status: number | null
  fetchMs: number
  bytes: number
  body?: string
  headers?: Record<string, string>
  error?: string
}
