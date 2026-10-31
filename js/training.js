// What training costs: consumables used (Xanax, Ecstasy, energy drinks, erotic DVDs, candy…),
// grouped into happy jumps where they were stacked and then trained in one go.
// Pure functions only — times are unix seconds, and Torn City Time (TCT) is UTC.

import { energyEffect, XANAX_ENERGY } from './energy.js';

const HOUR = 3600;

/** Item types counted as training consumables. */
export const CONSUMABLE_TYPES = new Set(['Drug', 'Energy Drink', 'Booster', 'Candy']);

/** Gym logs closer together than this are one training burst. */
export const BURST_GAP = 30 * 60;
/** A happy item used up to this long before a burst (or during it) makes the burst a jump. */
export const JUMP_LEAD = HOUR;
/** Stacking further back than this from a jump isn't counted towards it. */
export const MAX_STACK = 72 * HOUR;

/** Xanax stacked for a jump: 4 × 250 reaches Torn's 1,000 energy limit for stacking over max. */
export const STACK_XANAX = 4;
/** Booster cooldown assumed for a happy item whose effect text doesn't say (an erotic DVD's is 6h). */
const HAPPY_COOLDOWN = 6;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) ? n : null;
};

/**
 * What an item does for training, from its catalogue name and effect text.
 * @returns {{ energy: number|null, toMax: boolean, happy: number|null, doublesHappy: boolean, jump: boolean, cooldownHours: number|null }}
 */
export function trainingEffect(item) {
  const name = item?.name ?? '';
  const text = `${item?.effect ?? ''} ${item?.description ?? ''}`;
  const en = /^xanax$/i.test(name) ? { energy: XANAX_ENERGY, toMax: false } : energyEffect(item);
  const doublesHappy = /^ecstasy$/i.test(name) || /doubles? (your )?happ/i.test(text);
  const happy = num(text.match(/happ(?:y|iness) by \+?(\d[\d,]*)/i)?.[1] ?? text.match(/\+?(\d[\d,]*) happ(?:y|iness)/i)?.[1]);
  const hours = num(text.match(/booster cooldown by (\d+(?:\.\d+)?) hours?/i)?.[1]);
  const minutes = num(text.match(/booster cooldown by (\d+) minutes?/i)?.[1]);
  return {
    energy: en?.energy ?? null,
    toMax: !!en?.toMax,
    happy,
    doublesHappy,
    // Big happy boosts are what make a jump; a single candy isn't one.
    jump: doublesHappy || (happy ?? 0) >= 500,
    cooldownHours: hours ?? (minutes != null ? minutes / 60 : null),
  };
}

/** The part an item plays in a jump: 'xanax' stacks energy, 'ecstasy' doubles happy, 'happy' adds it (erotic DVD…); else null. */
export function jumpRole(item, effect = trainingEffect(item)) {
  if (/^xanax$/i.test(item?.name ?? '')) return 'xanax';
  if (effect.doublesHappy) return 'ecstasy';
  if (effect.jump && effect.happy) return 'happy';
  return null;
}

/**
 * Jumps that make the most of what you hold. Each stacks `STACK_XANAX` Xanax, uses as many happy
 * items as the booster cooldown limit allows, then Ecstasy to double the happy, and trains.
 * Stock is used before anything is bought, and as many jumps are planned as it takes to use up
 * the jump items held. Happy items are spread evenly rather than piled into the first jump: gains
 * rise with the log of happy, so two middling jumps beat one big one and one bare one.
 *
 * @param {object[]} items  jump items from the catalogue: { id, name, role, happy, cooldownHours, price, qty }
 * @param {{ boosterCapHours: number, maxJumps?: number }} o
 * @returns {{ jumps: object[], more: number, full: object, leftover: { item, qty }[] }}
 *   jumps: { parts: [{ item, stock, buy }], happy, buyCost, stockValue, topUp: { item, qty, cost }|null }
 *   full: the parts and cost of one jump bought entirely at market, for reference
 */
