/**
 * Generates the synthetic fixture corpus.
 *
 * These are NOT captures of willhaben. See README.md — the site's robots.txt forbids
 * automated access, so the fixtures are built from the DOM contract the selectors encode
 * rather than fetched. Replace them with real captures before trusting this adapter
 * against production; the manifest format is the same either way.
 *
 * Run: node adapters/willhaben/build-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** One result card, in the structure the real selectors target. */
function card(listing) {
  const id = listing.id
  const teaser = [
    listing.sizeM2 === null ? null : `<span>${listing.sizeM2} m²</span>`,
    listing.rooms === null ? null : `<span>${listing.rooms} Zimmer</span>`,
    ...(listing.features ?? []).map((f) => `<span>${f}</span>`),
  ]
    .filter(Boolean)
    .join('')

  return `
  <div class="result-entry">
    <a data-testid="search-result-entry-header-${id}" href="${listing.href ?? `/iad/immobilien/mietwohnungen/tirol/innsbruck/${id}`}">
      <h3>${listing.title}</h3>
      <span aria-label="Ort ${listing.address}">${listing.address}</span>
      <div data-testid="search-result-entry-teaser-attributes-${id}">${teaser}</div>
      <span data-testid="search-result-entry-price-${id}">${listing.priceText}</span>
      <span data-testid="search-result-entry-seller-information-${id}">${listing.seller}</span>
      <img alt="Cover Image" src="https://cache.willhaben.at/mmo/${id}/thumb.jpg">
    </a>
  </div>`
}

function page({ listings, nextHref, disabledNext }) {
  const nextButton = disabledNext
    ? `<a data-testid="pagination-bottom-next-button" aria-disabled="true">Nächste</a>`
    : `<a data-testid="pagination-bottom-next-button" href="${nextHref}">Nächste</a>`

  return `<!doctype html>
<html lang="de-AT"><head><meta charset="utf-8"><title>Mietwohnungen</title>
<meta property="og:title" content="Mietwohnungen Innsbruck">
<script type="application/ld+json">{"@type":"SearchResultsPage"}</script>
</head><body><main>
  <div id="skip-to-resultlist"></div>
  ${listings.map(card).join('\n')}
  <!-- An ad slot that shares the testid prefix but is not a listing. The id filter is
       what keeps it out of the output. -->
  <a data-testid="search-result-entry-header-promo" href="/promo"><h3>Anzeige</h3></a>
  ${nextButton}
</main></body></html>`
}

const pages = [
  {
    name: 'synthetic-page-1',
    url: 'https://www.willhaben.at/iad/immobilien/mietwohnungen/tirol/innsbruck?rows=90',
    nextHref: '/iad/immobilien/mietwohnungen/tirol/innsbruck?rows=90&page=2',
    disabledNext: false,
    listings: [
      {
        id: '812345678',
        title: 'Helle 3-Zimmer-Wohnung mit Balkon',
        address: '6020 Innsbruck, Wilten',
        sizeM2: '78,5',
        rooms: '3',
        features: ['Balkon', 'Neubau'],
        priceText: '€ 1.450,00',
        seller: 'Privat',
      },
      {
        id: '812345679',
        title: 'Dachgeschosswohnung mit Bergblick',
        address: '6020 Innsbruck, Hötting',
        sizeM2: '104',
        rooms: '4',
        features: ['Terrasse'],
        // Thousands separator plus decimal comma — the case an en-US parse gets wrong.
        priceText: '€ 2.100,50',
        seller: 'Immobilien Tirol GmbH',
      },
      {
        id: '812345680',
        title: 'Kompakte Garconniere',
        address: '6020 Innsbruck',
        sizeM2: '31,2',
        rooms: '1',
        features: [],
        priceText: 'Preis auf Anfrage',
        seller: 'Privat',
      },
    ],
  },
  {
    name: 'synthetic-page-2',
    url: 'https://www.willhaben.at/iad/immobilien/mietwohnungen/tirol/innsbruck?rows=90&page=2',
    nextHref: null,
    disabledNext: true,
    listings: [
      {
        id: '812345681',
        title: 'Familienwohnung mit Garten',
        address: '6060 Hall in Tirol, Zentrum',
        sizeM2: '120',
        rooms: '4,5',
        features: ['Garten', 'Garage'],
        priceText: '€ 1.890,00',
        seller: 'Privat',
      },
      {
        id: '812345682',
        title: 'Sanierte Altbauwohnung',
        address: '6020 Innsbruck, Saggen',
        sizeM2: '92',
        rooms: '3',
        features: ['Altbau'],
        priceText: '€ 1.675,00',
        seller: 'Wohnbau Tirol',
      },
    ],
  },
  {
    name: 'synthetic-sparse',
    url: 'https://www.willhaben.at/iad/immobilien/mietwohnungen/tirol/kufstein?rows=90',
    nextHref: null,
    disabledNext: true,
    // Deliberately threadbare: no teaser strip, no seller. Every optional field is
    // nullable in output_schema, and this is what proves the adapter honours that
    // instead of inventing values.
    listings: [
      {
        id: '900000001',
        href: '/iad/immobilien/mietwohnungen/tirol/kufstein/900000001',
        title: 'Wohnung ohne Detailangaben',
        address: '6330 Kufstein',
        sizeM2: null,
        rooms: null,
        features: [],
        priceText: '',
        seller: '',
      },
    ],
  },
]

mkdirSync(outDir, { recursive: true })

const manifest = pages.map((spec) => {
  const html = page(spec)
  writeFileSync(join(outDir, `${spec.name}.body.gz`), gzipSync(Buffer.from(html, 'utf8'), { level: 9 }))
  return {
    name: spec.name,
    url: spec.url,
    tier: 'browser',
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    bodyFile: `${spec.name}.body.gz`,
    synthetic: true,
    expected: null,
  }
})

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(`wrote ${manifest.length} synthetic fixtures to ${outDir}\n`)
