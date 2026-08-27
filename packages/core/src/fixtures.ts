/**
 * Reading a committed fixture corpus off disk.
 *
 * In production a fixture is a row in `forge.fixture` with a gzipped `body bytea`. On disk
 * the same thing is a `manifest.json` next to one gzipped body per fixture. The split is on
 * purpose: `expected` is golden output that a human confirms, so it has to be readable in a
 * diff, while the body is a frozen page nobody reviews by eye.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import type { GateFixture } from './gate.ts'

export type FixtureManifestEntry = {
  name: string
  url: string
  tier: 'http' | 'browser'
  statusCode: number
  headers: Record<string, string>
  /** gzipped response body, relative to the manifest */
  bodyFile: string
  /** golden output, or null when no human has confirmed one */
  expected?: unknown[] | null
}

export function loadFixtures(dir: string): GateFixture[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as FixtureManifestEntry[]
  return manifest.map((entry) => ({
    id: entry.name,
    url: entry.url,
    status: entry.statusCode,
    headers: entry.headers,
    body: gunzipSync(readFileSync(join(dir, entry.bodyFile))).toString('utf8'),
    expected: entry.expected ?? null,
  }))
}
