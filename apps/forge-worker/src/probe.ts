/**
 * `probe_network` — load a page in a browser and report what it actually asked for.
 *
 * Master plan section 9, objective 2: "Call `probe_network` before writing any DOM
 * selector. A browser run costs roughly 2-4 seconds and 300MB. A JSON endpoint costs 80ms
 * and 3MB. Finding the endpoint is the single highest-value thing the agent does."
 *
 * This is the only tool that justifies its own cost by making every subsequent run cheap.
 * A client-rendered page has no data in its HTML at all, so without this the agent's only
 * options are the browser tier forever, or guessing an API URL.
 *
 * Responses are reported by shape, never in full. A search endpoint returns 30KB of JSON;
 * what the agent needs is the URL, the status, and which arrays of objects it contains.
 */

import { chromiumExecutablePath, proxyConfig } from '@forge/fetch'

import { outlinePage } from './outline.ts'
import type { NetworkProbeResult } from './tools.ts'

type Route = { url: string; method: string; status: number; contentType: string; bytes: number }

const INTERESTING = /json|javascript/i

/** Assets can outnumber data requests fifty to one and none of them is ever the answer. */
const BORING = /\.(png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot|css|ico|mp4|webm)(\?|$)/i

export type ProbeOptions = {
  timeoutMs?: number
  /** cap on responses inspected, so a chatty page cannot blow the context window */
  maxRequests?: number
}

export async function probeNetwork(url: string, options: ProbeOptions = {}): Promise<NetworkProbeResult> {
  const timeoutMs = options.timeoutMs ?? 45_000
  const maxRequests = options.maxRequests ?? 40

  let playwright: { chromium: { launch(opts: unknown): Promise<BrowserLike> } }
  try {
    // Resolved at runtime, not compile time: playwright is an optional dependency, and
    // the http tier alone is a complete system. A string variable keeps the module
    // specifier out of the type checker's reach so this file builds without it installed.
    const specifier = 'playwright'
    playwright = (await import(specifier)) as never
  } catch {
    return {
      requests: [],
      note: 'No browser is installed in this environment, so the network could not be probed. Fall back to fetch_page and read the embedded JSON reported in its outline before writing DOM selectors.',
    }
  }

  const executablePath = chromiumExecutablePath()
  const proxy = proxyConfig()
  const browser = await playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })

  const captured: Array<Route & { body: string | null }> = []

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()

    page.on('response', (response: ResponseLike) => {
      void (async () => {
        try {
          const responseUrl = response.url()
          if (captured.length >= maxRequests) return
          if (BORING.test(responseUrl)) return

          const headers = response.headers()
          const contentType = headers['content-type'] ?? ''
          if (!INTERESTING.test(contentType)) return
          // The document itself is what fetch_page already returns.
          if (response.request().resourceType() === 'document') return

          const body = await response.text().catch(() => null)
          captured.push({
            url: responseUrl,
            method: response.request().method(),
            status: response.status(),
            contentType,
            bytes: body ? Buffer.byteLength(body, 'utf8') : 0,
            body: contentType.includes('json') ? body : null,
          })
        } catch {
          // A response body can be gone by the time we ask for it (redirects, aborted
          // requests). Losing one is not worth failing the probe over.
        }
      })()
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    // Lazy-loaded pages fire their data requests on scroll, not on load.
    await page
      .evaluate(() => {
        window.scrollBy(0, 4000)
      })
      .catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  } catch (err) {
    return {
      requests: [],
      note: `The page could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    await browser.close().catch(() => {})
  }

  const requests = captured
    .map((route) => {
      const entry: NetworkProbeResult['requests'][number] = {
        url: route.url,
        method: route.method,
        status: route.status,
        contentType: route.contentType,
        bytes: route.bytes,
      }
      if (route.body) {
        const outline = outlinePage(route.body, route.contentType)
        // Only the item arrays: that is what says "this endpoint carries the listings",
        // and it is a hundredth the size of the response.
        if (outline.itemArrays && outline.itemArrays.length > 0) entry.shape = outline.itemArrays
        else entry.shape = outline.jsonShape
      }
      return entry
    })
    // Biggest JSON responses first — the data endpoint is almost never the small one.
    .sort((a, b) => b.bytes - a.bytes)

  return {
    requests,
    note:
      requests.length === 0
        ? 'The page made no JSON requests. It is probably server-rendered — check fetch_page\'s outline for embedded JSON before falling back to DOM selectors.'
        : `${requests.length} JSON/script responses, largest first. An endpoint whose shape shows an array of objects is almost certainly the item collection.`,
  }
}

// Minimal structural types; playwright is an optional dependency and importing its types
// unconditionally would make it a required one.
type BrowserLike = {
  newContext(options: unknown): Promise<{ newPage(): Promise<PageLike> }>
  close(): Promise<void>
}
type PageLike = {
  on(event: 'response', handler: (response: ResponseLike) => void): void
  goto(url: string, options: unknown): Promise<unknown>
  waitForLoadState(state: string, options: unknown): Promise<void>
  evaluate(fn: () => void): Promise<void>
}
type ResponseLike = {
  url(): string
  status(): number
  headers(): Record<string, string>
  text(): Promise<string>
  request(): { method(): string; resourceType(): string }
}

declare const window: { scrollBy(x: number, y: number): void }
