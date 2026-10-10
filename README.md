# Torn Inventory Profit

A static, client-side web app that shows your [Torn](https://www.torn.com) inventory alongside what you paid for each item, what it's worth now, and the profit if you sell it — with the item market fee (5%) and anonymous listing fee (+10%) applied.

**Live:** https://mjervis.github.io/themike-torn-utils/

No server, no build step. Your API key goes from your browser straight to `api.torn.com` and nowhere else.

## How it works

| Data | Endpoint (API v2) | Key level |
| --- | --- | --- |
| Inventory | `GET /user/inventory` (paginated, cached by Torn for 1 hour) | Minimal |
| Purchase prices | `GET /user/log?log=<ids>` — item market, bazaar, shop and abroad buy logs | **Full** |
| Log type ids | `GET /torn/logtypes` — purchase types are picked by title, editable in Settings | Public |
| Market value | `GET /torn/items` → `value.market_price` | Public |
| Lowest listing (optional) | `GET /market/{id}/itemmarket` | Public |

**Cost basis.** By default the app assumes you sold or used your oldest stock first, so the units you still hold are costed from your *most recent* purchases. You can switch to a simple average of all purchases. Items with no purchase log (gifts, crime finds, older than the scanned logs) can have a cost typed in by hand; overrides are saved in the browser.

**Fees.** Choose the sale route at the top of the results:

- *Direct / trade* — no fee
- *Item market* — 5% fee
- *Anonymous* — 5% + 10% = 15%

Both percentages are editable in Settings in case Torn changes them.

**Rate limits.** Requests are spaced 1 second apart (~60/minute), leaving headroom under Torn's 100 calls/minute, which is shared across all of a user's keys and tools. Fetching lowest listings costs one call per item, so it's opt-in.

## Running locally

ES modules need to be served over HTTP (not `file://`):

```bash
npx serve .
```

or

```bash
python3 -m http.server 8000
```

## Tests

```bash
node --test
```

## Deploying

Hosted on GitHub Pages from the root of `main` — every push to `main` redeploys. Any other static host (Cloudflare Pages, Netlify) works too: publish the repository root as-is.

## Torn API Terms of Service

The app follows the [API ToS guidelines](https://www.torn.com/api.html):

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
| --- | --- | --- | --- | --- |
| Only locally (settings, manual costs, cached listing prices in the browser) | Nobody | Not eligible — only the end user has access | Stored locally only if “Remember” is ticked / Not shared | Custom: `user` → inventory, log; `torn` → items, logtypes; `market` → itemmarket. Or Full Access. |

- The ToS table is shown where the key is entered, with a link to create a custom key with only these selections.
- Invalid or disabled keys (error codes 1, 2, 10, 13, 18) are forgotten immediately and never re-sent, as required to avoid IP bans. Rate-limit/blocked responses (5, 8, 9, 14) stop all further calls.
- Calls carry `comment=inventory-profit` so users can audit them in their key log.
- Global caches (`market → itemmarket`) aren't bypassed. The `timestamp` parameter is only used on inventory when the user opts in, which the docs explicitly allow.
- “Forget my key & clear saved data” removes everything the page stored.

## Notes

- Torn log `data` fields aren't formally documented, so the parser accepts several shapes (`items[]`/`item`, `qty`/`quantity`, `cost_each`/`cost_total`). Expand a row and open “Raw log data” to check what was read.
