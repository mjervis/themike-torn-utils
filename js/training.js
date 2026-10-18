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

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) ? n : null;
};

/**
 * What an item does for training, from its catalogue name and effect text.
 * @returns {{ energy: number|null, toMax: boolean, happy: number|null, doublesHappy: boolean, jump: boolean }}
 */
export function trainingEffect(item) {
  const name = item?.name ?? '';
  const text = `${item?.effect ?? ''} ${item?.description ?? ''}`;
  const en = /^xanax$/i.test(name) ? { energy: XANAX_ENERGY, toMax: false } : energyEffect(item);
  const doublesHappy = /^ecstasy$/i.test(name) || /doubles? (your )?happ/i.test(text);
  const happy = num(text.match(/happ(?:y|iness) by \+?(\d[\d,]*)/i)?.[1] ?? text.match(/\+?(\d[\d,]*) happ(?:y|iness)/i)?.[1]);
  return {
    energy: en?.energy ?? null,
    toMax: !!en?.toMax,
    happy,
    doublesHappy,
    // Big happy boosts are what make a jump; a single candy isn't one.
    jump: doublesHappy || (happy ?? 0) >= 500,
  };
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
