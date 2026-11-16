// Organised Crime planning: which free faction member to put in each open OC slot. Pure functions
// only — times are unix seconds.
//
// Torn only reports a checkpoint pass rate (CPR) for a member in a slot they've joined (an empty slot
// shows the key owner's own CPR), so each member's CPR for a crime and role is read from the faction's
// OCs: the most recent slot they were in for that role. Free members are then matched to open slots
// with an optimal assignment (Hungarian method): fill as many slots as possible with members at or
// above the minimum CPR, then prefer higher-level OCs (or the best pass rates), then OCs nearest to
// starting.

const DAY = 86400;

export const DEFAULTS = {
  minCpr: 70,          // % — don't recommend a member below this pass rate for a slot
  prioritise: 'level', // 'level': higher-level OCs first; 'cpr': best pass rates first
  activeDays: 3,       // leave out members not active for this many days
  historyDays: 90,     // how far back the first load reads completed OCs
};

const OPEN = new Set(['Recruiting', 'Planning']);

/** A slot's label, e.g. "Muscle #2", and its role without the number, e.g. "Muscle". */
export function slotLabel(slot) {
  const label = slot.position_info?.label
    ?? (slot.position_number ?? slot.position_info?.number ? `${slot.position} #${slot.position_number ?? slot.position_info.number}` : slot.position);
  return String(label ?? '?');
}
export const roleOf = (label) => String(label).replace(/\s*#\d+$/, '');

const cprOf = (slot) => slot.checkpoint_pass_rate ?? slot.success_chance ?? null;

/**
 * Every member's most recent CPR for each crime and role, from the slots they've been in:
 * Map(memberId → Map(`crime|label` → { cpr, at, crime, difficulty, label, role })).
 * Expired OCs report 0 and are skipped. `self` (the key owner) also gets the CPR Torn shows them for
 * empty slots in open OCs, as of `now`.
 */
export function cprHistory(crimes, { self = null, now = Date.now() / 1000 } = {}) {
  const out = new Map();
  const put = (id, crime, slot, cpr, at) => {
    if (cpr == null || !Number.isFinite(+cpr)) return;
    const label = slotLabel(slot);
    const key = `${crime.name}|${label}`;
    let m = out.get(id);
    if (!m) out.set(id, m = new Map());
    const was = m.get(key);
    if (!was || at >= was.at) m.set(key, { cpr: +cpr, at, crime: crime.name, difficulty: crime.difficulty, label, role: roleOf(label) });
  };
  for (const c of crimes) {
    if (c.status === 'Expired') continue;
    for (const s of c.slots ?? []) {
      if (s.user?.id != null) put(s.user.id, c, s, cprOf(s), s.user.joined_at ?? c.executed_at ?? c.created_at ?? 0);
      else if (self != null && OPEN.has(c.status)) put(self, c, s, cprOf(s), now);
    }
  }
  return out;
}

/** A member's CPR for a slot: the same crime and label, else the same crime and role (e.g. another Muscle). */
export function lookupCpr(history, memberId, crimeName, label) {
  const m = history.get(memberId);
  if (!m) return null;
  const exact = m.get(`${crimeName}|${label}`);
  if (exact) return { ...exact, exact: true };
  const role = roleOf(label);
  let best = null;
  for (const r of m.values()) {
    if (r.crime === crimeName && r.role === role && (!best || r.at > best.at)) best = r;
  }
  return best ? { ...best, exact: false } : null;
}

/** Empty slots in OCs still recruiting or planning. */
export function openSlots(crimes) {
  const out = [];
  for (const c of crimes) {
    if (!OPEN.has(c.status)) continue;
    const slots = c.slots ?? [];
    const filled = slots.filter((s) => s.user?.id != null).length;
    slots.forEach((s, i) => {
      if (s.user?.id != null) return;
      const label = slotLabel(s);
      out.push({
        key: `${c.id}:${i}`, crimeId: c.id, crime: c.name, difficulty: c.difficulty ?? 0, status: c.status,
        label, role: roleOf(label), filled, total: slots.length, expires: c.expired_at ?? null,
        item: s.item_requirement ? { id: s.item_requirement.id, reusable: !!s.item_requirement.is_reusable } : null,
      });
    });
  }
  return out;
}

/**
 * Minimum-cost assignment of rows to columns (Hungarian method, O(n²m)) for an n×m cost matrix with
 * n ≤ m. Returns, for each row, the column it's assigned to.
 */
export function hungarian(cost) {
  const n = cost.length;
  const m = n ? cost[0].length : 0;
  if (!n) return [];
  if (n > m) throw new Error('hungarian: more rows than columns');
  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j]: row assigned to column j (1-based), 0 = none
  const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const rowTo = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rowTo[p[j] - 1] = j - 1;
  return rowTo;
}

/**
 * The plan: which free member to put in each open slot.
 *  { assignments, unfilled, unplaced, skipped, free, slots, crimes }
 * `members` is the faction's member list (with is_in_oc, last_action, status); anyone in an OC, or in a
 * slot of an open one, isn't free. Members not active for `activeDays` days, or in federal jail, are
 * skipped. `exp` is the faction's member ids by crime experience, highest first (optional, for ties).
 */
