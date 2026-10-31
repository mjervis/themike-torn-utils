// Halloween Trick or Treat: how often your attacks drop a treat, and how often a multiplier
// upgrade (Doubler, Tripler…) turns one attack into 2, 3 or more treats.
// Attacks come from the saved attack history (shared with Targets); treats from your treat logs.

/** The event runs for a week from 25 Oct, starting at a different time for each player. */
export const EVENT_START_DAY = { month: 9, day: 25 }; // 0-based month: October
export const EVENT_DAYS = 7;
export const DEFAULT_START_TIME = '11:30';

/** Event start and end (unix seconds) for a "HH:MM" TCT start time on 25 Oct of `year`. */
export function eventWindow(startTime = DEFAULT_START_TIME, year = new Date().getUTCFullYear()) {
  const [h, m] = /^(\d{1,2}):(\d{2})$/.test(startTime) ? startTime.split(':').map(Number) : DEFAULT_START_TIME.split(':').map(Number);
  const start = Date.UTC(year, EVENT_START_DAY.month, EVENT_START_DAY.day, h, m) / 1000;
  return { start, end: start + EVENT_DAYS * 86400 };
}

/** Log types for treats you collected, picked by title. */
export function isTreatLogTitle(title) {
  return /\b(treats?|trick or treat|halloween)\b/i.test(title) && !/\b(basket|bought|buy|purchase|sell|sold|upgrade)\b/i.test(title);
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
 * Treats and victim from one treat log. Torn doesn't document these logs, so several field names
 * are accepted; a log with no count is one treat, and one with no victim is matched to an attack by time.
 */
export function parseTreat(log) {
  const data = log.data ?? {};
  let treats = firstOf(data, ['treats', 'treat', 'treats_gained', 'amount', 'quantity', 'qty', 'candy', 'gained']);
  if (treats == null && Array.isArray(data.items)) {
    const qty = data.items.reduce((t, i) => t + (toNum(i?.qty ?? i?.quantity) ?? 0), 0);
    if (qty > 0) treats = qty;
  }
  const victim = firstOf(data, ['defender', 'defender_id', 'target', 'target_id', 'victim', 'victim_id', 'user', 'user_id']);
  return { id: log.id, timestamp: log.timestamp, treats: treats ?? 1, victim };
}

// A treat log is written as the attack ends; allow for the two clocks being a little apart.
const TREAT_MATCH_SECS = 120;

const dayOf = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Treats per attack you started between `start` and `end`:
 *  { attacks: [{ ...attack, treats }], total, withTreat, treats, dist: Map(treats -> attacks), byDay, unmatched }
 * Each treat log goes to the nearest of your attacks that ended within two minutes of it (on the
 * named player, if the log names one); several logs on one attack add up. Logs that match no
 * attack are counted in `unmatched` and left out of the percentages. `include` narrows the attacks
 * counted (e.g. wins only) after matching, so treats from the others aren't reported as unmatched.
 */
export function treatStats(attacks, treatLogs, me, { start = -Infinity, end = Infinity, include = () => true } = {}) {
  let mine = attacks
    .filter((a) => a.attacker?.id === me && a.defender?.id !== me && a.started >= start && a.started < end)
    .map((a) => ({ ...a, treats: 0 }));
  const unmatched = { logs: 0, treats: 0 };
  const at = (a) => a.ended ?? a.started;
  for (const t of treatLogs.map(parseTreat)) {
    if (t.timestamp < start - TREAT_MATCH_SECS || t.timestamp >= end + TREAT_MATCH_SECS) continue;
    const best = mine
      .filter((a) => (t.victim == null || a.defender.id === t.victim) && Math.abs(at(a) - t.timestamp) <= TREAT_MATCH_SECS)
      .sort((a, b) => Math.abs(at(a) - t.timestamp) - Math.abs(at(b) - t.timestamp))[0];
    if (best) best.treats += t.treats;
    else { unmatched.logs++; unmatched.treats += t.treats; }
  }
  mine = mine.filter(include);
  const dist = new Map();
  const days = new Map();
  for (const a of mine) {
    dist.set(a.treats, (dist.get(a.treats) ?? 0) + 1);
    const d = days.get(dayOf(a.started)) ?? { date: dayOf(a.started), attacks: 0, withTreat: 0, treats: 0, multiplied: 0 };
    d.attacks++;
    if (a.treats > 0) d.withTreat++;
    if (a.treats > 1) d.multiplied++;
    d.treats += a.treats;
    days.set(d.date, d);
  }
  const withTreat = mine.filter((a) => a.treats > 0).length;
  return {
    attacks: mine.sort((a, b) => b.started - a.started),
    total: mine.length,
    withTreat,
    multiplied: mine.filter((a) => a.treats > 1).length,
    treats: mine.reduce((t, a) => t + a.treats, 0),
    dist: new Map([...dist].sort((a, b) => a[0] - b[0])),
    byDay: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    unmatched,
  };
}
