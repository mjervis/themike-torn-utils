// Pure functions for turning purchase logs into a cost basis and profit figures.
// No DOM or network access here so it can be unit tested with `node --test`.

/** Sale routes and the fee each one deducts from the sale price. */
export function saleRoutes({ marketFee = 5, anonFee = 10 } = {}) {
  return {
    direct: { label: 'Direct / trade', fee: 0 },
    market: { label: `Item market (${marketFee}%)`, fee: marketFee / 100 },
    anon: { label: `Anonymous (${marketFee + anonFee}%)`, fee: (marketFee + anonFee) / 100 },
  };
}

/** Default log-type selection: anything that looks like buying an item. */
export function isPurchaseLogTitle(title) {
  return /\b(buy|bought|purchase)\b/i.test(title) && !/\b(points?|stocks?|propert|house|refill|loan|bank|sell)\b/i.test(title);
}

export function isDefaultPurchaseLog(title) {
  return isPurchaseLogTitle(title) && /(item market|bazaar|shop|abroad|auction)/i.test(title);
}

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : v;
  return Number.isFinite(n) ? n : null;
};

function firstNum(obj, keys) {
  for (const k of keys) {
    const n = num(obj?.[k]);
    if (n !== null) return n;
  }
  return null;
}

const QTY_KEYS = ['qty', 'quantity', 'amount', 'count'];

/** Pull a list of {id, qty} out of the varying shapes Torn log data uses. */
export function extractItems(data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const push = (id, qty) => {
    id = num(id);
    if (id) out.push({ id, qty: num(qty) ?? 1 });
  };

  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      if (typeof it === 'object') push(it.id ?? it.item ?? it.item_id, firstNum(it, QTY_KEYS));
      else push(it, 1);
    }
  } else if (data.items && typeof data.items === 'object') {
    // { "206": 3 } or { "206": { qty: 3 } }
    for (const [id, v] of Object.entries(data.items)) {
      push(id, typeof v === 'object' ? firstNum(v, QTY_KEYS) : v);
    }
  } else if (data.item !== undefined) {
    const it = data.item;
    if (typeof it === 'object' && it !== null) push(it.id ?? it.item_id, firstNum(it, QTY_KEYS) ?? firstNum(data, QTY_KEYS));
    else push(it, firstNum(data, QTY_KEYS));
  } else if (data.item_id !== undefined) {
    push(data.item_id, firstNum(data, QTY_KEYS));
  }
  return out;
}

/**
 * Convert one purchase log into lots: [{ itemId, qty, unitCost, timestamp, logId, title }].
 * Returns [] when the log has no usable item or price.
 */
export function parsePurchase(log) {
  const data = log?.data ?? {};
  const items = extractItems(data);
  if (!items.length) return [];

  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  let unitCost = firstNum(data, ['cost_each', 'price_each', 'price', 'cost_per_item']);
  if (unitCost === null) {
    const total = firstNum(data, ['cost_total', 'total_cost', 'cost', 'total']);
    if (total !== null && totalQty > 0) unitCost = total / totalQty;
  }
  if (unitCost === null) return [];

  return items.map((i) => ({
    itemId: i.id,
    qty: i.qty,
    unitCost,
    timestamp: log.timestamp,
    logId: log.id,
    title: log.details?.title ?? '',
    approximate: items.length > 1 && firstNum(data, ['cost_each']) === null,
  }));
}

/** Group lots by item id, newest first. */
export function lotsByItem(logs) {
  const map = new Map();
  for (const log of logs) {
    for (const lot of parsePurchase(log)) {
      if (!map.has(lot.itemId)) map.set(lot.itemId, []);
      map.get(lot.itemId).push(lot);
    }
  }
  for (const lots of map.values()) lots.sort((a, b) => b.timestamp - a.timestamp);
  return map;
}

/**
 * Work out what the units you still hold cost you.
 *  - 'recent':  assume you sold/used the oldest first, so the units you hold are the most recent buys.
 *  - 'average': weighted average of every purchase found.
 * Returns { unitCost, coveredQty, lots } or null when there is nothing to go on.
 */
export function costBasis(lots, heldQty, method = 'recent') {
  if (!lots?.length || heldQty <= 0) return null;

  if (method === 'average') {
    const qty = lots.reduce((s, l) => s + l.qty, 0);
    const spend = lots.reduce((s, l) => s + l.qty * l.unitCost, 0);
    return { unitCost: spend / qty, coveredQty: Math.min(qty, heldQty), lots };
  }

  let remaining = heldQty;
  let spend = 0;
  const used = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.qty, remaining);
    spend += take * lot.unitCost;
    remaining -= take;
    used.push({ ...lot, used: take });
  }
  const covered = heldQty - remaining;
  return { unitCost: spend / covered, coveredQty: covered, lots: used };
}

/** Profit for a holding, given a sale route fee (0.05 = 5%). */
export function profit({ qty, unitCost, unitPrice, fee }) {
  if (unitPrice == null) return { net: null, value: null, cost: null, profit: null, roi: null };
  const value = qty * unitPrice;
  const net = value * (1 - fee);
  if (unitCost == null) return { value, net, cost: null, profit: null, roi: null };
  const cost = qty * unitCost;
  const p = net - cost;
  return { value, net, cost, profit: p, roi: cost > 0 ? p / cost : null };
}

/** Minimum unit sale price to break even after fees. */
export function breakEven(unitCost, fee) {
  return unitCost == null ? null : unitCost / (1 - fee);
}