export function ocPlan(crimes, members, {
  minCpr = DEFAULTS.minCpr, prioritise = DEFAULTS.prioritise, activeDays = DEFAULTS.activeDays,
  self = null, exp = [], now = Date.now() / 1000,
} = {}) {
  const history = cprHistory(crimes, { self, now });
  const slots = openSlots(crimes);
  const inOpen = new Set();
  for (const c of crimes) if (OPEN.has(c.status)) for (const s of c.slots ?? []) if (s.user?.id != null) inOpen.add(s.user.id);
  const expRank = new Map(exp.map((id, i) => [id, i + 1]));

  const free = [];
  const skipped = [];
  for (const m of members) {
    if (m.is_in_oc || inOpen.has(m.id)) continue;
    const row = {
      id: m.id, name: m.name, level: m.level ?? null, position: m.position ?? null,
      lastAction: m.last_action?.timestamp ?? null, status: m.status?.state ?? null, expRank: expRank.get(m.id) ?? null,
    };
    const idle = row.lastAction != null && now - row.lastAction > activeDays * DAY;
    if (idle) skipped.push({ ...row, reason: `not active for ${Math.floor((now - row.lastAction) / DAY)} days` });
    else if (row.status === 'Federal') skipped.push({ ...row, reason: 'in federal jail' });
    else free.push(row);
  }

  // Score every free member for every open slot they're known to pass.
  const maxDiff = Math.max(1, ...slots.map((s) => s.difficulty));
  const score = (slot, cpr, member) => {
    // Filling a slot always beats leaving it empty; then level or CPR; then the OC nearest to starting;
    // then the more experienced member.
    const level = slot.difficulty / maxDiff;
    const near = slot.total ? slot.filled / slot.total : 0;
    const expBonus = member.expRank ? 1 / (1 + member.expRank) : 0;
    return 1e6 + (prioritise === 'cpr' ? cpr * 1000 + level * 100 : level * 1e5 + cpr * 100) + near * 10 + expBonus;
  };
  const cands = slots.map((slot) => free
    .map((member) => ({ member, rec: lookupCpr(history, member.id, slot.crime, slot.label) }))
    .filter((c) => c.rec)
    .sort((a, b) => b.rec.cpr - a.rec.cpr || (a.member.expRank ?? 1e9) - (b.member.expRank ?? 1e9)));

  const weight = slots.map((slot, i) => free.map((member) => {
    const c = cands[i].find((x) => x.member.id === member.id);
    return c && c.rec.cpr >= minCpr ? score(slot, c.rec.cpr, member) : 0;
  }));

  // Hungarian needs rows ≤ columns: rows are whichever of slots and members there are fewer of.
  const pairs = []; // [slotIndex, memberIndex]
  if (slots.length && free.length) {
    const top = Math.max(...weight.flat());
    const bySlot = slots.length <= free.length;
    const cost = bySlot
      ? weight.map((row) => row.map((w) => top - w))
      : free.map((_, j) => slots.map((_, i) => top - weight[i][j]));
    hungarian(cost).forEach((col, row) => {
      const [i, j] = bySlot ? [row, col] : [col, row];
      if (col >= 0 && weight[i][j] > 0) pairs.push([i, j]);
    });
  }

  const placed = new Map(pairs.map(([i, j]) => [i, j]));
  const taken = new Set(pairs.map(([, j]) => free[j].id));
  const order = (a, b) => b.difficulty - a.difficulty || b.filled / b.total - a.filled / a.total
    || (a.expires ?? Infinity) - (b.expires ?? Infinity) || a.crimeId - b.crimeId || a.key.localeCompare(b.key);

  const assignments = [];
  const unfilled = [];
  slots.forEach((slot, i) => {
    const others = (j) => cands[i].filter((c) => c.member.id !== (j == null ? null : free[j].id));
    if (placed.has(i)) {
      const j = placed.get(i);
      const rec = cands[i].find((c) => c.member.id === free[j].id).rec;
      assignments.push({
        ...slot, member: free[j], cpr: rec.cpr, cprAt: rec.at, exact: rec.exact,
        alternatives: others(j).filter((c) => c.rec.cpr >= minCpr).slice(0, 3)
          .map((c) => ({ member: c.member, cpr: c.rec.cpr, placed: taken.has(c.member.id) })),
      });
    } else {
      unfilled.push({
        ...slot,
        // The best free members for the slot: below the minimum, or already placed elsewhere.
        candidates: cands[i].slice(0, 3).map((c) => ({ member: c.member, cpr: c.rec.cpr, placed: taken.has(c.member.id) })),
      });
    }
  });
  assignments.sort(order);
  unfilled.sort(order);

  // Free members left over: the OCs they're known to pass, for spawning a new one.
  const unplaced = free.filter((m) => !taken.has(m.id)).map((m) => {
    const best = new Map();
    for (const r of history.get(m.id)?.values() ?? []) {
      if (r.cpr < minCpr) continue;
      const k = `${r.crime}|${r.role}`;
      if (!best.has(k) || r.cpr > best.get(k).cpr) best.set(k, r);
    }
    const known = [...best.values()].sort((a, b) => b.difficulty - a.difficulty || b.cpr - a.cpr);
    return { ...m, known: known.slice(0, 3), anyCpr: history.has(m.id) };
  }).sort((a, b) => (b.known[0]?.difficulty ?? -1) - (a.known[0]?.difficulty ?? -1) || a.name.localeCompare(b.name));

  const crimeIds = new Set(slots.map((s) => s.crimeId));
  return { assignments, unfilled, unplaced, skipped, free, slots, crimes: crimeIds.size, history };
}