export function planJumps(items, { boosterCapHours, maxJumps = 10 }) {
  const of = (role) => items.filter((i) => i.role === role);
  const cheapest = (list, by = (i) => i.price) => list.filter((i) => i.price).sort((a, b) => by(a) - by(b))[0] ?? null;
  const buyXanax = cheapest(of('xanax'));
  const buyEcstasy = cheapest(of('ecstasy'));
  const buyHappy = cheapest(of('happy'), (i) => i.price / i.happy);
  const cd = (i) => i.cooldownHours ?? HAPPY_COOLDOWN;
  // A booster can be used while the cooldown is still under the limit, so the last one may overshoot it.
  const fits = (hours, i) => hours < boosterCapHours && cd(i) > 0;
  const slotsOf = (i) => (i && boosterCapHours > 0 ? Math.ceil(boosterCapHours / cd(i)) : 0);

  const held = (role) => of(role).filter((i) => i.qty > 0);
  const xanaxHeld = held('xanax').map((i) => ({ item: i, left: i.qty }));
  const ecstasyHeld = held('ecstasy').map((i) => ({ item: i, left: i.qty }));
  const happyUnits = held('happy').sort((a, b) => b.happy - a.happy).flatMap((i) => Array(i.qty).fill(i));
  const count = (list) => list.reduce((t, x) => t + x.left, 0);

  const perJump = slotsOf(happyUnits[happyUnits.length - 1]);
  const needed = Math.max(Math.ceil(count(xanaxHeld) / STACK_XANAX), count(ecstasyHeld), perJump ? Math.ceil(happyUnits.length / perJump) : 0);
  const n = Math.min(needed, maxJumps);

  const jumps = Array.from({ length: n }, () => ({ happyItems: [], hours: 0, happy: 0 }));
  // Biggest happy items first, each to the jump with the least happy that still has booster room.
  const unplacedHappy = [];
  for (const unit of happyUnits) {
    const j = jumps.filter((x) => fits(x.hours, unit)).sort((a, b) => a.happy - b.happy)[0];
    if (!j) { unplacedHappy.push(unit); continue; }
    j.happyItems.push(unit);
    j.hours += cd(unit);
    j.happy += unit.happy;
  }

  const take = (pool, want) => {
    const parts = [];
    for (const p of pool) {
      if (!want) break;
      const q = Math.min(p.left, want);
      if (q) { parts.push({ item: p.item, stock: q, buy: 0 }); p.left -= q; want -= q; }
    }
    return { parts, short: want };
  };
  const out = jumps.map((j) => {
    const parts = [];
    const add = (pool, want, buyItem) => {
      const { parts: got, short } = take(pool, want);
      parts.push(...got);
      if (short && buyItem) {
        const same = parts.find((p) => p.item === buyItem);
        if (same) same.buy += short; else parts.push({ item: buyItem, stock: 0, buy: short });
      }
    };
    add(xanaxHeld, STACK_XANAX, buyXanax);
    const happyCounts = new Map();
    for (const i of j.happyItems) happyCounts.set(i, (happyCounts.get(i) ?? 0) + 1);
    for (const [item, q] of happyCounts) parts.push({ item, stock: q, buy: 0 });
    add(ecstasyHeld, 1, buyEcstasy);

    let topUp = null;
    if (buyHappy) {
      let hours = j.hours;
      let qty = 0;
      while (fits(hours, buyHappy)) { hours += cd(buyHappy); qty++; }
      if (qty) topUp = { item: buyHappy, qty, cost: qty * buyHappy.price, happy: qty * buyHappy.happy };
    }
    return {
      parts,
      happy: j.happy,
      buyCost: parts.reduce((t, p) => t + p.buy * (p.item.price ?? 0), 0),
      stockValue: parts.reduce((t, p) => t + p.stock * (p.item.price ?? 0), 0),
      topUp,
    };
  });

  const leftover = new Map();
  for (const p of [...xanaxHeld, ...ecstasyHeld]) if (p.left) leftover.set(p.item, p.left);
  for (const i of unplacedHappy) leftover.set(i, (leftover.get(i) ?? 0) + 1);

  const fullParts = [
    buyXanax && { item: buyXanax, stock: 0, buy: STACK_XANAX },
    buyHappy && slotsOf(buyHappy) && { item: buyHappy, stock: 0, buy: slotsOf(buyHappy) },
    buyEcstasy && { item: buyEcstasy, stock: 0, buy: 1 },
  ].filter(Boolean);
  return {
    jumps: out,
    more: needed - n,
    full: {
      parts: fullParts,
      happy: buyHappy ? slotsOf(buyHappy) * buyHappy.happy : 0,
      buyCost: fullParts.reduce((t, p) => t + p.buy * p.item.price, 0),
    },
    leftover: [...leftover].map(([item, qty]) => ({ item, qty })),
  };
}

