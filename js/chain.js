// Chain competition: faction members split into teams, scored on their hits in the faction's chains
// since the competition started. Hits and respect come from Torn's chain reports (public key), which
// list every member's attacks and respect plus each bonus hit. Every hit in the competition week, in a
// chain or not, comes from the faction attack log where the key has faction API access.

import { meta } from './db.js';

/** The Halloween 2,500 chain competition. Prizes are per member for placements; halved if the chain breaks. */
export const COMPETITION = {
  name: 'Halloween 2,500 Chain Competition',
  start: Date.UTC(2026, 9, 25, 14) / 1000, // Sunday 25 Oct 2026, 14:00 TCT
  end: Date.UTC(2026, 10, 1) / 1000, // midnight at the end of Saturday 31 Oct: all hits are counted up to here
  goal: 2500,
  qualify: 30, // hits a member needs for their team payout
  placePrizes: [25e6, 15e6, 10e6, 5e6],
  soulCollector: 100e6, // highest respect from regular hits (bonus hits don't count)
  raffles: [
    { id: 'trick', name: 'Trick or Treat', prize: 50e6, min: 50 },
    { id: 'blood', name: 'Bloodthirsty', prize: 100e6, min: 100 },
  ],
  mvp: { name: 'Pumpkin King / Queen', prize: 50e6 }, // leadership-voted, not computed
};

/**
 * Teams as announced. A member given as { name, id } is matched by Torn id; plain names are matched to
 * faction members loosely, and Teams on the page fixes the rest.
 */
export const DEFAULT_TEAMS = [
  { id: 'vampires', name: 'Vampires', members: ['NR94', 'Adarnaz', 'Ishka', 'Oghmatic', 'BigDaddyJayz', 'Ghostface'] },
  { id: 'reapers', name: 'Reapers', members: ['VMR', 'Ward', 'Falkor', 'Branden', 'RatherAngry', 'Blokka', 'Lil Dixie'] },
  { id: 'demons', name: 'Demons', members: ['Gabe', 'Mugui', 'SneakKeith', 'BorocSiluix', 'Minovate', 'Nonside', 'NPallacR'] },
  { id: 'undead', name: 'Undead', members: ['Drajd', 'Razeil', 'Wolf',
    { name: 'DontTrip', id: 2238049 }, { name: 'THEMikeUK', id: 4505292 }, { name: 'RoadZumBeast', id: 4575668 }] },
];

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Match the announced team names to faction members: { assigned: Map(memberId -> teamId), unmatched: [{ team, name }] }.
 * A member with a Torn id is matched by it; otherwise an exact match (ignoring case, spaces and punctuation) wins; otherwise a member whose name starts with
 * or contains the announced name, but only if exactly one member does.
 */
export function matchTeams(members, teams = DEFAULT_TEAMS) {
  const assigned = new Map();
  const unmatched = [];
  const pending = [];
  const byNorm = new Map(members.map((m) => [norm(m.name), m]));
  const byId = new Map(members.map((m) => [m.id, m]));
  // Ids first, so a loose name match can't take someone already named by id.
  for (const team of teams) {
    for (const entry of team.members) {
      if (entry.id && byId.has(entry.id)) assigned.set(entry.id, team.id);
    }
  }
  for (const team of teams) {
    for (const entry of team.members) {
      if (entry.id && byId.has(entry.id)) continue;
      const name = entry.name ?? entry;
      const exact = byNorm.get(norm(name));
      if (exact && !assigned.has(exact.id)) assigned.set(exact.id, team.id);
      else pending.push({ team: team.id, name });
    }
  }
  for (const p of pending) {
    const n = norm(p.name);
    const free = members.filter((m) => !assigned.has(m.id));
    const starts = free.filter((m) => norm(m.name).startsWith(n));
    const hits = starts.length ? starts : free.filter((m) => norm(m.name).includes(n));
    if (n && hits.length === 1) assigned.set(hits[0].id, p.team);
    else unmatched.push(p);
  }
  return { assigned, unmatched };
}

