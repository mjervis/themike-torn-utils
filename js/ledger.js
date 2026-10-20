// Buy / sell / use ledger: every item that came in (purchases, finds) and went out (sales, uses),
// matched first-in-first-out so each sale has a realised profit and each use has a cost.
// Pure functions only, so it can be unit tested with `node --test`.

import { extractItems, parsePurchase, parseFind } from './costing.js';

/** Logs where you sell items for money: item market, bazaar, shops, abroad. */
export function isSellLogTitle(title) {
  return /\b(sell|sells|sold|sale)\b/i.test(title) &&
    !/\b(points?|stocks?|shares?|propert(y|ies)|(?<!auction )house|company|loan|bank|buy|bought|purchase|fail(ed)?|cancel(led)?|remove[ds]?|add(ed|s)?|list(ed|ing)?|update[ds]?|edit(ed)?)\b/i.test(title);
}

export function isDefaultSellLog(title) {
  return isSellLogTitle(title) && /(item market|bazaar|shop|abroad|auction)/i.test(title);
}

/** Logs where you use (consume) an item yourself. */
export function isUseLogTitle(title) {
  return /\b(use|uses|used|consume[ds]?|take|takes|took|drink|drinks|eat|eats)\b/i.test(title) &&
    /\bitem\b|\b(drugs?|boosters?|candy|energy drinks?|alcohol|medical|xanax|ecstasy|dvd)\b/i.test(title) &&
    !/\b(crimes?|points?|refill|fail(ed)?|bounty|attack|mission|faction|armou?ry|loan|give|gave|send|sent|trade)\b/i.test(title);
}

// Torn files most consumables under their own log type ("Item use xanax", "Item use erotic dvd"),
// and only some by category ("Item use candy"). Packs and boxes are left out: they give items, not effects.
const CONSUMABLE_USE = new RegExp(`^item use (${[
  'drugs?', 'boosters?', 'candy', 'energy drinks?', 'alcohol', 'medical',
  'cannabis', 'ecstasy', 'ketamine', 'lsd', 'opium', 'pcp', 'shrooms', 'speed', 'vicodin', 'xanax',
  'erotic dvd', 'feathery hotel coupon', 'love juice',
  'morphine', '(small )?first aid kit', 'neumune tablet', 'blood bag', 'ipecac syrup',
].join('|')})( overdose)?$`, 'i');

