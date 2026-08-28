/**
 * The http tier — undici. Master plan section 6: "undici for http".
 *
 * ~80ms and ~3MB against ~2-4s and ~300MB for the browser tier, which is why section 9
 * ranks finding a JSON endpoint as the highest-value thing the compile agent does.
 */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { request, Agent, interceptors } from 'undici'

import { classifyResponse } from './blocked.ts'
import type { FetchOutcome, FetchRequest } from './types.ts'

/**
 * A plausible desktop Chrome fingerprint.
 *
 * Not evasion — sites serve materially different markup to something that looks like a
 * script, so a default `undici` user-agent produces fixtures the compile agent then writes
 * selectors against that do not match what a browser actually receives. `fetch_hints`
 * overrides any of this per source.
 */
const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'upgrade-insecure-requests': '1',
}

// Two interceptors, both load-bearing.
//
// `decompress` is not optional. `undici.request` does NOT decompress response bodies on
// its own — unlike `fetch` — so sending `accept-encoding: gzip` and then reading the body
// as utf8 yields binary garbage. Most of the web is gzipped, so without this almost every
// real page arrives as noise: the adapter extracts nothing, the challenge detector calls
// it blocked, and nothing in the stack says "this is compressed".
//
// `redirect` because undici v7 moved redirects off the per-request options. Capped at 5:
// a longer chain is a loop or a consent wall.
const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connect: { timeout: 10_000 },
})
  .compose(interceptors.redirect({ maxRedirections: 5 }))

/**
 * Decode the body according to `content-encoding`.
 *
 * undici ships a `decompress` interceptor, but it is flagged experimental and prints a
 * warning on every request — on the hot path of a worker that runs unattended, that is
 * noise that would mask real warnings. This is the same job in fifteen lines against a
 * stable API.
 *
 * A body that claims an encoding and then fails to decode is returned as-is rather than
 * thrown away: a mislabelled response is still better evidence than nothing.
 */
function decode(raw: Buffer, contentEncoding: string | undefined): string {
  const encoding = (contentEncoding ?? '').trim().toLowerCase()
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return gunzipSync(raw).toString('utf8')
    if (encoding === 'deflate') return inflateSync(raw).toString('utf8')
    if (encoding === 'br') return brotliDecompressSync(raw).toString('utf8')
  } catch {
    // fall through
  }
  return raw.toString('utf8')
}

/**
 * Politeness: a minimum gap between requests to the same host.
 *
 * Nothing else in the system paces itself — the queue claims jobs as fast as it can, and
 * a source with fifty item URLs would otherwise hit one host fifty times in a second.
 * That is how a working scraper turns into a blocked one. Defaults to 1s; robots.txt
 * Crawl-delay values (Hacker News asks for 30s, bitcoinerjobs for 1s) go in
 * `fetch_hints.minIntervalMs` per source.
 */
const lastRequestAt = new Map<string, number>()

async function politeDelay(url: string, minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return
  let host: string
  try {
    host = new URL(url).host
  } catch {
    return
  }
  const previous = lastRequestAt.get(host)
  const now = Date.now()
  if (previous !== undefined) {
    const wait = previous + minIntervalMs - now
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  }
  lastRequestAt.set(host, Date.now())
}

export const DEFAULT_MIN_INTERVAL_MS = 1000

export const MAX_BODY_BYTES = 12 * 1024 * 1024

export async function httpFetch(input: FetchRequest): Promise<FetchOutcome> {
  const started = Date.now()
  const headers = { ...DEFAULT_HEADERS, ...(input.headers ?? {}) }
  const timeoutMs = input.timeoutMs ?? 20_000

  await politeDelay(input.url, input.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS)

  try {
    const response = await request(input.url, {
      method: input.method ?? 'GET',
      headers,
      body: input.body ?? null,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      dispatcher: agent,
      signal: input.signal ?? null,
    })

    // Cap the read rather than the response: a site that streams forever should not be
    // able to exhaust the worker's memory before the body timeout fires.
    let bytes = 0
    const chunks: Buffer[] = []
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) {
        response.body.destroy()
        return {
          ok: false,
          outcome: 'fetch_error',
          tier: 'http',
          status: response.statusCode,
          fetchMs: Date.now() - started,
          bytes,
          error: `response exceeded ${MAX_BODY_BYTES} bytes`,
        }
      }
      chunks.push(buffer)
    }

    const responseHeaders = normalizeHeaders(response.headers)
    const body = decode(Buffer.concat(chunks), responseHeaders['content-encoding'])
    const fetchMs = Date.now() - started

    if (response.statusCode >= 500) {
      return {
        ok: false,
        outcome: 'fetch_error',
        tier: 'http',
        status: response.statusCode,
        fetchMs,
        bytes,
        error: `HTTP ${response.statusCode}`,
      }
    }

    const verdict = classifyResponse({
      status: response.statusCode,
      body,
      contentType: responseHeaders['content-type'],
    })
    if (verdict.blocked) {
      return {
        ok: false,
        outcome: 'blocked',
        tier: 'http',
        status: response.statusCode,
        fetchMs,
        bytes,
        error: verdict.reason ?? 'blocked',
        body,
        headers: responseHeaders,
      }
    }

    if (response.statusCode >= 400) {
      return {
        ok: false,
        outcome: 'fetch_error',
        tier: 'http',
        status: response.statusCode,
        fetchMs,
        bytes,
        error: `HTTP ${response.statusCode}`,
      }
    }

    return {
      ok: true,
      outcome: 'ok',
      tier: 'http',
      status: response.statusCode,
      fetchMs,
      bytes,
      body,
      headers: responseHeaders,
    }
  } catch (err) {
    return {
      ok: false,
      outcome: 'fetch_error',
      tier: 'http',
      status: null,
      fetchMs: Date.now() - started,
      bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}
