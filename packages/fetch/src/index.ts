/**
 * Executing a `FetchPlan`, with escalation.
 *
 * The master plan treats `fetch_plan.tier` as a fixed choice made at compile time. In
 * practice a site that served JSON to plain HTTP last week can start challenging it, and
 * the difference between "this adapter broke" and "this fetch got refused" is the
 * difference between a useful repair and a wasted one.
 *
 * So `tier` stays the plan — what the compile agent decided is cheapest and sufficient —
 * and escalation is what happens when the plan stops working. The escalation is recorded
 * (`run.tier_used`, `run.escalated`) rather than silent, because a source that escalates
 * every run has a compile problem, not a fetch problem, and the record is how you see it.
 */

import type { FetchPlan } from '@forge/core'

import { browserFetch, browserAvailable, closeBrowser, type BrowserOptions } from './browser.ts'
import { httpFetch } from './http.ts'
import type { FetchOutcome, FetchRequest, Tier } from './types.ts'

export { classifyResponse, type BlockedVerdict } from './blocked.ts'
export { httpFetch, MAX_BODY_BYTES } from './http.ts'
export { browserFetch, browserAvailable, closeBrowser, type BrowserOptions } from './browser.ts'
export type { FetchOutcome, FetchRequest, Tier } from './types.ts'

/** `source.fetch_hints`, passed through unchanged as the plan requires. */
export type FetchHints = {
  headers?: Record<string, string>
  userAgent?: string
  locale?: string
  consentSelectors?: string[]
  autoScroll?: boolean
  timeoutMs?: number
  /** set false to pin a source to its planned tier and never climb */
  allowEscalation?: boolean
}

export type ExecuteOptions = {
  hints?: FetchHints
  signal?: AbortSignal
  /** overrides the plan; used by the compile agent's fetch_page tool */
  tier?: Tier
}

/** `urlTemplate` with `{key}` replaced by the job's `external_key`. */
export function resolveUrl(plan: FetchPlan, externalKey: string): string {
  return plan.urlTemplate.replaceAll('{key}', encodeURIComponent(externalKey))
}

export type ExecuteResult = FetchOutcome & {
  /** true when the planned tier soft-failed and the browser tier served the bytes */
  escalated: boolean
}

export async function executeFetchPlan(
  plan: FetchPlan,
  url: string,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const hints = options.hints ?? {}
  const tier = options.tier ?? plan.tier

  const request: FetchRequest = {
    url,
    method: plan.method ?? 'GET',
    headers: { ...(plan.headers ?? {}), ...(hints.headers ?? {}) },
    body: plan.body,
    timeoutMs: hints.timeoutMs,
    signal: options.signal,
    waitFor: plan.waitFor,
  }

  const browserOptions: BrowserOptions = {
    userAgent: hints.userAgent,
    locale: hints.locale,
    consentSelectors: hints.consentSelectors,
    autoScroll: hints.autoScroll,
  }

  if (tier === 'browser') {
    const result = await browserFetch(request, browserOptions)
    return { ...result, escalated: false }
  }

  const first = await httpFetch(request)
  if (first.ok) return { ...first, escalated: false }

  // Escalate only on `blocked`. A 404 or a connection reset will not be any different
  // through a browser, and paying 300MB to find that out on every retry is how a fetch
  // budget disappears.
  const shouldEscalate =
    first.outcome === 'blocked' && hints.allowEscalation !== false && browserAvailable()
  if (!shouldEscalate) return { ...first, escalated: false }

  const second = await browserFetch(request, browserOptions)
  return {
    ...second,
    escalated: true,
    // Keep the reason the cheap tier was refused; it is the more diagnostic of the two.
    error: second.ok ? undefined : `http tier ${first.error}; browser tier ${second.error}`,
  }
}