export function isDefaultUseLog(title) {
  return isUseLogTitle(title) && CONSUMABLE_USE.test(title.trim());
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

/**
 * Convert one sale log into disposals: [{ itemId, qty, unitGross, unitNet, timestamp, logId, title }].
 * When the log doesn't state a fee, item market sales are charged `marketFee` (+ `anonFee` when
 * the log says the listing was anonymous) and marked as estimated.
 */
export function parseSale(log, { marketFee = 0.05, anonFee = 0.10 } = {}) {
  const data = log?.data ?? {};
  const items = extractItems(data);
  if (!items.length) return [];
  const title = log.details?.title ?? '';
  const totalQty = items.reduce((s, i) => s + i.qty, 0);

  let unitGross = firstNum(data, ['cost_each', 'price_each', 'value_each', 'price', 'cost_per_item']);
  const total = firstNum(data, ['cost_total', 'total_cost', 'total_value', 'value', 'money', 'money_gained', 'cost', 'total']);
  if (unitGross === null && total !== null && totalQty > 0) unitGross = total / totalQty;
  if (unitGross === null) return [];

  const gross = unitGross * totalQty;
  let fee = firstNum(data, ['fee', 'fees', 'market_fee', 'tax']);
  let feeEstimated = false;
  if (fee === null) {
    fee = /item market/i.test(title) ? gross * (marketFee + (data.anonymous ? anonFee : 0)) : 0;
    feeEstimated = fee > 0;
  }
  const unitNet = (gross - fee) / totalQty;

  return items.map((i) => ({
    itemId: i.id,
    qty: i.qty,
    unitGross,
    unitNet,
    timestamp: log.timestamp,
    logId: log.id,
    title,
    feeEstimated,
  }));
}

/** Logs of the trade window (direct trades with another player). */
export function isTradeLogTitle(title) {
  return /^trade\b/i.test(title.trim());
}

// A completed trade writes what changed hands as items/money incoming and outgoing.
const TRADE_SIDE = /^trade (items|money) (incoming|outgoing)$/i;

export function isDefaultTradeLog(title) {
  return TRADE_SIDE.test(title.trim());
}

/**
 * Turn trade logs into sales and purchases. Logs are grouped by trade id; one money total covers
 * every item in the trade, so it is split across them by `value(itemId)` (Torn market value now),
 * falling back to an even split per unit. Items received in a swap are costed at their market value,
 * and the items you gave count as sold for that value plus any money you came out ahead.
 * @returns {{ sales: object[], purchases: object[] }} in the shapes parseSale and parsePurchase return
 */
export function parseTrades(logs, value = () => null) {
  const trades = new Map();
  for (const log of logs) {
    const side = TRADE_SIDE.exec(log.details?.title?.trim() ?? '');
    if (!side) continue;
    const d = log.data ?? {};
    const key = d.parsed_trade_id ?? `${d.user}:${log.timestamp}`;
    if (!trades.has(key)) trades.set(key, { key, timestamp: 0, cash: 0, out: [], in: [] });
    const t = trades.get(key);
    t.timestamp = Math.max(t.timestamp, log.timestamp);
    const incoming = side[2].toLowerCase() === 'incoming';
    if (side[1].toLowerCase() === 'money') t.cash += (num(d.money) ?? 0) * (incoming ? 1 : -1);
    else t[incoming ? 'in' : 'out'].push(...extractItems(d));
  }

  const sales = [], purchases = [];
  for (const t of trades.values()) {
    const base = { timestamp: t.timestamp, logId: `trade:${t.key}`, title: 'Trade' };
    // What the items you received are worth, at market value.
    const inValue = t.in.reduce((s, i) => s + i.qty * (value(i.id) ?? 0), 0);
    if (t.out.length) {
      const total = (t.in.length ? inValue : 0) + t.cash;
      for (const { item, unit } of split(t.out, total, value)) {
        sales.push({ ...base, itemId: item.id, qty: item.qty, unitGross: unit, unitNet: unit, feeEstimated: false });
      }
    }
    if (t.in.length) {
      const total = t.out.length ? inValue : -t.cash;
      for (const { item, unit } of split(t.in, total, value)) {
        purchases.push({ ...base, itemId: item.id, qty: item.qty, unitCost: unit, kind: 'purchase', approximate: t.in.length > 1 });
      }
    }
  }
  return { sales, purchases };
}

/** Share `total` across items by market value (unknown values take the average of the known ones). */
function split(items, total, value) {
  const known = items.map((i) => value(i.id)).filter((v) => v > 0);
  const fallback = known.length ? known.reduce((s, v) => s + v, 0) / known.length : 1;
  const weight = (i) => (value(i.id) > 0 ? value(i.id) : fallback);
  const sum = items.reduce((s, i) => s + i.qty * weight(i), 0);
  return items.map((item) => ({ item, unit: sum > 0 ? (total * weight(item)) / sum : 0 }));
}

/** Convert one item-use log into disposals: [{ itemId, qty, timestamp, logId, title }]. */
export function parseUse(log) {
  return extractItems(log?.data).map((i) => ({
    itemId: i.id, qty: i.qty, timestamp: log.timestamp, logId: log.id, title: log.details?.title ?? '',
  }));
}

/**
 * Match every sale and use against what came in before it, oldest first (FIFO).
 * Each disposal gains `matchedQty`, `cost` (what the matched units cost), `freeQty` (matched units
 * that came free, from finds, crimes, gifts…) and `unknownQty` (units with no purchase or find
 * before them, e.g. bought before the saved log history).
 * Sales also gain `realised` = net proceeds of the matched units minus their cost.
 *
 * @param {object[]} logs   saved logs of any of the types below
 * Trade logs (`tradeIds`) become sales and purchases too; `value(itemId)` splits a trade's money
 * across its items (see parseTrades).
 *
 * @param {object[]} logs   saved logs of any of the types below
 * @param {{ purchaseIds: Set<number>, findIds: Set<number>, saleIds: Set<number>, useIds: Set<number>, tradeIds?: Set<number> }} types
 * @returns {{ acquisitions: object[], sales: object[], uses: object[] }} each newest first
 */
export function buildLedger(logs, { purchaseIds, findIds, saleIds, useIds, tradeIds = new Set() }, fees = {}, value) {
  const trades = parseTrades(logs.filter((l) => tradeIds.has(l.details?.id)), value);
  const events = [
    ...trades.purchases.map((e) => ({ ...e, side: 'in' })),
    ...trades.sales.map((e) => ({ ...e, side: 'out', kind: 'sale' })),
  ];
  for (const log of logs) {
    const t = log.details?.id;
    if (findIds.has(t)) events.push(...parseFind(log).map((e) => ({ ...e, side: 'in' })));
    else if (purchaseIds.has(t)) events.push(...parsePurchase(log).map((e) => ({ ...e, side: 'in' })));
    else if (saleIds.has(t)) events.push(...parseSale(log, fees).map((e) => ({ ...e, side: 'out', kind: 'sale' })));
    else if (useIds.has(t)) events.push(...parseUse(log).map((e) => ({ ...e, side: 'out', kind: 'use' })));
  }
  // Oldest first; at the same second, count arrivals before departures.
  events.sort((a, b) => a.timestamp - b.timestamp || (a.side === 'in' ? -1 : 1) - (b.side === 'in' ? -1 : 1));

  const queues = new Map(); // itemId -> [{ qty, unitCost }] oldest first
  const acquisitions = [], sales = [], uses = [];
  for (const e of events) {
    const q = queues.get(e.itemId) ?? [];
    queues.set(e.itemId, q);
    if (e.side === 'in') {
      q.push({ qty: e.qty, unitCost: e.unitCost, free: e.kind === 'find' });
      acquisitions.push(e);
      continue;
    }
    let remaining = e.qty;
    let cost = 0;
    let freeQty = 0;
    while (remaining > 0 && q.length) {
      const take = Math.min(q[0].qty, remaining);
      cost += take * q[0].unitCost;
      if (q[0].free) freeQty += take;
      remaining -= take;
      q[0].qty -= take;
      if (q[0].qty <= 0) q.shift();
    }
    const out = { ...e, matchedQty: e.qty - remaining, freeQty, unknownQty: remaining, cost };
    delete out.side;
    if (e.kind === 'sale') {
      out.realised = out.unitNet * out.matchedQty - cost;
      sales.push(out);
    } else {
      uses.push(out);
    }
  }
  const newest = (a, b) => b.timestamp - a.timestamp;
  return { acquisitions: acquisitions.sort(newest), sales: sales.sort(newest), uses: uses.sort(newest) };
}

/**
 * Per-item buy/sell/use totals for events from `from` (unix seconds, null = all time) on,
 * for the items `include(itemId)` accepts. Sorted by realised profit, best first.
 */
export function tradeSummary(ledger, { from = null, include = () => true } = {}) {
  const inRange = (e) => (from == null || e.timestamp >= from) && include(e.itemId);
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) {
      rows.set(id, {
        itemId: id, boughtQty: 0, spent: 0, foundQty: 0, soldQty: 0, gross: 0, proceeds: 0,
        matchedQty: 0, matchedProceeds: 0, costOfSold: 0, realised: 0, unknownQty: 0,
        usedQty: 0, usedCost: 0, feeEstimated: false, lastSale: null,
      });
    }
    return rows.get(id);
  };
  for (const a of ledger.acquisitions.filter(inRange)) {
    const r = row(a.itemId);
    if (a.kind === 'find') r.foundQty += a.qty;
    else { r.boughtQty += a.qty; r.spent += a.qty * a.unitCost; }
  }
  for (const s of ledger.sales.filter(inRange)) {
    const r = row(s.itemId);
    r.soldQty += s.qty;
    r.gross += s.qty * s.unitGross;
    r.proceeds += s.qty * s.unitNet;
    r.matchedQty += s.matchedQty;
    r.matchedProceeds += s.matchedQty * s.unitNet;
    r.costOfSold += s.cost;
    r.realised += s.realised;
    r.unknownQty += s.unknownQty;
    r.feeEstimated ||= s.feeEstimated;
    r.lastSale = Math.max(r.lastSale ?? 0, s.timestamp);
  }
  for (const u of ledger.uses.filter(inRange)) {
    const r = row(u.itemId);
    r.usedQty += u.qty;
    r.usedCost += u.cost;
  }
  for (const r of rows.values()) {
    r.avgBuy = r.boughtQty ? r.spent / r.boughtQty : null;
    r.avgSell = r.soldQty ? r.proceeds / r.soldQty : null;
    r.margin = r.costOfSold > 0 ? r.realised / r.costOfSold : null;
  }
  return [...rows.values()].sort((a, b) => b.realised - a.realised);
}

/** Running total of realised profit per UTC day, oldest first: [{ date, t, day, total }]. */
export function realisedByDay(sales) {
  const days = new Map();
  for (const s of sales) {
    const date = new Date(s.timestamp * 1000).toISOString().slice(0, 10);
    days.set(date, (days.get(date) ?? 0) + s.realised);
  }
  let total = 0;
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => {
    total += day;
    return { date, t: Date.parse(date), day, total };
  });
}
