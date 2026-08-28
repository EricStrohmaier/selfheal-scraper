/**
 * Telling "blocked" apart from "broken".
 *
 * This is the single most valuable thing carried over from a working production scraper,
 * and the master plan does not have it.
 *
 * A bot challenge answers 200 with a real HTML body. An adapter run against it extracts
 * nothing, which the plan records as `empty`, which after three runs trips degradation
 * (section 8), which queues a repair (section 8 step 3), which spends a model call trying
 * to fix an adapter that was never wrong — and the repair then fails against fixtures that
 * are themselves challenge pages. The whole self-healing loop turns into an expensive
 * no-op, and the source ends up `disabled` after three strikes.
 *
 * So a challenge has to be detected at the fetch tier and recorded as its own outcome,
 * and `assessHealth` has to drop those runs from the window.
 */

export type BlockedVerdict = {
  blocked: boolean
  /** why, for `runtime.run.error` — null when not blocked */
  reason: string | null
}

/** Bodies below this are never a real page; they are error stubs or empty shells. */
const MIN_BODY_BYTES = 500

const CHALLENGE_MARKERS: Array<[marker: RegExp, reason: string]> = [
  [/<title[^>]*>\s*Just a moment/i, 'Cloudflare "Just a moment" interstitial'],
  [/cf-browser-verification|cf_chl_opt|__cf_chl_/i, 'Cloudflare challenge script'],
  [/Performing security verification/i, 'security verification interstitial'],
  [/Verifying (?:you are human|Connection)/i, 'human verification interstitial'],
  [/checking your browser/i, 'browser check interstitial'],
  [/<title[^>]*>\s*Access Denied/i, 'access denied page'],
  [/<title[^>]*>\s*Attention Required/i, 'Cloudflare "Attention Required"'],
  [/id="px-captcha"|_pxhd|PerimeterX/i, 'PerimeterX challenge'],
  [/<title[^>]*>\s*(?:Pardon|Sorry), (?:Our|our) (?:Interruption|apologies)/i, 'Distil/Imperva interstitial'],
  [/g-recaptcha|hcaptcha\.com\/1\/api\.js/i, 'captcha widget'],
]

/**
 * Positive evidence that a body is a real page rather than an interstitial.
 *
 * A challenge page is small and structureless. A real page carries structured data or
 * document landmarks. Present is strong evidence; absent is only weak evidence, which is
 * why absence alone never marks something blocked below a size floor.
 */
const REAL_PAGE_MARKERS = [
  'application/ld+json',
  '__NEXT_DATA__',
  '__NUXT__',
  '<article',
  '<main',
  'og:title',
]

/** Statuses that mean "we were refused", as opposed to "the page is missing". */
const BLOCKING_STATUSES = new Set([401, 403, 407, 429, 451])

export type ClassifyInput = {
  status: number
  body: string
  contentType?: string | undefined
}

export function classifyResponse(input: ClassifyInput): BlockedVerdict {
  const notBlocked: BlockedVerdict = { blocked: false, reason: null }

  if (BLOCKING_STATUSES.has(input.status)) {
    return { blocked: true, reason: `HTTP ${input.status}` }
  }

  // A JSON endpoint that returned parseable JSON is not an interstitial. Challenges are
  // served as HTML, so the whole heuristic below only applies to HTML-ish bodies.
  const contentType = input.contentType ?? ''
  if (contentType.includes('json')) {
    return notBlocked
  }
  if (!contentType || contentType.includes('html') || contentType.includes('text')) {
    if (looksLikeJson(input.body)) return notBlocked
  }

  for (const [marker, reason] of CHALLENGE_MARKERS) {
    if (marker.test(input.body)) return { blocked: true, reason }
  }

  if (input.body.length < MIN_BODY_BYTES) {
    return { blocked: true, reason: `body is only ${input.body.length} bytes` }
  }

  // Structured markers settle it. Without any, a small body is suspicious; a large one is
  // almost certainly a real page that simply does not use them.
  const hasStructure = REAL_PAGE_MARKERS.some((marker) => input.body.includes(marker))
  if (!hasStructure && input.body.length < 10_000) {
    return { blocked: true, reason: 'no document structure and an implausibly small body' }
  }

  return notBlocked
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}
