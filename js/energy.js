// Weekly gym energy tracking and a booster plan to hit a faction's training requirement.
// Pure functions only — times are unix seconds, and Torn City Time (TCT) is UTC.

const HOUR = 3600;
const DAY = 24 * HOUR;

export const DEFAULTS = {
  target: 3000,         // gym energy per week
  weekStartDay: 1,      // 0 = Sunday … 6 = Saturday (TCT)
  weekStartHour: 0,     // TCT hour the week rolls over
  reserve: 0,           // energy kept back for attacks etc. this week
  offlineHours: 8,      // longest stretch per day without logging in (sleep)
  useRefills: true,
  useXanax: true,
  useCans: true,
  allowBuying: true,
  xanaxCooldownHours: 8, // Torn's drug cooldown for Xanax is 6–8h; plan for the worst case
  boosterCapHours: 24,   // booster cooldown ceiling (faction/company perks can raise it)
};

export const XANAX_ENERGY = 250;
const ATTACK_ENERGY = 25;

/** Personal stats read at week start and now (max 10 per call). */
export const WEEK_STATS = ['xantaken', 'lsdtaken', 'energydrinkused', 'refills', 'boostersused',
  'attackswon', 'attackslost', 'attacksdraw', 'yourunaway'];

/** The week containing `now`, starting on `day` at `hour` TCT. */
export function weekWindow(now, day = DEFAULTS.weekStartDay, hour = DEFAULTS.weekStartHour) {
  const midnight = Math.floor(now / DAY) * DAY;
  const weekday = new Date(midnight * 1000).getUTCDay();
  let start = midnight - ((weekday - day + 7) % 7) * DAY + hour * HOUR;
  if (start > now) start -= 7 * DAY;
  return { start, end: start + 7 * DAY };
}

export const isGymLogTitle = (title) => /\bgym\b.*\btrain/i.test(title ?? '');

const num = (v) => {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) ? n : null;
};

/**
 * Energy spent per gym log. Torn doesn't document log `data`, so accept a few field names and
 * fall back to trains × the gym's energy cost.
 * @returns {{ id, timestamp, energy: number|null, stat: string|null, trains: number|null }[]}
 */
export function gymSessions(logs, gymCost = {}) {
  return logs.map((l) => {
    const d = l.data ?? {};
    const trains = num(d.trains ?? d.times);
    let energy = num(d.energy_used ?? d.energy ?? d.energy_spent);
    if (energy == null && trains != null && gymCost[d.gym]) energy = trains * gymCost[d.gym];
    const stat = (l.details?.title ?? '').match(/strength|speed|defen[cs]e|dexterity/i)?.[0]?.toLowerCase() ?? null;
    return { id: l.id, timestamp: l.timestamp, energy, stat, trains, gain: statGain(d), happy: num(d.happy_used ?? d.happy) };
  });
}

const STATS = ['strength', 'speed', 'defense', 'defence', 'dexterity'];

/** Battle stats gained in one gym log, from `<stat>_increased` or `<stat>_after - <stat>_before`. */
export function statGain(data = {}) {
  for (const s of STATS) {
    const inc = num(data[`${s}_increased`] ?? data[`${s}_gained`] ?? data[`${s}_increase`]);
    if (inc != null) return inc;
    const before = num(data[`${s}_before`]), after = num(data[`${s}_after`]);
    if (before != null && after != null) return after - before;
  }
  return num(data.stat_increase ?? data.gain ?? data.gained ?? data.increased);
}

/** Gym energy per TCT day of the week window. */
export function dailyTotals(sessions, start) {
  const days = Array.from({ length: 7 }, (_, i) => ({ start: start + i * DAY, energy: 0 }));
  for (const s of sessions) {
    const i = Math.floor((s.timestamp - start) / DAY);
    if (i >= 0 && i < 7) days[i].energy += s.energy ?? 0;
  }
  return days;
}

