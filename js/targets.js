// Targets: players you've beaten before, from your own attack history, with where they are now.
// Attacks are saved per player and fetched incrementally; statuses are one profile call per target.

import { meta } from './db.js';

/** Attack results that count as beating the defender. */
export const WIN_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Looted', 'Arrested', 'Bounty']);
/** Results where you went in and didn't win. */
export const LOSS_RESULTS = new Set(['Lost', 'Stalemate', 'Escape', 'Timeout']);

// Re-read a little before the newest saved attack so ones that finished late aren't missed; ids de-duplicate.
const OVERLAP = 5 * 60;

const nowSec = () => Math.floor(Date.now() / 1000);
const attacksKey = (player) => `targets:attacks:${player}`;
const statusKey = (player) => `targets:status:${player}`;

/** Keep just what the Targets page reads, so years of attacks stay small. */
export function trimAttack(a) {
  return {
    id: a.id,
    started: a.started,
    ended: a.ended,
    result: a.result,
    attacker: a.attacker ? { id: a.attacker.id } : null,
    defender: { id: a.defender.id, name: a.defender.name, level: a.defender.level, faction: a.defender.faction?.name ?? null },
    respect: a.respect_gain ?? 0,
    ff: a.modifiers?.fair_fight ?? null,
  };
}

/**
 * Bring the saved attack history up to date: only attacks newer than the last one saved, or the
 * whole history (up to `maxPages`) the first time. `older` walks back past the oldest saved instead.
 */
export async function syncAttacks(db, client, player, { maxPages = 20, older = false, onProgress, now = nowSec() } = {}) {
  const saved = (await meta.get(db, attacksKey(player))) ?? { attacks: [], complete: false, at: null };
  const byId = new Map(saved.attacks.map((a) => [a.id, a]));
  const onPage = (n, page) => onProgress?.(`Reading your attacks… ${n} found (page ${page})`);
  let fetched;
  let complete = saved.complete;
  if (older) {
    const oldest = Math.min(...saved.attacks.map((a) => a.started));
    fetched = await client.attacks({ to: Number.isFinite(oldest) ? oldest : undefined, maxPages, onPage });
    complete = fetched.length < maxPages * 100;
  } else if (saved.attacks.length) {
    const newest = Math.max(...saved.attacks.map((a) => a.started));
    fetched = await client.attacks({ from: newest - OVERLAP, maxPages: 50, onPage });
  } else {
    fetched = await client.attacks({ maxPages, onPage });
    complete = fetched.length < maxPages * 100;
  }
  const before = byId.size;
  for (const a of fetched) byId.set(a.id, trimAttack(a));
  const attacks = [...byId.values()].sort((a, b) => b.started - a.started);
  const value = { attacks, complete, at: now };
  await meta.set(db, attacksKey(player), value);
  return { ...value, added: byId.size - before };
}

export async function savedAttacks(db, player) {
  return (await meta.get(db, attacksKey(player))) ?? null;
}

/**
 * One row per player you've beaten: how often, when last, and how the last win went.
 * Losses count only your own attacks on them that didn't come off.
 */
export function beatenTargets(attacks, me) {
  const rows = new Map();
  for (const a of [...attacks].sort((x, y) => x.started - y.started)) {
    if (a.attacker?.id !== me || !a.defender || a.defender.id === me) continue;
    const won = WIN_RESULTS.has(a.result);
    const lost = LOSS_RESULTS.has(a.result);
    if (!won && !lost) continue;
    const d = a.defender;
    const row = rows.get(d.id) ?? { id: d.id, wins: 0, losses: 0, mugs: 0, lastWin: null };
    // Oldest first, so the newest attack's name, level and faction win.
    Object.assign(row, { name: d.name, level: d.level, faction: d.faction });
    if (won) {
      row.wins++;
      row.lastWin = a.started;
      row.lastResult = a.result;
      row.ff = a.ff;
      row.respect = a.respect;
      if (a.result === 'Mugged') row.mugs++;
    } else {
      row.losses++;
      row.lastLoss = a.started;
    }
    rows.set(d.id, row);
  }
  return [...rows.values()].filter((r) => r.wins > 0);
}

// ---------- mugs ----------
// The attack history says who you mugged but not for how much; the money is in your mug logs.

/** Log types for mugs you made, picked by title (not ones where you were mugged). */
export function isMugLogTitle(title) {
  return /\bmug(s|ged|ging)?\b/i.test(title) && !/\b(receive[ds]?|received|victim|by|defend\w*|lost|lose)\b/i.test(title);
}

const toNum = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/[$,]/g, '')) : v;
  return Number.isFinite(n) ? n : null;
};
const firstOf = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    const n = toNum(v && typeof v === 'object' ? v.id : v);
    if (n != null) return n;
  }
  return null;
};

/**
 * Money and victim from one mug log. Torn doesn't document mug log data, so several field names
 * are accepted; the victim may be missing, in which case it's matched to an attack by time.
 */
export function parseMug(log) {
  const data = log.data ?? {};
  const amount = firstOf(data, ['money_mugged', 'money', 'amount', 'cash', 'mugged', 'value']);
  const victim = firstOf(data, ['defender', 'defender_id', 'target', 'target_id', 'victim', 'victim_id', 'user', 'user_id']);
  return { id: log.id, timestamp: log.timestamp, amount, victim };
}

// A mug log is written as the attack ends; allow for the two clocks being a little apart.
const MUG_MATCH_SECS = 120;