/**
 * Consumables held or used, with how long the stock lasts at the rate used over `days`.
 * @param {Map<number, number>} owned  itemId -> qty held
 * @param {object[]} uses              uses within the range: { itemId, qty }
 * @returns {{ itemId, qty, used, perWeek, daysLeft }[]}  held items first, most used first
 */
export function stockLevels(owned, uses, days) {
  const used = new Map();
  for (const u of uses) used.set(u.itemId, (used.get(u.itemId) ?? 0) + u.qty);
  const ids = new Set([...[...owned].filter(([, q]) => q > 0).map(([id]) => id), ...used.keys()]);
  return [...ids].map((itemId) => {
    const qty = owned.get(itemId) ?? 0;
    const u = used.get(itemId) ?? 0;
    const perDay = days > 0 ? u / days : 0;
    return { itemId, qty, used: u, perWeek: perDay * 7, daysLeft: perDay ? qty / perDay : null };
  }).sort((a, b) => (b.qty > 0) - (a.qty > 0) || b.used - a.used || b.qty - a.qty);
}

/** Group gym sessions (any order) into bursts of training, oldest first. */
export function trainingBursts(sessions, gap = BURST_GAP) {
  const sorted = [...sessions].sort((a, b) => a.timestamp - b.timestamp);
  const bursts = [];
  for (const s of sorted) {
    const last = bursts[bursts.length - 1];
    if (last && s.timestamp - last.end <= gap) {
      last.end = s.timestamp;
      last.sessions.push(s);
    } else {
      bursts.push({ start: s.timestamp, end: s.timestamp, sessions: [s] });
    }
  }
  for (const b of bursts) {
    b.energy = b.sessions.reduce((t, s) => t + (s.energy ?? 0), 0);
    const gains = b.sessions.map((s) => s.gain).filter((g) => g != null);
    b.gain = gains.length ? gains.reduce((t, g) => t + g, 0) : null;
    b.stats = [...new Set(b.sessions.map((s) => s.stat).filter(Boolean))];
  }
  return bursts;
}

/**
 * Cost of each use: what you paid (FIFO-matched) or the market value now. Units with no known
 * purchase are always valued at market and counted in `estimatedQty`.
 * @param {object[]} uses  ledger uses: { itemId, qty, timestamp, cost, unknownQty }
 * @param {(id: number) => number|null} price  market value per unit
 * @param {'paid'|'market'} valueAt
 */
export function costUses(uses, price, valueAt = 'paid') {
  return uses.map((u) => {
    const p = price(u.itemId) ?? 0;
    if (valueAt === 'market') return { ...u, value: u.qty * p, estimatedQty: 0 };
    return { ...u, value: u.cost + u.unknownQty * p, estimatedQty: u.unknownQty };
  });
}

/**
 * Find happy jumps: a training burst with a big happy item (Ecstasy, erotic DVD…) used within
 * `JUMP_LEAD` before it or during it. Everything consumed since the previous burst (up to
 * `MAX_STACK` back) — the stacked Xanax, cans and so on — counts towards the jump.
 *
 * @param {object[]} uses       costed uses (see costUses), any order
 * @param {object[]} bursts     from trainingBursts, oldest first
 * @param {(id: number) => object} effectOf  trainingEffect for an item id
 * @returns {object[]} jumps, newest first: { start, end, stackFrom, energy, gain, stats, sessionIds, uses, cost, estimatedQty }
 */
export function detectJumps(uses, bursts, effectOf) {
  const sorted = [...uses].sort((a, b) => a.timestamp - b.timestamp);
  const jumps = [];
  bursts.forEach((b, i) => {
    const prevEnd = i > 0 ? bursts[i - 1].end : -Infinity;
    const triggered = sorted.some((u) => u.timestamp > Math.max(prevEnd, b.start - JUMP_LEAD) && u.timestamp <= b.end && effectOf(u.itemId)?.jump);
    if (!triggered) return;
    const from = Math.max(prevEnd, b.start - MAX_STACK);
    const stack = sorted.filter((u) => u.timestamp > from && u.timestamp <= b.end);
    jumps.push({
      start: b.start, end: b.end, stackFrom: stack[0]?.timestamp ?? b.start,
      energy: b.energy, gain: b.gain, stats: b.stats, sessionIds: b.sessions.map((s) => s.id),
      uses: stack,
      cost: stack.reduce((t, u) => t + u.value, 0),
      estimatedQty: stack.reduce((t, u) => t + u.estimatedQty, 0),
    });
  });
  return jumps.reverse();
}