/** Change in each personal stat between week start and now (null when either side is missing). */
export function statDeltas(before = {}, after = {}) {
  const out = {};
  for (const k of WEEK_STATS) out[k] = before[k] != null && after[k] != null ? after[k] - before[k] : null;
  return out;
}

/** Energy put into attacks this week: every attack you start costs 25. */
export function attackEnergy(deltas) {
  const parts = ['attackswon', 'attackslost', 'attacksdraw', 'yourunaway'].map((k) => deltas[k]);
  if (parts.every((p) => p == null)) return null;
  return parts.reduce((t, p) => t + (p ?? 0), 0) * ATTACK_ENERGY;
}

/** Where the week stands against an even pace. */
export function pace({ target, spent, start, end, now }) {
  const elapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const expected = target * elapsed;
  return { elapsed, expected, ahead: spent - expected, remaining: Math.max(0, target - spent) };
}

/**
 * What an item does for energy, from its catalogue effect text, e.g.
 * "Increases energy by 25 and booster cooldown by 2 hours."
 * @returns {{ kind: 'drug'|'booster', energy: number|null, toMax: boolean, cooldownHours: number }|null}
 */
export function energyEffect(item) {
  if (!item) return null;
  const name = item.name ?? '';
  const text = `${item.effect ?? ''} ${item.description ?? ''}`;
  if (/^xanax$/i.test(name)) return { kind: 'drug', energy: XANAX_ENERGY, toMax: false, cooldownHours: 0 };
  if (item.type === 'Drug') return null; // only Xanax is planned for; other drugs share its cooldown
  const toMax = /(refill|replenish|restore)s?[^.]*\benergy\b/i.test(text) || /feathery hotel coupon/i.test(name);
  const energy = num(text.match(/energy by \+?(\d[\d,]*)/i)?.[1] ?? text.match(/\+?(\d[\d,]*) energy/i)?.[1]);
  if (!toMax && !energy) return null;
  const hours = num(text.match(/booster cooldown by (\d+(?:\.\d+)?) hours?/i)?.[1]);
  const minutes = num(text.match(/booster cooldown by (\d+) minutes?/i)?.[1]);
  const cooldownHours = hours ?? (minutes != null ? minutes / 60 : toMax ? 6 : 2);
  return { kind: 'booster', energy: toMax ? null : energy, toMax, cooldownHours };
}

/** TCT midnights strictly between `now` and `end`: each one brings a fresh daily refill. */
export function midnightsBetween(now, end) {
  const out = [];
  for (let m = Math.floor(now / DAY) * DAY + DAY; m < end; m += DAY) out.push(m);
  return out;
}

/**
 * Plan the rest of the week.
 *
 * @param {object} p
 * @param {number} p.now, p.end           unix seconds
 * @param {number} p.needed               gym energy still to spend this week
 * @param {{ current, maximum, increment, interval, full_time }} p.bar   energy bar
 * @param {{ drug: number, booster: number }} p.cooldowns   seconds remaining
 * @param {boolean} p.refillUsed          today's energy refill already used
 * @param {{ id, name, effect, price, owned }[]} p.items    candidate energy items
 * @param {object} p.options              DEFAULTS-shaped settings
 */
