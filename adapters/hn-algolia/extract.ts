/**
 * hn-algolia/story-search — `forge.adapter.code_ts`
 *
 * Hand-written for M1. Everything after M4 is written by the compile agent; this one exists
 * to prove the harness works and to be the worked example the agent's prompt points at.
 *
 * Data source: internal JSON endpoint. Top of the section 9 preference list. The Hacker News
 * search UI at hn.algolia.com renders entirely from `GET /api/v1/search`, which returns the
 * whole result set as JSON, so there is no reason to touch the DOM or the browser tier here.
 * A `probe_network` call on the search page is what surfaces it.
 *
 * Field anchors, for whoever repairs this:
 *   id            `objectID` — the HN story id, also what item URLs are keyed by.
 *   title         `title`. Null on comment-type hits; those are dropped, not emitted blank.
 *   url           `url`. Legitimately null for Ask HN / text posts, hence nullable in the
 *                 schema rather than defaulted to the item URL.
 *   author        `author`.
 *   points        `points`. Integer, and present on every story hit seen so far.
 *   commentCount  `num_comments`. Null on very fresh stories, so it is coerced to 0.
 *   postedAt      `created_at`, already ISO 8601 from the API.
 *   itemUrl       derived from `objectID`; the API does not return it.
 *
 * `_highlightResult` is deliberately ignored — it carries `<em>` markup and exists for the
 * search UI, not for consumers.
 */

import type { ExtractInput } from '@forge/core'

type AlgoliaHit = {
  objectID?: unknown
  title?: unknown
  url?: unknown
  author?: unknown
  points?: unknown
  num_comments?: unknown
  created_at?: unknown
}

type AlgoliaResponse = {
  hits?: unknown
}

const ITEM_URL_PREFIX = 'https://news.ycombinator.com/item?id='

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}

function hits(input: ExtractInput): AlgoliaHit[] {
  const payload = input.json() as AlgoliaResponse | null
  const raw = payload === null ? null : payload.hits
  return Array.isArray(raw) ? (raw as AlgoliaHit[]) : []
}

export function extract(input: ExtractInput): unknown[] {
  const items: unknown[] = []

  for (const hit of hits(input)) {
    const id = text(hit.objectID)
    const title = text(hit.title)
    // A hit with no id cannot be keyed, and one with no title is a comment rather than a
    // story. Both are dropped so the caller never has to reason about half-items.
    if (id === null || title === null) continue

    items.push({
      id,
      title,
      url: text(hit.url),
      author: text(hit.author),
      points: count(hit.points),
      commentCount: count(hit.num_comments),
      postedAt: text(hit.created_at),
      itemUrl: ITEM_URL_PREFIX + id,
    })
  }

  return items
}

export function discover(input: ExtractInput): string[] {
  const urls: string[] = []
  for (const hit of hits(input)) {
    const id = text(hit.objectID)
    if (id !== null) urls.push(ITEM_URL_PREFIX + id)
  }
  return urls
}