/** Per-member totals from one chain report: Map(id -> { hits, respect, bonusRespect, bonusHits, losses, assists }). */
export function reportTotals(report) {
  const out = new Map();
  const bonus = new Map();
  for (const b of report?.bonuses ?? []) {
    const t = bonus.get(b.attacker_id) ?? { hits: 0, respect: 0 };
    t.hits++;
    t.respect += b.respect ?? 0;
    bonus.set(b.attacker_id, t);
  }
  for (const a of report?.attackers ?? []) {
    const at = a.attacks ?? {};
    const b = bonus.get(a.id) ?? { hits: 0, respect: 0 };
    out.set(a.id, {
      // A hit that counted towards the chain ends in the target being left, mugged or hospitalised.
      hits: (at.leave ?? 0) + (at.mug ?? 0) + (at.hospitalize ?? 0),
      respect: a.respect?.total ?? 0,
      bonusRespect: b.respect,
      bonusHits: b.hits,
      losses: (at.losses ?? 0) + (at.escapes ?? 0) + (at.draws ?? 0),
      assists: at.assists ?? 0,
    });
  }
  return out;
}

/**
 * The chains that count, and how the competition stands.
 * `reports` are chain reports ({ id, start, end, details: { chain } }); `live` is the faction's current chain.
 * Chains that end before the start don't count. Returns { chains, length, reached, broken, early }:
 * `length` is the longest chain (live count for an ongoing one), `broken` means a chain ended short of
 * the goal before it was reached (prizes halved), `early` that a counted chain started before the start.
 */
export function chainState(reports, live, comp = COMPETITION) {
  const liveId = live?.current > 0 ? live.id : null;
  const chains = reports
    .filter((r) => r && (r.id === liveId || !r.end || r.end >= comp.start))
    .map((r) => {
      const ongoing = r.id === liveId;
      return { id: r.id, start: r.start, end: ongoing ? null : r.end, ongoing, length: ongoing ? Math.max(live.current, r.details?.chain ?? 0) : r.details?.chain ?? 0 };
    })
    .sort((a, b) => a.start - b.start);
  if (liveId && !chains.some((c) => c.id === liveId)) {
    chains.push({ id: liveId, start: live.start, end: null, ongoing: true, length: live.current, noReport: true });
  }
  let reached = false;
  let broken = false;
  for (const c of chains) {
    if (c.length >= comp.goal) { reached = true; break; }
    if (!c.ongoing) broken = true;
  }
  return {
    chains,
    length: Math.max(0, ...chains.map((c) => c.length)),
    reached,
    broken,
    early: chains.some((c) => c.start < comp.start),
  };
}

/** Chain positions that earn bonus respect. */
export const BONUS_HITS = new Set([10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000]);

/** Respect per hit, leaving out bonus hits and their respect; null with no regular hits. */
const perHit = (regularRespect, regularHits) => (regularHits > 0 ? regularRespect / regularHits : null);

/**
 * Each member's hits and respect summed over the given reports: Map(id -> totals as in reportTotals,
 * plus regularRespect and perHit, both leaving out bonus hits).
 */
export function memberTotals(reports) {
  const out = new Map();
  for (const r of reports) {
    for (const [id, t] of reportTotals(r)) {
      const s = out.get(id) ?? { hits: 0, respect: 0, bonusRespect: 0, bonusHits: 0, losses: 0, assists: 0 };
      for (const k of Object.keys(s)) s[k] += t[k];
      out.set(id, s);
    }
  }
  for (const s of out.values()) {
    s.regularRespect = s.respect - s.bonusRespect;
    s.perHit = perHit(s.regularRespect, s.hits - s.bonusHits);
  }
  return out;
}

/** Every bonus hit in the given reports, in chain order: [{ chainId, chain, attackerId, respect }]. */
export function bonusList(reports) {
  return [...reports].sort((a, b) => a.start - b.start)
    .flatMap((r) => (r.bonuses ?? []).map((b) => ({ chainId: r.id, chain: b.chain, attackerId: b.attacker_id, respect: b.respect ?? 0 }))
      .sort((a, b) => a.chain - b.chain));
}

/**
 * Standings: teams ranked by hits per member, with what each member and team is set to win.
 * `assignment` is Map(memberId -> teamId); `names` Map(memberId -> name); `totals` from memberTotals;
 * `allHits` (optional) from weekHits, for every hit in the week whether or not it was in a chain.
 */
