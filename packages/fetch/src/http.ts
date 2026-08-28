/**
 * The http tier — undici. Master plan section 6: "undici for http".
 *
 * ~80ms and ~3MB against ~2-4s and ~300MB for the browser tier, which is why section 9
 * ranks finding a JSON endpoint as the highest-value thing the compile agent does.
 */

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

// undici v7 handles redirects with a dispatcher interceptor rather than a per-request
// option. Capped at 5: a redirect chain longer than that is a loop or a consent wall.
const agent = new Agent({
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connect: { timeout: 10_000 },
}).compose(interceptors.redirect({ maxRedirections: 5 }))

export const MAX_BODY_BYTES = 12 * 1024 * 1024

export async function httpFetch(input: FetchRequest): Promise<FetchOutcome> {
  const started = Date.now()
  const headers = { ...DEFAULT_HEADERS, ...(input.headers ?? {}) }
  const timeoutMs = input.timeoutMs ?? 20_000

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

    const body = Buffer.concat(chunks).toString('utf8')
    const responseHeaders = normalizeHeaders(response.headers)
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
