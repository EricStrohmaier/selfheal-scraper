/**
 * willhaben/immo-search — `forge.adapter.code_ts`
 *
 * Ported by hand from a working production scraper. See README.md in this directory for
 * the field-anchor table, the provenance of the fixtures, and why this source is on the
 * browser tier rather than the http tier.
 *
 * The shape of this adapter is the thing worth copying, and it is what the compile agent
 * should be shown as the worked example for a DOM-tier site:
 *
 *   1. Find one anchor per card — here `a[data-testid^="search-result-entry-header-"]`.
 *   2. Read the card's own id out of that anchor's testid.
 *   3. Address every other field with a testid built from that id.
 *
 * Nothing is located by position, so renesting or reordering the card breaks none of it.
 * That is the difference between a selector that survives a redesign and one that a
 * repair run has to rewrite, and it is the same reason the validator rejects `nth-child`
 * and chains of bare child combinators.
 */

import type { ExtractInput, ExtractDocument } from '@forge/core'

const ORIGIN = 'https://www.willhaben.at'
const HEADER_PREFIX = 'search-result-entry-header-'

type Element = ReturnType<ExtractDocument['querySelector']>

function text(node: unknown): string | null {
  if (node === null || node === undefined) return null
  const content = (node as { textContent?: string | null }).textContent
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : null
}

function attr(node: unknown, name: string): string | null {
  if (node === null || node === undefined) return null
  const value = (node as { getAttribute?: (n: string) => string | null }).getAttribute?.(name)
  return typeof value === 'string' && value.length > 0 ? value : null
}

function absolute(href: string): string {
  if (href.startsWith('http')) return href
  return ORIGIN + (href.startsWith('/') ? href : '/' + href)
}

/**
 * Parse an Austrian price string.
 *
 * `€ 1.234,56` is 1234.56 — dots group thousands, the comma is the decimal separator.
 * Reading it the en-US way turns 1.234,56 into 1.23456 or 123456, both of which look
 * like plausible prices, so this silently corrupts data rather than failing.
 */
function parsePrice(raw: string | null): number | null {
  if (raw === null) return null
  const digits = raw.replace(/[^0-9.,]/g, '')
  if (digits.length === 0) return null
  const normalized = digits.replace(/\./g, '').replace(',', '.')
  const value = Number(normalized)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** `2,5` and `2.5` both mean two and a half. */
function parseDecimal(raw: string | null): number | null {
  if (raw === null) return null
  const value = Number(raw.replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

function cardsOf(input: ExtractInput): Element[] {
  const doc = input.doc()
  return [...doc.querySelectorAll(`a[data-testid^="${HEADER_PREFIX}"]`)] as Element[]
}

function idOf(card: Element): string | null {
  const testId = attr(card, 'data-testid')
  if (testId === null) return null
  const id = testId.slice(HEADER_PREFIX.length)
  // willhaben ids are numeric. Anything else is a testid that merely shares the prefix.
  return /^[0-9]+$/.test(id) ? id : null
}

/** Scoped lookup inside one card, by a testid built from that card's own id. */
function inCard(card: Element, testId: string): unknown {
  return (card as unknown as ExtractDocument).querySelector(`[data-testid="${testId}"]`)
}

export function extract(input: ExtractInput): unknown[] {
  const items: unknown[] = []

  for (const card of cardsOf(input)) {
    const id = idOf(card)
    const href = attr(card, 'href')
    if (id === null || href === null) continue

    const title = text((card as unknown as ExtractDocument).querySelector('h3'))
    // A card with no title is a placeholder or an ad slot, not a listing.
    if (title === null) continue

    const priceText = text(inCard(card, `search-result-entry-price-${id}`))
    const address = text((card as unknown as ExtractDocument).querySelector('span[aria-label^="Ort "]'))

    // The teaser strip holds size, rooms and free-text features in no fixed order, so
    // each child is classified by what it says rather than by where it sits.
    let sizeM2: number | null = null
    let rooms: number | null = null
    const features: string[] = []
    const teaser = inCard(card, `search-result-entry-teaser-attributes-${id}`)
    if (teaser !== null && teaser !== undefined) {
      for (const child of [...((teaser as { children: Iterable<unknown> }).children ?? [])]) {
        const value = text(child)
        if (value === null) continue
        const size = /^([0-9]+(?:[.,][0-9]+)?)\s*m²$/.exec(value)
        if (size !== null) {
          sizeM2 = parseDecimal(size[1] ?? null)
          continue
        }
        const room = /^([0-9]+(?:[.,][0-9]+)?)\s*Zimmer$/.exec(value)
        if (room !== null) {
          rooms = parseDecimal(room[1] ?? null)
          continue
        }
        features.push(value)
      }
    }

    const postalMatch = address === null ? null : /^([0-9]{4})/.exec(address)
    const districtParts = address === null ? [] : address.split(',').slice(1)

    items.push({
      id,
      url: absolute(href),
      title,
      price: parsePrice(priceText),
      priceText,
      sizeM2,
      rooms,
      features,
      address,
      postalCode: postalMatch === null ? null : (postalMatch[1] ?? null),
      district: districtParts.length > 0 ? districtParts.join(',').trim() : null,
      seller: text(inCard(card, `search-result-entry-seller-information-${id}`)),
      imageUrl: attr((card as unknown as ExtractDocument).querySelector('img[alt="Cover Image"]'), 'src'),
    })
  }

  return items
}

/**
 * Listing page -> item URLs, plus the next page.
 *
 * The next-page anchor stays in the DOM on the last page and is marked disabled, so
 * following it blindly walks in a circle. Both spellings are checked because the site has
 * used each.
 */
export function discover(input: ExtractInput): string[] {
  const urls: string[] = []

  for (const card of cardsOf(input)) {
    const href = attr(card, 'href')
    if (href !== null && idOf(card) !== null) urls.push(absolute(href))
  }

  const next = input.doc().querySelector('a[data-testid="pagination-bottom-next-button"]')
  const disabled = attr(next, 'disabled') !== null || attr(next, 'aria-disabled') === 'true'
  const nextHref = attr(next, 'href')
  if (!disabled && nextHref !== null) urls.push(absolute(nextHref))

  return urls
}
