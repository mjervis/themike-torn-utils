// Weekly faction gym energy leaderboard, from snapshots of the faction's challenge contributors.
// Torn's `/faction/contributors` gives each member's running total (gym energy, drug overdoses), not
// a weekly figure, so the page saves a snapshot every time it reads them and a week's figure is the
// difference between the snapshots nearest its start and end. Pure functions only; times are unix seconds.

import { summaryText } from './share.js';
import { JUMP_STAT_LIMIT } from './energy.js';

const HOUR = 3600;
const DAY = 24 * HOUR;
/** Snapshots this recent are all kept (one per hour); older ones keep the first of each TCT day. */
const KEEP_HOURLY_DAYS = 14;
const KEEP_DAYS = 180;
/** A snapshot further than this from the week's start or end makes the figures approximate. */
export const SNAP_SLACK = HOUR;

export const BIG_STATS = JUMP_STAT_LIMIT; // 1.2m total battle stats

/** Contributors list → { id: value }. */
export function contributorMap(list = []) {
  const out = {};
  for (const c of list) if (c?.id != null && Number.isFinite(Number(c.value))) out[c.id] = Number(c.value);
  return out;
}

/**
 * Add `snap` ({ at, energy: {id: n}, od: {id: n} }) to the saved snapshots, oldest first. A snapshot
 * within the same hour as the previous one replaces it; older history is thinned to one a day.
 */
export function addSnapshot(snaps = [], snap) {
  const list = snaps.filter((s) => s.at < snap.at);
  const last = list[list.length - 1];
  if (last && Math.floor(last.at / HOUR) === Math.floor(snap.at / HOUR)) list.pop();
  list.push(snap);
  const hourlyFrom = snap.at - KEEP_HOURLY_DAYS * DAY;
  const oldest = snap.at - KEEP_DAYS * DAY;
  const days = new Set();
  return list.filter((s) => {
    if (s.at < oldest) return false;
    if (s.at >= hourlyFrom) return true;
    const day = Math.floor(s.at / DAY);
    if (days.has(day)) return false;
    days.add(day);
    return true;
  });
}

/** The snapshot closest to `t`, or null. */
function nearest(snaps, t, filter = () => true) {
  let best = null;
  for (const s of snaps) {
    if (!filter(s)) continue;
    if (!best || Math.abs(s.at - t) < Math.abs(best.at - t)) best = s;
  }
  return best;
}

/**
 * The pair of snapshots that best covers the week [start, end): the one nearest its start, and the
 * one nearest its end (or the latest, while the week's still going). Null if there's no such pair.
 */
export function weekSnapshots(snaps = [], { start, end, now }) {
  const from = nearest(snaps, start, (s) => s.at < end);
  if (!from) return null;
  const to = end > now
    ? snaps.reduce((a, s) => (!a || s.at > a.at ? s : a), null)
    : nearest(snaps, end, (s) => s.at > from.at);
  if (!to || to.at <= from.at) return null;
  return {
    from: withFirstSeen(snaps, from, to), to,
    early: from.at < start - SNAP_SLACK,  // read before the week began: includes some of the week before
    late: from.at > start + SNAP_SLACK,   // first read after it began: misses energy before that
    short: end <= now && to.at < end - SNAP_SLACK, // last read before the week ended
    over: end <= now && to.at > end + SNAP_SLACK,  // read after it ended: includes some of the next week
  };
}

/**
 * `from`, with anyone missing from it (e.g. who joined the faction since) given their value at the
 * first later read up to `to`, so their running total from before isn't counted as this week's.
 * Their ids are in `firstSeen`.
 */
function withFirstSeen(snaps, from, to) {
  const energy = { ...(from.energy ?? {}) }, od = { ...(from.od ?? {}) };
  const firstSeen = new Set();
  const later = snaps.filter((s) => s.at > from.at && s.at <= to.at).sort((a, b) => a.at - b.at);
  for (const id of Object.keys(to.energy ?? {})) {
    if (energy[id] != null) continue;
    const first = later.find((s) => s.energy?.[id] != null) ?? to;
    energy[id] = first.energy[id];
    if (od[id] == null && first.od?.[id] != null) od[id] = first.od[id];
    firstSeen.add(Number(id));
  }
  for (const id of Object.keys(to.od ?? {})) if (od[id] == null) od[id] = to.od[id];
  return { ...from, energy, od, firstSeen };
}

