# willhaben/immo-search — adapter notes

Extraction logic for willhaben property search result pages, ported from the working
scraper in `EricStrohmaier/willhaben-scraper` (`src/scrapers/willhaben/list-scraper.ts`)
and re-expressed against the Forge adapter contract.

## About the fixtures

**The committed fixtures are synthetic, and they are labelled `synthetic-*`.**

willhaben's `robots.txt` opens with:

> It is expressively forbidden to use spiders, search robots or other automatic methods
> to access willhaben.at. Only if willhaben.at has given such access is allowed.

and specifically disallows `/rest/`, `/webapi/`, `/jobs/webapi/`, `/restapi/` and
`/ajax/` — which are exactly the internal JSON endpoints an adapter would otherwise
prefer. So no automated fetch of willhaben was made to build this, and the fixtures were
generated from the DOM contract the selectors encode rather than captured from the site.

That is enough to prove the extraction logic, the price and area parsing, the
`discover()` pagination and the promotion gate. It is not enough to prove the selectors
still match production markup — only a real capture does that.

**To make this a real adapter:** capture three result pages yourself, from a browser
session you operate, and replace the fixtures. `packages/db`'s `captureFixture` takes the
body directly, and `loadFixtures` reads the on-disk manifest format used here. Then set
`expected` on one of them once you have eyeballed the output. Nothing else changes.

The `fetch_plan` here is `tier: 'browser'` for the same reason: the listing page is
client-rendered, and the JSON endpoints behind it are the ones robots.txt names.

## Field anchors

Every field is anchored on a `data-testid` or an `aria-label`, never on position. That is
the third rung of the section 9 preference list (semantic DOM attributes), and it is
where this site forces you to land — there is no accessible JSON tier.

| field | anchor |
|---|---|
| `id` | the numeric suffix of `data-testid="search-result-entry-header-{id}"` |
| `url` | that anchor's `href`, resolved against the origin |
| `title` | the `h3` inside the entry header |
| `price`, `priceText` | `data-testid="search-result-entry-price-{id}"`, parsed de-AT |
| `sizeM2`, `rooms` | children of `data-testid="search-result-entry-teaser-attributes-{id}"` |
| `address` | `span[aria-label^="Ort "]` |
| `postalCode` | leading 4 digits of the address |
| `seller` | `data-testid="search-result-entry-seller-information-{id}"` |
| `imageUrl` | `img[alt="Cover Image"]` |

The id-first pattern is what makes this survivable: one anchor is located per card, and
every other field is addressed by a testid built from that card's own id. A layout change
that reorders or renests the card leaves all of it working. That is the property a
positional selector chain does not have, and it is why the validator rejects those.

## Parsing notes

- **Prices are de-AT**: `€ 1.234,56` is one thousand two hundred and thirty four euros
  and fifty six cents. Dots are thousands separators and the comma is the decimal point,
  which is the reverse of the en-US reading. Getting this backwards produces a plausible
  wrong number rather than an error, so it is worth a test of its own.
- **`priceText` is kept alongside `price`**: listings say "Preis auf Anfrage" or quote a
  range, and a null `price` with the original text preserved is more useful downstream
  than a guess.
- **`rooms` can be fractional.** `2,5 Zimmer` is normal in Austrian listings.