export function plan({ now, end, needed, bar, cooldowns, refillUsed, items, options }) {
  const o = { ...DEFAULTS, ...options };
  const hoursLeft = Math.max(0, (end - now) / HOUR);
  const max = bar.maximum;
  const perHour = bar.interval ? (bar.increment * HOUR) / bar.interval : 0;
  const fillHours = perHour ? max / perHour : Infinity;

  // Natural regen stops at the cap, so a long offline stretch wastes whatever comes after the bar fills.
  const wastedPerDay = Math.max(0, o.offlineHours - fillHours) * perHour;
  const regen = Math.max(0, perHour * hoursLeft - wastedPerDay * (hoursLeft / 24));
  const natural = Math.max(0, bar.current + regen - o.reserve);

  const result = {
    needed, hoursLeft, perHour, fillHours, natural, regen, wastedPerDay,
    allocations: [], steps: [], boosted: 0, shortfall: 0, spare: 0,
  };

  let gap = needed - natural;
  if (gap <= 0) {
    result.spare = -gap;
  } else {
    // Daily refills: points, not cash, so they go first when allowed.
    if (o.useRefills) {
      const times = [...(refillUsed ? [] : [now]), ...midnightsBetween(now, end)];
      const n = Math.min(times.length, Math.ceil(gap / max));
      if (n > 0) {
        result.allocations.push({ kind: 'refill', label: 'Energy refill', count: n, energyEach: max, times: times.slice(0, n) });
        gap -= n * max;
      }
    }

    // Use what you already hold first, then buy whatever is cheapest per energy.
    // Xanax is limited by drug cooldown slots, boosters by booster cooldown hours.
    const slots = [];
    for (let t = now + (cooldowns.drug ?? 0); t < end; t += o.xanaxCooldownHours * HOUR) slots.push(t);
    const boosterHours = Math.max(0, o.boosterCapHours - (cooldowns.booster ?? 0) / HOUR) + hoursLeft;

    const candidates = items.filter((i) =>
      (i.effect?.kind === 'drug' && o.useXanax) || (i.effect?.kind === 'booster' && o.useCans));
    const options = candidates.flatMap((item) => {
      const energyEach = item.effect.kind === 'drug' ? XANAX_ENERGY : item.effect.toMax ? max : item.effect.energy;
      const base = { item, energyEach, perEnergy: perEnergy(item.price, energyEach), perHour: energyEach / (item.effect.cooldownHours || 1) };
      return [
        ...(item.owned ? [{ ...base, owned: true, limit: item.owned }] : []),
        ...(o.allowBuying && item.price ? [{ ...base, owned: false, limit: Infinity }] : []),
      ];
    });
    const cheapest = [...options].sort((a, b) => (b.owned - a.owned) ||
      ((a.perEnergy ?? Infinity) - (b.perEnergy ?? Infinity)) || (b.energyEach - a.energyEach));
    let best = allocate(cheapest, gap, slots, boosterHours);
    if (best.gap > 0) {
      // Cheap small cans can burn the booster cooldown before the target is met;
      // when that happens, favour the most energy per hour of cooldown instead.
      const dense = [...options].sort((a, b) => (b.owned - a.owned) || (b.perHour - a.perHour) ||
        ((a.perEnergy ?? Infinity) - (b.perEnergy ?? Infinity)));
      const alt = allocate(dense, gap, slots, boosterHours);
      if (alt.gap < best.gap) best = alt;
    }
    gap = best.gap;
    result.allocations.push(...best.allocations);
    result.boosted = result.allocations.reduce((t, a) => t + a.count * a.energyEach, 0);
    if (gap > 0) result.shortfall = gap;
    else result.spare = -gap;
  }

  result.steps = buildSteps(result, { now, bar, cooldowns, o });
  return result;
}

const perEnergy = (price, energy) => (price && energy ? price / energy : null);

/** Fill `gap` from options in the given order, within Xanax slots and booster cooldown hours. */
function allocate(options, gap, slots, boosterHours) {
  let slotsLeft = slots.length;
  const byItem = new Map();
  for (const opt of options) {
    if (gap <= 0) break;
    const { item } = opt;
    const isDrug = item.effect.kind === 'drug';
    const room = isDrug ? slotsLeft : Math.floor(boosterHours / item.effect.cooldownHours);
    const n = Math.min(opt.limit, room, Math.ceil(gap / opt.energyEach));
    if (n <= 0) continue;
    if (isDrug) slotsLeft -= n; else boosterHours -= n * item.effect.cooldownHours;
    gap -= n * opt.energyEach;
    const a = byItem.get(item.id) ?? {
      kind: isDrug ? 'xanax' : 'booster', label: item.name, count: 0, buy: 0, energyEach: opt.energyEach,
      owned: item.owned ?? 0, price: item.price, perEnergy: opt.perEnergy, cooldownHours: item.effect.cooldownHours,
      toMax: item.effect.toMax,
    };
    a.count += n;
    if (!opt.owned) a.buy += n;
    if (isDrug) a.times = slots.slice(0, a.count);
    byItem.set(item.id, a);
  }
  return { gap, allocations: [...byItem.values()] };
}