/**
 * Mug money per target: { byTarget: Map(id -> { mugs, money, biggest, lastMug }), total, count, unmatched }.
 * Logs without a victim are matched to your nearest "Mugged" attack that ended within two minutes.
 * Only mugs from `from` (unix seconds) on are counted.
 */
export function mugTotals(mugLogs, attacks, me, from = -Infinity) {
  const mugAttacks = attacks.filter((a) => a.attacker?.id === me && a.result === 'Mugged');
  const used = new Set();
  const byTarget = new Map();
  let total = 0; let count = 0; let unmatched = 0;
  for (const m of mugLogs.map(parseMug).sort((a, b) => a.timestamp - b.timestamp)) {
    if (m.amount == null || m.timestamp < from) continue;
    let victim = m.victim;
    if (victim == null) {
      const best = mugAttacks
        .filter((a) => !used.has(a.id) && Math.abs((a.ended ?? a.started) - m.timestamp) <= MUG_MATCH_SECS)
        .sort((a, b) => Math.abs((a.ended ?? a.started) - m.timestamp) - Math.abs((b.ended ?? b.started) - m.timestamp))[0];
      if (best) { used.add(best.id); victim = best.defender.id; }
    }
    total += m.amount;
    count++;
    if (victim == null) { unmatched++; continue; }
    const t = byTarget.get(victim) ?? { mugs: 0, money: 0, biggest: 0, lastMug: null };
    t.mugs++;
    t.money += m.amount;
    t.biggest = Math.max(t.biggest, m.amount);
    t.lastMug = m.timestamp;
    byTarget.set(victim, t);
  }
  return { byTarget, total, count, unmatched };
}

// Torn writes hospitals abroad as "In a Swiss hospital for 20 mins".
const COUNTRY_BY_ADJECTIVE = {
  mexican: 'Mexico', caymanian: 'Cayman Islands', canadian: 'Canada', hawaiian: 'Hawaii', british: 'United Kingdom',
  argentinian: 'Argentina', argentine: 'Argentina', swiss: 'Switzerland', japanese: 'Japan', chinese: 'China',
  emirati: 'UAE', 'south african': 'South Africa',
};

/**
 * Where a player is and whether you can hit them, from their profile status, as of `now`.
 * kind: okay | hospital | jail | federal | abroad | traveling | gone.
 * A hospital or jail stay whose `until` has passed counts as okay again: they were due out.
 */
export function targetStatus(status, now = nowSec()) {
  if (!status) return null;
  const desc = status.description ?? '';
  const until = status.until || null;
  switch (status.state) {
    case 'Okay':
      return { kind: 'okay', label: 'Okay', location: 'Torn', until: null, ready: true };
    case 'Hospital': {
      const abroad = /^In an? (.+?) hospital/i.exec(desc);
      const location = abroad ? (COUNTRY_BY_ADJECTIVE[abroad[1].toLowerCase()] ?? abroad[1]) : 'Torn';
      if (until && until <= now) return { kind: 'okay', label: 'Out of hospital', location, until, ready: location === 'Torn' };
      return { kind: 'hospital', label: 'Hospital', location, until, ready: false, reason: status.details || null };
    }
    case 'Jail':
      if (until && until <= now) return { kind: 'okay', label: 'Out of jail', location: 'Torn', until, ready: true };
      return { kind: 'jail', label: 'Jail', location: 'Torn', until, ready: false };
    case 'Federal':
      return { kind: 'federal', label: 'Federal jail', location: 'Torn', until, ready: false };
    case 'Abroad':
      return { kind: 'abroad', label: 'Abroad', location: desc.replace(/^In /, '') || 'Abroad', until: null, ready: false };
    case 'Traveling': {
      const back = /^Returning to Torn from (.+)$/i.exec(desc);
      const to = /^Traveling to (.+)$/i.exec(desc);
      const location = back ? `${back[1]} → Torn` : to ? `Torn → ${to[1]}` : desc;
      return { kind: 'traveling', label: back ? 'Flying home' : 'Flying out', location, until, ready: false };
    }
    default: // Fallen, Dormant, Awoken: not someone you can attack
      return { kind: 'gone', label: status.state || 'Unknown', location: '—', until: null, ready: false };
  }
}

const KIND_ORDER = { okay: 0, hospital: 1, jail: 2, traveling: 3, abroad: 4, federal: 5, gone: 6 };

/**
 * Hittable first, then those coming out of hospital or jail soonest, then the rest;
 * unchecked targets after checked ones; ties by most recent win.
 */
export function compareTargets(a, b) {
  const ka = a.where ? KIND_ORDER[a.where.ready ? 'okay' : a.where.kind] : 9;
  const kb = b.where ? KIND_ORDER[b.where.ready ? 'okay' : b.where.kind] : 9;
  if (ka !== kb) return ka - kb;
  if ((ka === 1 || ka === 2) && a.where.until !== b.where.until) return (a.where.until ?? Infinity) - (b.where.until ?? Infinity);
  return (b.lastWin ?? 0) - (a.lastWin ?? 0);
}

/** Keep just what's shown from a profile. */
export function trimProfile(p) {
  return {
    name: p.name, level: p.level, faction_id: p.faction_id ?? null,
    status: p.status, last_action: p.last_action ?? null, life: p.life ?? null,
  };
}

/** Saved statuses: { [targetId]: { at, profile } }. */
export async function savedStatuses(db, player) {
  return (await meta.get(db, statusKey(player))) ?? {};
}

export async function saveStatuses(db, player, statuses) {
  await meta.set(db, statusKey(player), statuses);
}
