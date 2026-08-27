/**
 * The adapter contract — master plan section 5.
 *
 * These types are the entire interface between the agent tier (which writes adapter
 * source) and the runtime tier (which executes it). Nothing else crosses that line.
 */

import type { parseHTML } from 'linkedom'

/** The document type `ExtractInput.doc()` hands back (linkedom, not jsdom, not a browser). */
export type ExtractDocument = ReturnType<typeof parseHTML>['document']

/** How the runtime obtains the bytes an adapter extracts from. */
export type FetchPlan = {
  tier: 'http' | 'browser'
  /** e.g. 'https://api.example.at/v2/item/{key}' — `{key}` is the job's external_key. */
  urlTemplate: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** browser tier only */
  waitFor?: string
}

/**
 * The single argument every adapter entry point receives.
 *
 * `json()` and `doc()` are lazy so an adapter reading a JSON endpoint never pays for
 * HTML parsing. That laziness is the main per-run cost lever (master plan section 5).
 */
export type ExtractInput = {
  url: string
  status: number
  headers: Record<string, string>
  body: string
  /** lazy JSON.parse of `body`, memoised */
  json(): unknown
  /** lazy linkedom parse of `body`, memoised */
  doc(): ExtractDocument
}

/** What the agent writes, and what is stored in `forge.adapter.code_ts`. */
export type Adapter = {
  extract(input: ExtractInput): unknown[]
  /** listing page -> item URLs */
  discover?(input: ExtractInput): string[]
}

/** The raw material a fixture holds: one frozen response. */
export type FixtureBody = {
  url: string
  status: number
  headers: Record<string, string>
  body: string
}