/** Where used units came from: bought, free (crimes, finds, gifts) or unknown (no log before the use). */
export function sources(uses) {
  const free = uses.reduce((t, u) => t + (u.freeQty ?? 0), 0);
  const unknown = uses.reduce((t, u) => t + (u.unknownQty ?? 0), 0);
  const qty = uses.reduce((t, u) => t + u.qty, 0);
  return { bought: qty - free - unknown, free, unknown };
}

/** Uses combined per item: [{ itemId, qty, value, estimatedQty, freeQty, unknownQty }], most expensive first. */
export function usesByItem(uses) {
  const map = new Map();
  for (const u of uses) {
    const r = map.get(u.itemId) ?? { itemId: u.itemId, qty: 0, value: 0, estimatedQty: 0, freeQty: 0, unknownQty: 0 };
    r.qty += u.qty;
    r.value += u.value;
    r.estimatedQty += u.estimatedQty;
    r.freeQty += u.freeQty ?? 0;
    r.unknownQty += u.unknownQty ?? 0;
    map.set(u.itemId, r);
  }
  return [...map.values()].sort((a, b) => b.value - a.value);
}

/** Week (starting `weekStart` within any week, e.g. a Monday 00:00 TCT) containing `t`. */
const weekOf = (t, anchor) => anchor + Math.floor((t - anchor) / (7 * 24 * HOUR)) * 7 * 24 * HOUR;

/**
 * Spend, gym energy and gains per week, newest first.
 * @param {number} anchor  any week-start time (unix seconds) to align weeks to
 */
export function weeklyTraining({ uses, sessions, jumps }, anchor) {
  const map = new Map();
  const row = (t) => {
    const start = weekOf(t, anchor);
    if (!map.has(start)) map.set(start, { start, spend: 0, energy: 0, gain: 0, hasGain: false, jumps: 0, estimatedQty: 0 });
    return map.get(start);
  };
  for (const u of uses) { const r = row(u.timestamp); r.spend += u.value; r.estimatedQty += u.estimatedQty; }
  for (const s of sessions) {
    const r = row(s.timestamp);
    r.energy += s.energy ?? 0;
    if (s.gain != null) { r.gain += s.gain; r.hasGain = true; }
  }
  for (const j of jumps) row(j.start).jumps++;
  return [...map.values()].sort((a, b) => b.start - a.start);
}

/** Headline figures for a set of uses, sessions and jumps. */
export function trainingTotals({ uses, sessions, jumps }) {
  const spend = uses.reduce((t, u) => t + u.value, 0);
  const energy = sessions.reduce((t, s) => t + (s.energy ?? 0), 0);
  const withGain = sessions.filter((s) => s.gain != null);
  const gain = withGain.length ? withGain.reduce((t, s) => t + s.gain, 0) : null;
  const jumpIds = new Set(jumps.flatMap((j) => j.sessionIds ?? []));
  const jumpEnergy = jumps.reduce((t, j) => t + j.energy, 0);
  const jumpGain = jumps.every((j) => j.gain == null) ? null : jumps.reduce((t, j) => t + (j.gain ?? 0), 0);
  const jumpCost = jumps.reduce((t, j) => t + j.cost, 0);
  // Gains per energy outside jumps, to show what a jump is worth over ordinary training.
  const other = withGain.filter((s) => !jumpIds.has(s.id));
  const otherEnergy = other.reduce((t, s) => t + (s.energy ?? 0), 0);
  const otherGain = other.reduce((t, s) => t + s.gain, 0);
  return {
    spend, energy, gain,
    perEnergy: energy ? spend / energy : null,
    perGain: gain ? spend / gain : null,
    jumps: jumps.length, jumpEnergy, jumpGain, jumpCost,
    jumpGainPerEnergy: jumpGain != null && jumpEnergy ? jumpGain / jumpEnergy : null,
    otherGainPerEnergy: otherEnergy ? otherGain / otherEnergy : null,
    estimatedQty: uses.reduce((t, u) => t + u.estimatedQty, 0),
  };
}
