import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { classifyResponse } from '../src/blocked.ts'

const realPage = `<!doctype html><html><head><title>Listings</title>
<meta property="og:title" content="Listings"><script type="application/ld+json">{"@type":"ItemList"}</script>
</head><body><main>${'<div class="row">a listing</div>'.repeat(60)}</main></body></html>`

describe('blocked: real responses pass through', () => {
  test('a full HTML page is not blocked', () => {
    assert.deepEqual(classifyResponse({ status: 200, body: realPage, contentType: 'text/html' }), {
      blocked: false,
      reason: null,
    })
  })

  test('a small JSON response is not blocked, however short', () => {
    const verdict = classifyResponse({
      status: 200,
      body: '{"hits":[]}',
      contentType: 'application/json',
    })
    assert.equal(verdict.blocked, false)
  })

  test('JSON served without a content-type is still recognised', () => {
    assert.equal(classifyResponse({ status: 200, body: '{"a":1}' }).blocked, false)
  })

  test('a large page with no structured markers is given the benefit of the doubt', () => {
    const plain = `<html><body>${'x'.repeat(20_000)}</body></html>`
    assert.equal(classifyResponse({ status: 200, body: plain, contentType: 'text/html' }).blocked, false)
  })
})

describe('blocked: challenges are caught', () => {
  const challenges: Array<[label: string, body: string]> = [
    ['Cloudflare interstitial', `<html><head><title>Just a moment...</title></head><body>${'.'.repeat(2000)}</body></html>`],
    ['Cloudflare challenge script', `<html><body><script>window._cf_chl_opt={};</script>${'.'.repeat(2000)}</body></html>`],
    ['security verification', `<html><body>Performing security verification${'.'.repeat(2000)}</body></html>`],
    ['human verification', `<html><body>Verifying you are human${'.'.repeat(2000)}</body></html>`],
    ['browser check', `<html><body>Checking your browser before accessing${'.'.repeat(2000)}</body></html>`],
    ['captcha widget', `<html><body><div class="g-recaptcha"></div>${'.'.repeat(2000)}</body></html>`],
    ['PerimeterX', `<html><body><div id="px-captcha"></div>${'.'.repeat(2000)}</body></html>`],
    ['access denied', `<html><head><title>Access Denied</title></head><body>${'.'.repeat(2000)}</body></html>`],
  ]

  for (const [label, body] of challenges) {
    test(`${label} is blocked even at HTTP 200`, () => {
      const verdict = classifyResponse({ status: 200, body, contentType: 'text/html' })
      assert.equal(verdict.blocked, true, label)
      assert.equal(typeof verdict.reason, 'string')
    })
  }

  test('a refusal status is blocked regardless of body', () => {
    for (const status of [401, 403, 407, 429, 451]) {
      assert.equal(classifyResponse({ status, body: realPage }).blocked, true, `HTTP ${status}`)
    }
  })

  test('a near-empty body is blocked', () => {
    assert.equal(classifyResponse({ status: 200, body: '<html></html>' }).blocked, true)
  })

  test('a small structureless page is blocked', () => {
    const stub = `<html><body>${'.'.repeat(2000)}</body></html>`
    assert.equal(classifyResponse({ status: 200, body: stub, contentType: 'text/html' }).blocked, true)
  })
})

describe('blocked: a 404 is missing, not refused', () => {
  /**
   * The distinction matters downstream: `blocked` is dropped from the health window,
   * `fetch_error` is not. Calling a 404 blocked would hide a genuinely dead URL.
   */
  test('404 is not classified as blocked', () => {
    assert.equal(classifyResponse({ status: 404, body: realPage }).blocked, false)
  })
})
