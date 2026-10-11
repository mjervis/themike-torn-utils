# Torn Utils

A static, client-side web app for [Torn](https://www.torn.com) with two pages:

- **Inventory profit** — your inventory alongside what you paid for each item, what it's worth now, and the profit if you sell it, with the item market fee (5%) and anonymous listing fee (+10%) applied.
- **Energy** — gym energy spent this week against your faction's training requirement, what else your energy went on, and a "best options" plan for when to take Xanax, use refills and drink energy cans to hit the target.

**Live:** https://mjervis.github.io/themike-torn-utils/

No server, no build step. Your API key goes from your browser straight to `api.torn.com` and nowhere else.

## How it works

| Data | Endpoint (API v2) | Key level |
| --- | --- | --- |
| Inventory | `GET /user/inventory?cat=…` — one call per category (Torn requires `cat`), cached by Torn for 1 hour per category | Minimal |
| Purchase prices | `GET /user/log?log=<ids>` — item market, bazaar, shop and abroad buy logs | **Full** |
| Log type ids | `GET /torn/logtypes` — purchase types are picked by title, editable in Settings | Public |
| Market value | `GET /torn/items` → `value.market_price` | Public |
| Lowest listing (optional) | `GET /market/{id}/itemmarket` | Public |

| Energy bar, cooldowns, refills | `GET /user/bars`, `/user/cooldowns`, `/user/refills` | Minimal |
| Gym training this week | `GET /user/log?log=<gym train ids>&from=<week start>`, with `/user/gym` + `/torn/gyms` for energy per train | **Full** |
| Attacks, Xanax, cans, refills this week | `GET /user/personalstats?stat=…` now and at the week start | Public |

**Cost basis.** By default the app assumes you sold or used your oldest stock first, so the units you still hold are costed from your *most recent* purchases. You can switch to a simple average of all purchases. Items with no purchase log (gifts, crime finds, older than the scanned logs) can have a cost typed in by hand; overrides are saved in the browser.

**Trade goods vs personal use.** Holdings are split into two groups, with *Trade goods* shown by default. The default trade types are the usual Torn resale stock: plushies, flowers, drugs, artifacts, special items and supply packs. Everything else (boosters, candy, energy drinks, alcohol, medical, weapons, armour…) counts as personal use. Change the type list in Settings, or click an item's Trade / Personal tag to move just that item.

**Fees.** Choose the sale route at the top of the results:

- *Direct / trade* — no fee
- *Item market* — 5% fee
- *Anonymous* — 5% + 10% = 15%

Both percentages are editable in Settings in case Torn changes them.

**Rate limits.** Requests are spaced 1 second apart (~60/minute), leaving headroom under Torn's 100 calls/minute, which is shared across all of a user's keys and tools. Fetching lowest listings costs one call per item, so it's opt-in.

**Energy plan.** Set your weekly gym target (e.g. 3,000) and when your faction's week starts (TCT). The page works out how much natural regen you'll still get — allowing for energy lost to a long offline stretch once the bar is full — and fills any gap in this order: daily points refills, then items you already hold, then whatever's cheapest per energy at market value. Xanax is limited by drug cooldown (planned at 8h, editable) and cans/coupons by the booster cooldown limit (24h by default). If cheap small cans would run out of booster cooldown before the target, it switches to the most energy per cooldown hour. Attacks are counted at 25 energy each; other energy uses aren't reported by the API.

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
| Only locally (settings, manual costs, cached listing prices in the browser) | Nobody | Not eligible — only the end user has access | Stored locally only if “Remember” is ticked / Not shared | Custom: `user` → inventory, log, bars, cooldowns, refills, gym, personalstats; `torn` → items, logtypes, gyms; `market` → itemmarket. Or Full Access. |

- The ToS table is shown where the key is entered, with a link to create a custom key with only these selections.
- Invalid or disabled keys (error codes 1, 2, 10, 13, 18) are forgotten immediately and never re-sent, as required to avoid IP bans. Rate-limit/blocked responses (5, 8, 9, 14) stop all further calls.
- Calls carry `comment=inventory-profit` so users can audit them in their key log.
- Global caches (`market → itemmarket`) aren't bypassed. The `timestamp` parameter is only used on inventory when the user opts in, which the docs explicitly allow.
- “Forget my key & clear saved data” removes everything the page stored.

## Notes

- Torn log `data` fields aren't formally documented, so the parser accepts several shapes (`items[]`/`item`, `qty`/`quantity`, `cost_each`/`cost_total`). Expand a row and open “Raw log data” to check what was read.