/**
 * Each member's gym energy and overdoses between two snapshots, split into two leaderboards by total
 * battle stats: `high` (1.2m or more, as ticked in `big`) and `low`. Each is sorted by energy, most first.
 * `joined` marks members who joined the faction after the first snapshot (from `days_in_faction` at `membersAt`).
 * @param {{ from, to, members?: {id, name, level?, position?, days_in_faction?}[], membersAt?: number,
 *   big?: Record<string, boolean>, target?: number }} o
 */
export function leaderboard({ from, to, members = [], membersAt = to.at, big = {}, target = 0 }) {
  const info = new Map(members.map((m) => [Number(m.id), m]));
  const ids = new Set([...Object.keys(to.energy ?? {}), ...Object.keys(to.od ?? {}), ...info.keys()].map(Number));
  const rows = [];
  for (const id of ids) {
    const m = info.get(id);
    // Only current members: anyone who's left has no row in the latest list, and isn't on the board.
    if (members.length && !m) continue;
    const e0 = from.energy?.[id], e1 = to.energy?.[id];
    const o0 = from.od?.[id], o1 = to.od?.[id];
    const energy = Math.max(0, (e1 ?? 0) - (e0 ?? 0));
    const overdoses = Math.max(0, (o1 ?? 0) - (o0 ?? 0));
    rows.push({
      id, name: m?.name ?? `#${id}`, level: m?.level ?? null, position: m?.position ?? null,
      energy, overdoses, big: !!big[id],
      // days_in_faction is whole days as of `membersAt`, so this is a day either way.
      firstSeen: !!from.firstSeen?.has(id),
      joined: m?.days_in_faction != null && membersAt - (m.days_in_faction + 1) * DAY > from.at,
      ofTarget: target > 0 ? energy / target : null,
    });
  }
  const byEnergy = (a, b) => b.energy - a.energy || a.name.localeCompare(b.name);
  const rank = (list) => list.sort(byEnergy).map((r, i) => ({ ...r, rank: i + 1 }));
  const high = rank(rows.filter((r) => r.big));
  const low = rank(rows.filter((r) => !r.big));
  const sum = (list, k) => list.reduce((t, r) => t + r[k], 0);
  const totals = (list) => ({
    members: list.length, energy: sum(list, 'energy'), overdosed: list.filter((r) => r.overdoses > 0).length,
    overdoses: sum(list, 'overdoses'), metTarget: target > 0 ? list.filter((r) => r.energy >= target).length : null,
    zero: list.filter((r) => r.energy === 0).length,
  });
  return { high, low, totals: { all: totals(rows), high: totals(high), low: totals(low) } };
}

const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

/** The two leaderboards as plain text for Torn chat: top `top` of each, then everyone who overdosed. */
export function leaderboardText(board, { label, top = 5 } = {}) {
  const line = (r) => `${r.rank}. ${r.name} ${whole.format(r.energy)}e${r.overdoses ? ' (OD)' : ''}`;
  const part = (title, list) => list.length && [`${title}:`, ...list.slice(0, top).map(line)].join('\n');
  const od = [...board.high, ...board.low].filter((r) => r.overdoses > 0);
  return summaryText([
    `Faction gym energy${label ? ` — ${label}` : ''}: ${whole.format(board.totals.all.energy)}e from ${board.totals.all.members} members`,
    part('1.2m+ stats', board.high),
    part('Under 1.2m stats', board.low),
    od.length && `Overdosed: ${od.map((r) => `${r.name}${r.overdoses > 1 ? ` ×${r.overdoses}` : ''}`).join(', ')}`,
  ]);
}