function buildSteps(r, { now, bar, cooldowns, o }) {
  const steps = [];
  const stillNeeded = r.needed > 0;

  if (stillNeeded && bar.current > 0) {
    const amount = Math.min(bar.current, r.needed);
    steps.push({ at: now, kind: 'train',
      title: amount < bar.current ? `Train ${amount} energy now — that meets your target` : `Train your ${bar.current} energy now`,
      detail: bar.current >= bar.maximum ? 'You\'re at full energy, so natural regen is currently being wasted.' : null });
  }

  let boosterRoomNow = o.boosterCapHours - (cooldowns.booster ?? 0) / HOUR;
  for (const a of r.allocations) {
    if (a.kind === 'refill') {
      a.times.forEach((t, i) => steps.push({
        at: t, kind: 'refill',
        title: t === now ? 'Use today\'s energy refill' : 'Use that day\'s energy refill',
        detail: `+${a.energyEach} (refills to max). Train down to 0 first so nothing is lost, and use it before 00:00 TCT.` +
          (i === 0 && a.count > 1 ? ` ${a.count} refills planned this week.` : ''),
        when: t === now ? 'Today' : null,
      }));
    } else if (a.kind === 'xanax') {
      const { buy } = a;
      a.times.forEach((t, i) => steps.push({
        at: t, kind: 'xanax',
        title: `Take Xanax ${i + 1} of ${a.count}`,
        detail: `+${XANAX_ENERGY} energy, then train it straight away — regen stops while you're over max.` +
          (i === 0 ? ` You have ${a.owned}${buy ? `; buy ${buy} more` : ''}. Xanax carries a small overdose risk.` : ''),
      }));
    } else {
      const nowCount = Math.min(a.count, Math.max(0, Math.floor(boosterRoomNow / a.cooldownHours)));
      boosterRoomNow -= nowCount * a.cooldownHours;
      const { buy } = a;
      const each = `+${a.energyEach} energy${a.toMax ? ' (refills to max — train down to 0 first)' : ''} and +${fmtHours(a.cooldownHours)} booster cooldown each`;
      const stock = ` You have ${a.owned}${buy ? `; buy ${buy} more` : ''}.`;
      if (nowCount) steps.push({ at: now, kind: 'booster', title: `Use ${nowCount} × ${a.label}`, detail: `${each}.${stock}` });
      if (a.count > nowCount) {
        steps.push({ at: now + 1, kind: 'booster', when: 'Through the week',
          title: `Use ${a.count - nowCount}${nowCount ? ' more' : ''} × ${a.label} as booster cooldown allows`,
          detail: `${each}; your cooldown drops by an hour every hour.${nowCount ? '' : stock}` });
      }
    }
  }

  if (stillNeeded && Number.isFinite(r.fillHours)) {
    const full = bar.full_time ? now + bar.full_time : now;
    steps.push({ at: full, kind: 'regen',
      title: bar.full_time ? 'Energy full — train before this' : 'Keep training as energy regenerates',
      detail: `Regen is ${round(r.perHour)}/hour, a full bar every ${fmtHours(r.fillHours)}.` +
        (r.wastedPerDay > 0 ? ` Being offline for ${o.offlineHours}h at a time wastes about ${Math.round(r.wastedPerDay)} a day — train right before you log off.` : '') });
  }

  return steps.sort((a, b) => a.at - b.at);
}

const round = (n) => Math.round(n * 10) / 10;
export function fmtHours(h) {
  if (!Number.isFinite(h)) return '—';
  const m = Math.round(h * 60);
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}
