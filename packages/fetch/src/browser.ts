/**
 * The browser tier — playwright. Master plan section 6: "playwright for browser".
 *
 * Expensive on purpose: roughly 2-4 seconds and 300MB against 80ms and 3MB for the http
 * tier. Everything here exists to make that cost buy something the http tier cannot get.
 *
 * The browser is a lazily-launched singleton that relaunches on disconnect. Launching per
 * job would dominate the runtime; keeping a dead handle would fail every job after the
 * first crash.
 */

import { classifyResponse } from './blocked.ts'
import type { FetchOutcome, FetchRequest } from './types.ts'

type Browser = {
  isConnected(): boolean
  close(): Promise<void>
  newContext(options: unknown): Promise<BrowserContext>
  on(event: 'disconnected', handler: () => void): void
}
type BrowserContext = { newPage(): Promise<Page>; close(): Promise<void> }
type Page = {
  goto(url: string, options: unknown): Promise<Response | null>
  waitForSelector(selector: string, options: unknown): Promise<unknown>
  waitForLoadState(state: string, options: unknown): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  content(): Promise<string>
  click(selector: string, options: unknown): Promise<void>
  close(): Promise<void>
}
type Response = { status(): number; headers(): Record<string, string> }

// `page.evaluate` serialises its callback and runs it in the page, so these are the
// browser's globals, not Node's. Declared locally rather than pulling lib.dom into the
// whole workspace for one function.
declare const document: { body: { scrollHeight: number } }
declare const window: { scrollBy(x: number, y: number): void }

let browser: Browser | null = null
let launching: Promise<Browser> | null = null

/**
 * Cookie walls hide the content behind them, so a fixture captured without dismissing one
 * teaches the compile agent to write selectors against a consent dialog.
 *
 * These are the common consent-management platforms. Per-source overrides belong in
 * `source.fetch_hints.consentSelectors`.
 */
const CONSENT_SELECTORS = [
  '#didomi-notice-agree-button',
  '#onetrust-accept-btn-handler',
  'button[mode="primary"][aria-label*="Accept"]',
  '[data-testid="accept-all-cookies"]',
  '.fc-cta-consent',
  'button#L2AGLb',
]

export type BrowserOptions = {
  userAgent?: string
  locale?: string
  consentSelectors?: string[]
  /** lazy-load pages need a scroll to render everything; costs a second or two */
  autoScroll?: boolean
}

async function launch(): Promise<Browser> {
  if (browser?.isConnected()) return browser
  if (launching) return launching

  launching = (async () => {
    const playwright = (await import('playwright')) as unknown as {
      chromium: { launch(options: unknown): Promise<Browser> }
    }
    const launched = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      // The worker installs its own signal handlers; letting playwright tear the browser
      // down first turns a graceful shutdown into a pile of failed jobs.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    })
    launched.on('disconnected', () => {
      browser = null
    })
    return launched
  })()

  try {
    browser = await launching
    return browser
  } finally {
    launching = null
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {})
    browser = null
  }
}

export function browserAvailable(): boolean {
  try {
    // Resolution only; the module is an optional dependency because the http tier alone
    // is a complete, useful system and playwright is a 300MB install.
    import.meta.resolve('playwright')
    return true
  } catch {
    return false
  }
}

export async function browserFetch(
  input: FetchRequest,
  options: BrowserOptions = {},
): Promise<FetchOutcome> {
  const started = Date.now()
  const timeoutMs = input.timeoutMs ?? 45_000
  let context: BrowserContext | null = null

  try {
    const instance = await launch()
    context = await instance.newContext({
      userAgent:
        options.userAgent ??
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: options.locale ?? 'en-US',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: input.headers ?? {},
      ignoreHTTPSErrors: false,
    })
    const page = await context.newPage()

    const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})

    await dismissConsent(page, options.consentSelectors ?? CONSENT_SELECTORS)

    if (input.waitFor) {
      await page.waitForSelector(input.waitFor, { timeout: 10_000 }).catch(() => {})
    }
    if (options.autoScroll !== false) {
      await autoScroll(page)
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    }

    const body = await page.content()
    const status = response?.status() ?? 200
    const headers = response?.headers() ?? {}
    const fetchMs = Date.now() - started
    const bytes = Buffer.byteLength(body, 'utf8')

    const verdict = classifyResponse({ status, body, contentType: headers['content-type'] })
    if (verdict.blocked) {
      return {
        ok: false,
        outcome: 'blocked',
        tier: 'browser',
        status,
        fetchMs,
        bytes,
        error: verdict.reason ?? 'blocked',
        body,
        headers,
      }
    }

    return { ok: true, outcome: 'ok', tier: 'browser', status, fetchMs, bytes, body, headers }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      outcome: /timeout/i.test(message) ? 'timeout' : 'fetch_error',
      tier: 'browser',
      status: null,
      fetchMs: Date.now() - started,
      bytes: 0,
      error: message,
    }
  } finally {
    await context?.close().catch(() => {})
  }
}

async function dismissConsent(page: Page, selectors: string[]): Promise<void> {
  for (const selector of selectors) {
    try {
      await page.click(selector, { timeout: 1500 })
      return
    } catch {
      // Not this one. A missing consent dialog is the common case, not an error.
    }
  }
}

/**
 * Scroll to the bottom in steps so lazy-loaded content renders.
 *
 * Bounded twice — by document height and by an absolute cap — because an infinite-scroll
 * feed will otherwise keep growing for as long as you keep scrolling.
 */
async function autoScroll(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      return new Promise<void>((resolve) => {
        let total = 0
        const step = 400
        const timer = setInterval(() => {
          const height = document.body.scrollHeight
          window.scrollBy(0, step)
          total += step
          if (total >= height || total >= 12_000) {
            clearInterval(timer)
            resolve()
          }
        }, 100)
      })
    })
    .catch(() => {})
}
