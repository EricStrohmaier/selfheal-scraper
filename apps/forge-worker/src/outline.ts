/**
 * Turning a fetched page into something a model can reason about cheaply.
 *
 * Master plan section 9: `fetch_page` returns "a structured outline plus a truncated
 * body". The outline is the part that matters. A 400KB listing page is ~100K tokens and
 * mostly boilerplate; what the agent actually needs is which anchors exist and how many
 * of each, because that is what tells it where the repeating unit is.
 *
 * The census is ordered to match the section 9 data-source preference list, so the cheap
 * good answer is the first thing the agent reads.
 */

import { parseHTML } from 'linkedom'

export type PageOutline = {
  kind: 'json' | 'html'
  bytes: number
  /** JSON only: the shape, with arrays collapsed to one sample element */
  jsonShape?: unknown
  /** JSON only: paths that hold arrays of objects — candidate item collections */
  itemArrays?: Array<{ path: string; length: number; keys: string[] }>
  /** HTML only: embedded JSON worth reading before touching the DOM */
  embeddedJson?: Array<{ source: string; bytes: number; preview: string }>
  /** HTML only: repeated semantic attributes, most repeated first */
  anchors?: Array<{ selector: string; count: number; sample: string }>
  /** HTML only: element census, to spot the repeating unit */
  tags?: Array<{ tag: string; count: number }>
  title?: string
}

const MAX_SAMPLE = 200

function truncate(value: string, max = MAX_SAMPLE): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`
}

/** Collapse a parsed JSON value to its shape: arrays become one sample element. */
function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…'
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [shapeOf(value[0], depth + 1), `…${value.length} items`]
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shapeOf(child, depth + 1)
    }
    return out
  }
  if (typeof value === 'string') return truncate(value, 60)
  return value
}

/**
 * Find arrays of objects anywhere in the tree.
 *
 * This is the single most useful thing the outline reports for a JSON endpoint: the item
 * collection is almost always the longest array of objects, and its keys are the fields
 * available to map onto `output_schema`.
 */
function findItemArrays(
  value: unknown,
  path = '$',
  found: Array<{ path: string; length: number; keys: string[] }> = [],
  depth = 0,
): Array<{ path: string; length: number; keys: string[] }> {
  if (depth > 6) return found
  if (Array.isArray(value)) {
    const first = value[0]
    if (value.length > 0 && first !== null && typeof first === 'object' && !Array.isArray(first)) {
      found.push({ path, length: value.length, keys: Object.keys(first as object).slice(0, 40) })
    }
    if (value.length > 0) findItemArrays(value[0], `${path}[0]`, found, depth + 1)
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      findItemArrays(child, `${path}.${key}`, found, depth + 1)
    }
  }
  return found
}

/** Attributes worth anchoring on, in section 9's preference order. */
const ANCHOR_ATTRIBUTES = ['data-testid', 'itemprop', 'data-cy', 'data-qa', 'aria-label', 'role']

export function outlinePage(body: string, contentType = ''): PageOutline {
  const bytes = Buffer.byteLength(body, 'utf8')
  const trimmed = body.trimStart()

  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(body)
      const itemArrays = findItemArrays(parsed)
        .sort((a, b) => b.length - a.length)
        .slice(0, 8)
      return { kind: 'json', bytes, jsonShape: shapeOf(parsed), itemArrays }
    } catch {
      // Not JSON after all; fall through to the HTML path.
    }
  }

  const { document } = parseHTML(body)

  // Embedded JSON first — the second rung of the preference list, and often the whole
  // answer on a server-rendered React or Next.js page.
  const embeddedJson: PageOutline['embeddedJson'] = []
  for (const script of document.querySelectorAll('script')) {
    const type = script.getAttribute('type') ?? ''
    const id = script.getAttribute('id') ?? ''
    const text = script.textContent ?? ''
    const isLdJson = type.includes('ld+json')
    const isNextData = id === '__NEXT_DATA__'
    // The length floor only guards the heuristic branch. A script that identifies itself
    // by id or MIME type is worth reporting however short it happens to be.
    const isStateBlob = text.length >= 40 && /^\s*(window\.__|self\.__)/.test(text)
    if (isLdJson || isNextData || isStateBlob) {
      embeddedJson.push({
        source: isNextData ? '__NEXT_DATA__' : isLdJson ? 'application/ld+json' : 'inline state',
        bytes: text.length,
        preview: truncate(text, 400),
      })
    }
  }

  const anchors: Array<{ selector: string; count: number; sample: string }> = []
  for (const attribute of ANCHOR_ATTRIBUTES) {
    const counts = new Map<string, { count: number; sample: string }>()
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      const value = element.getAttribute(attribute) ?? ''
      // Values with a trailing id (`search-result-entry-header-12345`) are one anchor
      // per card. Grouping by the stem is what reveals the repeating unit.
      const stem = value.replace(/[-_]?\d{3,}$/, '')
      const key = stem.length > 0 ? stem : value
      const existing = counts.get(key)
      if (existing) existing.count++
      else counts.set(key, { count: 1, sample: truncate(element.textContent ?? '', 80) })
    }
    for (const [value, info] of counts) {
      if (info.count < 2) continue
      const selector =
        value === (value.replace(/[-_]?\d{3,}$/, '') ?? value) && info.count > 1
          ? `[${attribute}^="${value}"]`
          : `[${attribute}="${value}"]`
      anchors.push({ selector, count: info.count, sample: info.sample })
    }
  }
  anchors.sort((a, b) => b.count - a.count)

  const tagCounts = new Map<string, number>()
  for (const element of document.querySelectorAll('*')) {
    const tag = element.tagName?.toLowerCase()
    if (!tag) continue
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
  }
  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  return {
    kind: 'html',
    bytes,
    title: document.querySelector('title')?.textContent ?? undefined,
    embeddedJson: embeddedJson.slice(0, 5),
    anchors: anchors.slice(0, 30),
    tags,
  }
}

/** How much raw body accompanies the outline. Enough to see the shape, not the whole page. */
export const BODY_EXCERPT_BYTES = 4000

export function bodyExcerpt(body: string, limit = BODY_EXCERPT_BYTES): string {
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}\n…[truncated, ${body.length - limit} more characters]`
}
