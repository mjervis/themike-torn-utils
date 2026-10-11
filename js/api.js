// Thin client for the Torn API v2 (https://www.torn.com/swagger.php).
// The key is sent in the Authorization header so it never appears in URLs.

const BASE = 'https://api.torn.com/v2';
const COMMENT = 'inventory-profit';

// Torn allows 100 requests/minute per user, shared across all of their keys and tools.
// Cap this app at ~60/minute so it leaves headroom for anything else the user runs.
const MIN_GAP_MS = 1000;
let lastCall = 0;

// Errors that mean this key must not be used again (Torn's ToS: repeated calls with
// invalid/disabled keys can get the user's IP banned) or that we must stop calling for now.
//  1 empty key, 2 incorrect key, 10 owner in federal jail, 13 inactive owner, 18 paused key
export const DEAD_KEY_CODES = [1, 2, 10, 13, 18];
//  5 rate limited, 8 IP blocked, 9 API disabled, 14 daily read limit
const STOP_CODES = [5, 8, 9, 14];

export class TornApiError extends Error {
  constructor(code, message) {
    super(`Torn API error ${code}: ${message}`);
    this.code = code;
    this.deadKey = DEAD_KEY_CODES.includes(code);
    this.fatal = this.deadKey || STOP_CODES.includes(code);
  }
}

// TornInventoryItemType from the v2 spec (https://www.torn.com/swagger/openapi.json).
const INVENTORY_CATEGORIES = [
  'Alcohol', 'Artifact', 'Book', 'Booster', 'Candy', 'Car', 'Clothing', 'Collectible',
  'Defensive', 'Drug', 'Energy Drink', 'Enhancer', 'Flower', 'Jewelry', 'Material', 'Medical',
  'Melee', 'Other', 'Plushie', 'Primary', 'Secondary', 'Special', 'Supply Pack', 'Temporary', 'Tool',
];

async function throttle() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export function createClient(key) {
  // Once Torn rejects the key (or tells us to back off) this client makes no further calls.
  let halted = null;
  let calls = 0;

  async function get(pathOrUrl, params = {}) {
    if (halted) throw halted;
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    url.searchParams.delete('key'); // pagination links may embed one; we use the header
    if (!url.searchParams.has('comment')) url.searchParams.set('comment', COMMENT);

    await throttle();
    calls++;
    const res = await fetch(url, { headers: { Authorization: `ApiKey ${key}` } });
    if (!res.ok) throw new TornApiError(res.status, res.statusText);
    const body = await res.json();
    if (body.error) {
      const err = new TornApiError(body.error.code, body.error.error);
      if (err.fatal) halted = err;
      throw err;
    }
    return body;
  }

  return {
    /** Number of requests this client has sent to Torn. */
    get calls() { return calls; },

    /** The key owner's id and name, so saved data can be kept per player. */
    async me() {
      const { profile } = await get('/user/basic');
      return { id: profile.id, name: profile.name };
    },

    /** All items in Torn with market value, image, type, etc. */
    async items() {
      const body = await get('/torn/items');
      return body.items;
    },

    /** Every log type id + title. */
    async logTypes() {
      const body = await get('/torn/logtypes');
      return body.logtypes;
    },

    /**
     * Full inventory. Torn requires a category (error 21 without one, despite the spec), so
     * walk every category and follow pagination within each. Cached by Torn for 1 hour per category.
     */
    async inventory({ bypassCache = false, onCategory } = {}) {
      const items = [];
      let timestamp = null;
      let accepted = 0;
      const bypass = bypassCache ? Math.floor(Date.now() / 1000) : undefined;
      for (const [i, cat] of INVENTORY_CATEGORIES.entries()) {
        onCategory?.(cat, i + 1, INVENTORY_CATEGORIES.length);
        let next = '/user/inventory';
        let params = { cat, limit: 250, timestamp: bypass };
        for (let page = 0; next && page < 20; page++) {
          let body;
          try {
            body = await get(next, params);
          } catch (err) {
            if (err.code === 21) break; // category no longer exists in Torn: skip it
            throw err;
          }
          if (page === 0) accepted++;
          const found = body.inventory?.items ?? [];
          items.push(...found);
          timestamp = Math.min(timestamp ?? Infinity, body.inventory?.timestamp ?? Infinity);
          next = found.length ? body._metadata?.links?.next : null;
          params = {};
        }
      }
      if (!accepted) throw new TornApiError(21, 'Torn rejected every inventory category');
      return { items, timestamp: Number.isFinite(timestamp) ? timestamp : null };
    },

    /**
     * Logs of the given types, newest first, walking back in time.
     * Starts at `to` (default: now) and stops at `from` (unix seconds) or after `maxPages` pages of 100.
     */
    async logs(logIds, { from, to: before, maxPages = 20, onPage } = {}) {
      const seen = new Map();
      let to = before;
      for (let page = 0; page < maxPages; page++) {
        const body = await get('/user/log', { log: logIds.join(','), limit: 100, from, to });
        const fresh = body.log.filter((l) => !seen.has(l.id));
        for (const l of fresh) seen.set(l.id, l);
        onPage?.(seen.size, page + 1);
        if (body.log.length < 100 || fresh.length === 0) break;
        // Step back to the oldest timestamp seen; duplicates in the same second are de-duplicated above.
        to = Math.min(...body.log.map((l) => l.timestamp));
      }
      return [...seen.values()].sort((a, b) => b.timestamp - a.timestamp);
    },

    /** Lowest current item market listing for one item. */
    async lowestListing(itemId) {
      const body = await get(`/market/${itemId}/itemmarket`, { limit: 20 });
      const prices = body.itemmarket.listings.map((l) => l.price);
      return {
        lowest: prices.length ? Math.min(...prices) : null,
        average: body.itemmarket.item?.average_price ?? null,
      };
    },
  };
}
