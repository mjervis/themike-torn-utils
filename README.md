# Torn Utils

A static, client-side web app for [Torn](https://www.torn.com) with five pages:

- **Inventory profit** — your inventory alongside what you paid for each item, what it's worth now, and the profit if you sell it, with the item market fee (5%) and anonymous listing fee (+10%) applied. The **Trading** tab adds up everything you've bought and sold, with realised profit on sales and unrealised profit on what you still hold.
- **Energy** — gym energy spent this week against your faction's training requirement, what else your energy went on, and a "best options" plan for when to take Xanax, use refills and drink energy cans to hit the target.
- **Training cost** — the consumables you've used for training (Xanax, Ecstasy, energy drinks, erotic DVDs, candy…), grouped into happy jumps, with the cost per jump, per energy and per stat point gained.
- **Targets** — everyone you've beaten, from your attack history, with where they are now: ready to hit, in hospital (with a countdown), in jail, abroad or flying, plus last active, life, the fair fight from your last win and how much you've mugged them for, with a total. Filter by level, when you beat them and how recently they were active; sort by status or most mugged.
- **Chain** — a live leaderboard for the faction's Halloween 2,500 chain competition: the chain count and time until it breaks, teams ranked by hits per member, each member's hits and respect, who's qualified (30+ hits) and what each team is set to win, the Soul Collector race and who's in each raffle. Refreshes every minute while open.

**Live:** https://mjervis.github.io/themike-torn-utils/

No server, no build step. Your API key goes from your browser straight to `api.torn.com` and nowhere else.

## How it works

| Data | Endpoint (API v2) | Key level |
| --- | --- | --- |
| Player id | `GET /user/basic` — once per key, so saved data is kept per player | Public |
| Inventory | `GET /user/inventory?cat=…` — one call per category (Torn requires `cat`), cached by Torn for 1 hour per category | Minimal |
| Purchases & finds | `GET /user/log?log=<ids>` — buy logs (item market, bazaar, shop, abroad) and find logs (crimes, city/dump finds, loot) | **Full** |
| Sales & item use | `GET /user/log?log=<ids>` — sell logs (item market, bazaar, shop) and item use logs (drugs, boosters, energy drinks, candy) | **Full** |
| Log type ids | `GET /torn/logtypes` — purchase and find types are picked by title, editable in Settings | Public |
| Market value | `GET /torn/items` → `value.market_price` | Public |
| Lowest listing (optional) | `GET /market/{id}/itemmarket` | Public |
| Energy bar, cooldowns, refills | `GET /user/bars`, `/user/cooldowns`, `/user/refills` | Minimal |
| Gym training this week | `GET /user/log?log=<gym train ids>&from=<week start>`, with `/user/gym` + `/torn/gyms` for energy per train | **Full** |
| Your attacks (Targets) | `GET /user/attacks?filters=outgoing` — whole history once, then only newer attacks | Limited |
| Mug money (Targets) | `GET /user/log?log=<mug ids>` — mug log types picked by title, editable in Settings | **Full** |
| Target status, last action, life | `GET /user/{id}/profile` — one call per target, only when you check them | Public |
| Chain competition | `GET /faction/chain` and `/faction/chainreport` every minute; `/faction/members` and `/faction/chains` + `/faction/{chainId}/chainreport` for finished chains once a session | Public |
| Attacks, Xanax, cans, refills this week | `GET /user/personalstats?stat=…` now and at the week start | Public |

**Saved locally, fetched incrementally.** Everything is kept in the browser (IndexedDB), per player:

| Data | Reused for | Fetched again |
| --- | --- | --- |
| Log history (purchases, finds, gym training) | ever | only logs newer than the last sync (usually 1 call per 5 log types) |
| Inventory | 1 hour (matches Torn's cache) | 25 calls, one per category |
| Energy page inventory (drugs, energy drinks, boosters) | 1 hour; uses the full inventory above if that's fresh | 3 calls |
| Gym list | 7 days | 1 call |
| Item catalogue & market values | 15 minutes | 1 call |
| Log type list | 7 days | 1 call |

A first load is ~30 calls; a repeat load is typically **1**. The Energy page reads gym logs back to the start of your faction's week the first time, then only new ones. On opening the page, the last player's saved inventory profit data is shown straight away, with no key or API calls; **Update** fetches fresh inventory and prices (as does “Force refresh” in Settings for one load). “Read older log history” walks further back than the first scan.

**Cost basis.** Purchases and finds form one timeline; finds count as **$0**. By default the app assumes you sold or used your oldest stock first, so the units you still hold are costed from your *most recent* acquisitions — e.g. 10 Dahlias bought abroad at $3,000 then 2 found in a crime, holding 12, costs $2,500 each. You can switch to a simple average of everything. Items with no log at all (gifts, trades) can have a cost typed in by hand.

**Trading.** Purchases, finds, sales and item uses form one ledger per item, matched first in, first out: each sale is set against your oldest stock, so its realised profit is the sale proceeds after fees minus what those units cost. Item market sales use the fee in the log, or the item market fee setting when the log doesn't give one. Units sold with no purchase before them (e.g. bought before your saved history) are shown as uncosted and left out of realised profit. Unrealised profit is the Holdings figure for what you still hold, so *overall profit* = realised + unrealised. The range (7/30/90 days, all) and Trade goods / Personal / All choices apply. Trades and gifts aren't in Torn's buy/sell logs, so they aren't counted.

**Training cost.** Item use logs are matched against your purchases the same way, so each Xanax, can or DVD you use is costed at what you paid (or, by choice, today's market value; units with no purchase on record always use market value and are marked ≈). Gym training logs are grouped into bursts; a burst with Ecstasy or a big happy item (≥ 500 happy, e.g. an erotic DVD) used within the hour before it is a **jump**, and everything used since your previous training — up to 3 days back — counts towards that jump's cost. Where gym logs record stat gains, the page shows cost per stat point and how a jump's stats per energy compare with your ordinary training. Weeks follow the Energy page's week start. Points refills aren't costed.

**Targets.** Your outgoing attacks are saved like logs: read back as far as the log page setting allows the first time, then only new ones. Anyone you've attacked, mugged, hospitalised, looted, arrested or claimed a bounty on counts as beaten. Checking where they are costs one call per player, so “Check statuses” only looks up the most recently beaten few (20 by default, within the level and date filters) whose status is over a minute old; each row also has its own check button. Hospital and jail timers count down from the last check, and a target whose timer has run out shows as Ready — check again before attacking, as they may have been hit since. Statuses are saved with the time they were checked. Mug money comes from your mug logs, saved and fetched incrementally like the others; Torn doesn't document their fields, so the amount is read from `money_mugged`/`money`/`amount` and the player from `defender`/`target`/`victim`, and a mug log that names no one is matched to your Mugged attack that ended within two minutes of it. Totals follow the “Beaten in” range.

**Chain competition.** Scores come from Torn's chain reports, which any faction member can read with a public key: a member's hits are their chain attacks that left, mugged or hospitalised the target (assists, losses, escapes and stalemates aren't counted), summed over every chain running since the start (Sun 25 Oct 2026, 14:00 TCT). Team score is team hits ÷ team members, and members need 30+ hits for their team's placement payout. Soul Collector respect is each member's chain respect minus their bonus hits' respect. If a chain ends before reaching 2,500, every prize shows halved. Teams are matched to faction members by name (ignoring case, spaces and punctuation, then a unique prefix); anyone who doesn't match can be put on a team under **Teams** on the page, kept on that device. Finished chains' reports are saved and never re-read; the competition, teams and prizes are set in `js/chain.js`.

**History.** A snapshot of every holding's quantity, price and cost is saved once per Torn day you load the page. The History tab charts market value and profit after fees over 7/30/90 days or all time, shows changes since yesterday / last week / last month, and lists per-item changes. Settings has **Download backup** / **Restore backup** (JSON; never includes the API key) so history survives clearing browser data or moving device.

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
| Only locally, in the browser (log history, attack history, target statuses, faction member list & chain reports, daily snapshots, cached inventory & prices, settings, manual costs) — kept until the user clears it | Nobody | Not eligible — only the end user has access | Stored locally only if “Remember” is ticked / Not shared | Custom: `user` → basic, inventory, log, bars, cooldowns, refills, gym, personalstats, attacks, profile; `faction` → members, chain, chains, chainreport; `torn` → items, logtypes, gyms; `market` → itemmarket. Or Full Access. |

- The ToS table is shown where the key is entered, with a link to create a custom key with only these selections.
- Invalid or disabled keys (error codes 1, 2, 10, 13, 18) are forgotten immediately and never re-sent, as required to avoid IP bans. Rate-limit/blocked responses (5, 8, 9, 14) stop all further calls.
- Calls carry `comment=inventory-profit` so users can audit them in their key log.
- Global caches (`market → itemmarket`) aren't bypassed. The `timestamp` parameter is only used on inventory when the user opts in, which the docs explicitly allow.
- “Forget my key & clear saved data” removes everything the page stored.

## Notes

- Torn log `data` fields aren't formally documented, so the parser accepts several shapes (`items[]`/`item`/`items_gained`/`loot`/`reward`, `qty`/`quantity`, `cost_each`/`cost_total`). Expand a row and open “Raw log data” to check what was read.
- Torn doesn't publish which log types are crime/find rewards, so they're chosen by title (anything mentioning finds, loot, dump or items gained; money-only and failed crimes are excluded). Adjust the list under Settings → Free item sources.
