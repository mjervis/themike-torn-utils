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

const LOG_IDS_PER_CALL = 5;

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
    // The spec sends lists as plain comma-separated values (e.g. log=105,4900); keep the commas literal.
    url.search = url.searchParams.toString().replace(/%2C/gi, ',');

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

  /** Outgoing attacks from `path`, newest first, from `to` back to `from` or `maxPages` pages of 100. */
  async function walkAttacks(path, { from, to: before, maxPages = 20, onPage } = {}) {
    const seen = new Map();
    let to = before;
    for (let p = 0; p < maxPages; p++) {
      const body = await get(path, { filters: 'outgoing', limit: 100, sort: 'DESC', from, to });
      const list = body.attacks ?? [];
      const fresh = list.filter((a) => !seen.has(a.id));
      for (const a of fresh) seen.set(a.id, a);
      onPage?.(seen.size, p + 1);
      if (list.length < 100 || fresh.length === 0) break;
      to = Math.min(...list.map((a) => a.started));
    }
    return [...seen.values()].sort((a, b) => b.started - a.started);
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
    async inventory({ bypassCache = false, onCategory, categories = INVENTORY_CATEGORIES } = {}) {
      const items = [];
      let timestamp = null;
      let accepted = 0;
      const bypass = bypassCache ? Math.floor(Date.now() / 1000) : undefined;
      for (const [i, cat] of categories.entries()) {
        onCategory?.(cat, i + 1, categories.length);
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
     * What you have listed in your bazaar: [{ id, name, qty, price }]. API v2 has no bazaar of its
     * own yet and hands `selections=bazaar` to v1, so the v1 field names are read as well.
     */
    async bazaar() {
      const body = await get('/user', { selections: 'bazaar' });
      const list = Array.isArray(body.bazaar) ? body.bazaar : Object.values(body.bazaar ?? {});
      return list.map((b) => ({
        id: Number(b.ID ?? b.id ?? b.item_id),
        name: b.name ?? '',
        qty: Number(b.quantity ?? b.amount ?? b.qty) || 0,
        price: Number(b.price) || null,
      })).filter((b) => b.id && b.qty > 0);
    },

    /**
     * Logs of the given types, newest first, walking back in time.
     * Starts at `to` (default: now) and stops at `from` (unix seconds) or after `maxPages` pages of 100.
     */
    async logs(logIds, { from, to: before, maxPages = 20, onPage } = {}) {
      // Torn returned nothing (and no error) for ~40 ids in one request, so ask in small batches.
      const seen = new Map();
      let page = 0;
      for (let i = 0; i < logIds.length; i += LOG_IDS_PER_CALL) {
        const batch = logIds.slice(i, i + LOG_IDS_PER_CALL);
        let to = before;
        for (let p = 0; p < maxPages; p++) {
          const body = await get('/user/log', { log: batch.join(','), limit: 100, from, to });
          const list = Array.isArray(body.log) ? body.log : Object.values(body.log ?? {});
          const fresh = list.filter((l) => !seen.has(l.id));
          for (const l of fresh) seen.set(l.id, l);
          onPage?.(seen.size, ++page);
          if (list.length < 100 || fresh.length === 0) break;
          // Step back to the oldest timestamp seen; duplicates in the same second are de-duplicated above.
          to = Math.min(...list.map((l) => l.timestamp));
        }
      }
      return [...seen.values()].sort((a, b) => b.timestamp - a.timestamp);
    },

    /**
     * Attacks you made, newest first, walking back in time like logs(): from `to` (default: now)
     * back to `from` (unix seconds) or `maxPages` pages of 100.
     */
    async attacks(opts = {}) {
      return walkAttacks('/user/attacks', opts);
    },

    /**
     * Attacks made by your faction's members, newest first, walked back like attacks().
     * Needs a Limited key (or a custom one with faction → attacks) and faction API access permission.
     */
    async factionAttacks(opts = {}) {
      return walkAttacks('/faction/attacks', opts);
    },

    /** Another player's public profile: level, faction, status (hospital, travel…), last action, life. */
    async profile(id) {
      return (await get(`/user/${id}/profile`)).profile;
    },

    /** Your faction's members: id, name, position, level, last action, status. */
    async factionMembers() {
      return (await get('/faction/members')).members ?? [];
    },

    /** Your faction's current chain: { id, current, max, timeout (secs left), cooldown, start, end }. */
    async chain() {
      return (await get('/faction/chain')).chain;
    },

    /** Your faction's finished chains from `from` (unix seconds) on, oldest first. */
    async chains({ from } = {}) {
      return (await get('/faction/chains', { from, sort: 'ASC', limit: 100 })).chains ?? [];
    },

    /** A chain report with per-member hits and respect: the latest (including an ongoing chain), or chain `id`. */
    async chainReport(id) {
      return (await get(id ? `/faction/${id}/chainreport` : '/faction/chainreport')).chainreport;
    },

    /** Energy, nerve, happy and life bars. */
    async bars() {
      return (await get('/user/bars')).bars;
    },

    /** Seconds left on drug, medical and booster cooldowns. */
    async cooldowns() {
      return (await get('/user/cooldowns')).cooldowns;
    },

    /** Whether today's refills have been used (true = used). Resets at 00:00 TCT. */
    async refills() {
      return (await get('/user/refills')).refills;
    },

    /** The gym you're currently training in. */
    async gym() {
      return (await get('/user/gym')).gym;
    },

    /** Every gym with its energy cost per train. */
    async gyms() {
      return (await get('/torn/gyms')).gyms;
    },

    /** Up to 10 personal stats by name, as { name: value }; at `timestamp` (nearest day) if given. */
    async personalStats(stats, timestamp) {
      const body = await get('/user/personalstats', { stat: stats.slice(0, 10).join(','), timestamp });
      const list = Array.isArray(body.personalstats) ? body.personalstats : [];
      return Object.fromEntries(list.map((s) => [s.name, s.value]));
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