export function standings({ teams = DEFAULT_TEAMS, assignment, names, totals, allHits = null, broken = false, comp = COMPETITION }) {
  const factor = broken ? 0.5 : 1;
  const blank = { hits: 0, respect: 0, bonusRespect: 0, bonusHits: 0, losses: 0, assists: 0, regularRespect: 0, perHit: null };
  const memberRow = (id, team) => {
    const t = totals.get(id) ?? blank;
    return { id, name: names.get(id) ?? allHits?.get(id)?.name ?? `#${id}`, team, ...t, qualified: t.hits >= comp.qualify,
      allHits: allHits ? allHits.get(id)?.hits ?? 0 : null };
  };
  const rows = teams.map((team) => {
    const members = [...assignment].filter(([, t]) => t === team.id).map(([id]) => memberRow(id, team.id))
      .sort((a, b) => b.hits - a.hits || b.regularRespect - a.regularRespect || a.name.localeCompare(b.name));
    const hits = members.reduce((s, m) => s + m.hits, 0);
    const qualified = members.filter((m) => m.qualified);
    return { ...team, members, hits, size: members.length, score: members.length ? hits / members.length : 0,
      qualified: qualified.length,
      qualifiedAvg: qualified.length ? qualified.reduce((s, m) => s + m.hits, 0) / qualified.length : null,
      allHits: allHits ? members.reduce((s, m) => s + (m.allHits ?? 0), 0) : null };
  }).sort((a, b) => b.score - a.score || b.hits - a.hits);

  // Teams level on score share the higher place.
  rows.forEach((t, i) => {
    t.place = i > 0 && t.score === rows[i - 1].score ? rows[i - 1].place : i + 1;
    t.prizeEach = (comp.placePrizes[t.place - 1] ?? 0) * factor;
    t.payout = t.prizeEach * t.qualified;
    for (const m of t.members) m.payout = m.qualified ? t.prizeEach : 0;
  });

  const players = rows.flatMap((t) => t.members);
  const onTeam = new Set(players.map((m) => m.id));
  const others = [...totals.keys()].filter((id) => !onTeam.has(id)).map((id) => memberRow(id, null))
    .filter((m) => m.hits > 0).sort((a, b) => b.hits - a.hits);

  const byRespect = [...players].filter((m) => m.regularRespect > 0).sort((a, b) => b.regularRespect - a.regularRespect);
  const raffles = comp.raffles.map((r) => ({ ...r, prize: r.prize * factor, entrants: players.filter((m) => m.hits >= r.min) }));
  return {
    teams: rows,
    others,
    players,
    soulCollector: { prize: comp.soulCollector * factor, leaders: byRespect.slice(0, 5) },
    raffles,
    mvp: { ...comp.mvp, prize: comp.mvp.prize * factor },
    hits: players.reduce((s, m) => s + m.hits, 0),
  };
}

// ---------- saving & syncing ----------
// Finished chains' reports never change, so each is fetched once and kept; the latest report (the
// ongoing chain) and the live chain are fetched on every refresh.

const saveKey = (player) => `chain:${player}`;

export async function savedChain(db, player) {
  return (await meta.get(db, saveKey(player))) ?? null;
}

/**
 * Bring the competition data up to date: faction members (if missing or `members`), the live chain,
 * the latest chain report, and the reports of any chains that finished since the start.
 * `listChains` asks Torn for the finished chain list, needed on first load and when a chain ends.
 */
export async function syncChain(db, client, player, { comp = COMPETITION, members: refreshMembers = false, listChains = false, onProgress, now = Math.floor(Date.now() / 1000) } = {}) {
  const saved = (await savedChain(db, player)) ?? { reports: {}, members: null, finished: null };
  const reports = { ...saved.reports };
  let members = saved.members;
  if (!members || refreshMembers) {
    onProgress?.('Reading faction members…');
    members = (await client.factionMembers()).map((m) => ({ id: m.id, name: m.name, position: m.position, level: m.level }));
  }
  onProgress?.('Reading the chain…');
  const live = await client.chain();
  const latest = await client.chainReport();
  if (latest?.id) reports[latest.id] = trimReport(latest);

  let finished = saved.finished;
  // A chain that ended since the last refresh needs the list re-read.
  const ended = saved.live?.current > 0 && saved.live.id !== (live?.current > 0 ? live.id : null);
  if (listChains || ended || !finished) {
    onProgress?.('Reading finished chains…');
    finished = (await client.chains({ from: comp.start - 86400 })).filter((c) => c.end >= comp.start);
  }
  for (const c of finished) {
    if (reports[c.id]?.end) continue;
    onProgress?.(`Reading the report for the ${c.chain}-hit chain…`);
    reports[c.id] = trimReport(await client.chainReport(c.id));
  }
  const value = { reports, members, finished, live: live ? { ...live, at: now } : null, at: now };
  await meta.set(db, saveKey(player), value);
  return value;
}

/** Keep just what's scored from a chain report. */
export function trimReport(r) {
  return {
    id: r.id, start: r.start, end: r.end, details: { chain: r.details?.chain ?? 0, respect: r.details?.respect ?? 0 },
    bonuses: (r.bonuses ?? []).map((b) => ({ attacker_id: b.attacker_id, chain: b.chain, respect: b.respect })),
    attackers: (r.attackers ?? []).map((a) => ({ id: a.id, respect: { total: a.respect?.total ?? 0 }, attacks: a.attacks ?? {} })),
  };
}

// ---------- every hit in the week ----------
// The faction attack log has every attack by every member, chained or not. It needs a key with
// faction API access, so it's an extra: the competition itself is scored from the chain reports.

/** Attack results where the member beat their target. */
export const HIT_RESULTS = new Set(['Attacked', 'Mugged', 'Hospitalized', 'Arrested', 'Looted', 'Bounty']);

// Re-read a little before the newest saved attack so ones that finished late aren't missed; ids de-duplicate.
const OVERLAP = 5 * 60;
const attacksKey = (player) => `chain:attacks:${player}`;

/** Keep just what's counted from a faction attack. */
export function trimFactionAttack(a) {
  return {
    id: a.id, started: a.started, result: a.result,
    attacker: a.attacker ? { id: a.attacker.id, name: a.attacker.name } : null,
    respect: a.respect_gain ?? 0, chain: a.chain ?? 0,
  };
}

export async function savedFactionAttacks(db, player) {
  return (await meta.get(db, attacksKey(player))) ?? null;
}

/**
 * Bring the saved faction attacks for the competition week up to date: everything from the start the
 * first time, then only attacks newer than the last one saved. Nothing after the end is asked for.
 */
export async function syncFactionAttacks(db, client, player, { comp = COMPETITION, onProgress, now = Math.floor(Date.now() / 1000) } = {}) {
  const saved = (await savedFactionAttacks(db, player)) ?? { attacks: [], at: null };
  const byId = new Map(saved.attacks.map((a) => [a.id, a]));
  const newest = Math.max(comp.start, ...saved.attacks.map((a) => a.started));
  const from = saved.attacks.length ? newest - OVERLAP : comp.start;
  const to = Math.min(now, comp.end);
  if (from < to) {
    const fetched = await client.factionAttacks({
      from, to, maxPages: 200, onPage: (n, page) => onProgress?.(`Reading the faction's attacks… ${n} found (page ${page})`),
    });
    for (const a of fetched) if (a.started >= comp.start && a.started < comp.end) byId.set(a.id, trimFactionAttack(a));
  }
  const value = { attacks: [...byId.values()].sort((a, b) => b.started - a.started), at: now };
  await meta.set(db, attacksKey(player), value);
  return value;
}

/**
 * Every member's hits in the week: Map(id -> { id, name, hits, chainHits, respect, bonusHits, bonusRespect,
 * regularRespect, perHit, attacks, lastHit }). A hit is an attack the member won; `attacks` also counts
 * losses, assists and the rest. A hit at a bonus chain position (10, 25, 50…) is a bonus hit.
 */
export function weekHits(attacks, comp = COMPETITION) {
  const out = new Map();
  for (const a of attacks) {
    if (!a.attacker || a.started < comp.start || a.started >= comp.end) continue;
    const t = out.get(a.attacker.id) ?? { id: a.attacker.id, name: a.attacker.name, hits: 0, chainHits: 0, respect: 0, bonusHits: 0, bonusRespect: 0, attacks: 0, lastHit: null };
    t.attacks++;
    if (HIT_RESULTS.has(a.result)) {
      t.hits++;
      if (a.chain > 0) t.chainHits++;
      t.respect += a.respect;
      if (BONUS_HITS.has(a.chain)) { t.bonusHits++; t.bonusRespect += a.respect; }
      t.lastHit = Math.max(t.lastHit ?? 0, a.started);
    }
    out.set(a.attacker.id, t);
  }
  for (const t of out.values()) {
    t.regularRespect = t.respect - t.bonusRespect;
    t.perHit = perHit(t.regularRespect, t.hits - t.bonusHits);
  }
  return out;
}
