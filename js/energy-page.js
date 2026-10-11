import {
  DEFAULTS, WEEK_STATS, weekWindow, isGymLogTitle, gymSessions, dailyTotals,
  statDeltas, attackEnergy, pace, energyEffect, plan, fmtHours, XANAX_ENERGY,
} from './energy.js';
import { syncLogs, loadGyms, loadInventoryCategories } from './sync.js';

const ENERGY_CATEGORIES = ['Drug', 'Energy Drink', 'Booster'];
const ENERGY_TYPES = new Set(ENERGY_CATEGORIES);

/**
 * The Energy page: gym energy against a weekly target, other energy use, and a booster plan.
 * @param {{ $, store, status, esc, money, num, client: () => object|null, db: () => Promise<object>, player: () => Promise<{ id: number }>, catalog: () => Promise<Map>, logTypes: () => Promise<object[]>, onError: (err) => void }} ctx
 */
export function createEnergyPage(ctx) {
  const { $, store, status, esc, money, num } = ctx;
  const data = { loaded: false, gymCost: null };

  // ---------- settings ----------
  $('#en-hour').innerHTML = Array.from({ length: 24 }, (_, h) =>
    `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('');

  const fields = {
    target: ['#en-target', 'number'], weekStartDay: ['#en-day', 'number'], weekStartHour: ['#en-hour', 'number'],
    reserve: ['#en-reserve', 'number'], offlineHours: ['#en-offline', 'number'],
    boosterCapHours: ['#en-booster-cap', 'number'], xanaxCooldownHours: ['#en-xan-cd', 'number'],
    useRefills: ['#en-refills', 'bool'], useXanax: ['#en-xanax', 'bool'], useCans: ['#en-cans', 'bool'], allowBuying: ['#en-buy', 'bool'],
  };

  function read() {
    const out = {};
    for (const [k, [sel, kind]] of Object.entries(fields)) {
      const el = $(sel);
      out[k] = kind === 'bool' ? el.checked : Math.max(0, Number(el.value) || 0);
    }
    return out;
  }

  function restore() {
    const saved = { ...DEFAULTS, ...store.get('energy', {}) };
    for (const [k, [sel, kind]] of Object.entries(fields)) {
      if (kind === 'bool') $(sel).checked = !!saved[k]; else $(sel).value = saved[k];
    }
  }

  restore();
  for (const sel of Object.values(fields).map(([s]) => s)) {
    $(sel).addEventListener('change', () => {
      store.set('energy', read());
      if (sel === '#en-day' || sel === '#en-hour') load(); // a different week needs different logs and stats
      else render();
    });
  }
  $('#en-refresh').addEventListener('click', () => load());

  // ---------- loading ----------
  async function load() {
    const client = ctx.client();
    if (!client) return status('Enter your API key and press Load to see your energy.');
    const btn = $('#en-refresh');
    btn.disabled = true;
    try {
      const s = read();
      const now = Math.floor(Date.now() / 1000);
      const week = weekWindow(now, s.weekStartDay, s.weekStartHour);

      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;

      status('Loading item catalogue…');
      const catalog = await ctx.catalog();
      const logTypes = await ctx.logTypes();

      status('Loading energy, cooldowns and refills…');
      const bars = await client.bars();
      const cooldowns = await client.cooldowns();
      const refills = await client.refills();
      const gym = await client.gym().catch(() => null);
      if (!data.gymCost) {
        const gyms = (await loadGyms(db, client).catch(() => null))?.value ?? [];
        data.gymCost = Object.fromEntries(gyms.map((g) => [g.id, g.energy_cost]));
      }

      // Gym logs are saved locally like the purchase logs; only ones since the last sync are fetched.
      status('Reading this week\'s gym logs…');
      const gymLogIds = logTypes.filter((t) => isGymLogTitle(t.title)).map((t) => t.id);
      const logs = gymLogIds.length
        ? (await syncLogs(db, client, player, gymLogIds, { since: week.start, onProgress: status })).logs
        : [];

      status('Comparing stats with the start of the week…');
      const statsNow = await client.personalStats(WEEK_STATS);
      const statsStart = await client.personalStats(WEEK_STATS, week.start).catch(() => ({}));

      status('Checking your Xanax and energy drinks…');
      const inv = await loadInventoryCategories(db, client, player, ENERGY_CATEGORIES, {
        keep: (it) => ENERGY_TYPES.has(catalog.get(it.id)?.type),
        onCategory: (cat, i, n) => status(`Checking your Xanax and energy drinks… ${cat} (${i}/${n})`),
      });
      const owned = new Map();
      for (const it of inv.value.items) if (!it.faction_owned) owned.set(it.id, (owned.get(it.id) ?? 0) + it.amount);

      Object.assign(data, {
        loaded: true, now, week, bars, cooldowns, refills, gym, logs, catalog, owned,
        sessions: gymSessions(logs, data.gymCost),
        deltas: statDeltas(statsStart, statsNow),
      });
      $('#tos').open = false;
      $('#en-results').hidden = false;
      status(gymLogIds.length ? '' : 'No gym training log types found — gym energy can\'t be counted.', !gymLogIds.length);
      render();
    } catch (err) {
      ctx.onError(err);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }) + ' TCT';
  const until = (t) => fmtHours(Math.max(0, t - data.now) / 3600);
  const n0 = (n) => (n == null ? '—' : num.format(Math.round(n)));

  function energyItems() {
    const items = [];
    for (const it of data.catalog.values()) {
      if (!ENERGY_TYPES.has(it.type)) continue;
      const effect = energyEffect(it);
      if (!effect) continue;
      items.push({ id: it.id, name: it.name, effect, price: it.value?.market_price || null, owned: data.owned.get(it.id) ?? 0 });
    }
    return items;
  }

  function render() {
    if (!data.loaded) return;
    const s = read();
    const { now, week, bars, cooldowns, refills, sessions, deltas } = data;
    const spent = sessions.reduce((t, x) => t + (x.energy ?? 0), 0);
    const p = pace({ target: s.target, spent, start: week.start, end: week.end, now });
    const result = plan({
      now, end: week.end, needed: p.remaining, bar: bars.energy, cooldowns,
      refillUsed: !!refills.energy, items: energyItems(), options: s,
    });
    $('#en-asof').textContent = `As of ${tct(now)} · week ${tct(week.start)} → ${tct(week.end)}`;
    renderCards(s, spent, p, result);
    renderFeed(s, p, result);
    renderWeek(s, spent);
  }

  function renderCards(s, spent, p, r) {
    const { bars, cooldowns, refills, gym, week } = data;
    const cost = gym && data.gymCost?.[gym.id];
    const share = s.target ? Math.min(1, spent / s.target) : 0;
    const paceClass = p.ahead >= 0 ? 'pos' : 'neg';
    $('#en-cards').innerHTML = `
      <div class="card"><div class="label">Gym energy this week</div>
        <div class="value">${n0(spent)} <span class="of">/ ${n0(s.target)}</span></div>
        <div class="meter"><span style="width:${(share * 100).toFixed(1)}%"></span></div></div>
      <div class="card"><div class="label">Pace</div>
        <div class="value ${paceClass}">${p.ahead >= 0 ? '+' : '−'}${n0(Math.abs(p.ahead))}</div>
        <div class="sub">${p.ahead >= 0 ? 'ahead of' : 'behind'} an even pace (${n0(p.expected)} by now)</div></div>
      <div class="card"><div class="label">Still to train</div>
        <div class="value">${n0(p.remaining)}</div>
        <div class="sub">${cost && p.remaining ? `≈ ${n0(Math.ceil(p.remaining / cost))} trains at ${esc(gym.name)} (${cost}E)` : p.remaining ? '' : 'Target met'}</div></div>
      <div class="card"><div class="label">Week ends</div>
        <div class="value">${until(week.end)}</div><div class="sub">${tct(week.end)}</div></div>
      <div class="card"><div class="label">Energy now</div>
        <div class="value">${n0(bars.energy.current)} <span class="of">/ ${n0(bars.energy.maximum)}</span></div>
        <div class="sub">${bars.energy.full_time ? `full in ${fmtHours(bars.energy.full_time / 3600)}` : 'full'} · ${Math.round(r.perHour)}/hour regen</div></div>
      <div class="card"><div class="label">Cooldowns</div>
        <div class="value small">Drug ${cooldowns.drug ? fmtHours(cooldowns.drug / 3600) : 'ready'}</div>
        <div class="sub">Booster ${cooldowns.booster ? fmtHours(cooldowns.booster / 3600) : 'none'} · refill ${refills.energy ? 'used today' : 'available'}</div></div>`;
  }

  function renderFeed(s, p, r) {
    if (!s.target) {
      $('#en-summary').textContent = 'Set your weekly gym energy target above to get a plan.';
      $('#en-feed').innerHTML = '';
      return;
    }
    if (!p.remaining) {
      $('#en-summary').innerHTML = '<strong class="pos">Target met.</strong> Anything more you train this week is up to you.';
      $('#en-feed').innerHTML = '';
      return;
    }
    const parts = [`natural regen ≈ ${n0(r.natural)}`];
    for (const a of r.allocations) parts.push(`${a.count} × ${esc(a.label)} = ${n0(a.count * a.energyEach)}`);
    const spend = r.allocations.reduce((t, a) => t + (a.buy ?? 0) * (a.price ?? 0), 0);
    const verdict = r.shortfall
      ? `<strong class="neg">Short by ${n0(r.shortfall)}</strong> even using every option allowed — consider allowing more options or raising the booster limit.`
      : r.allocations.length
        ? `<strong class="pos">On track</strong> with the plan below${spend ? ` (about ${money(spend)} of extra items to buy)` : ''}.`
        : `<strong class="pos">On track on natural regen alone</strong> — about ${n0(r.spare)} spare, no boosters needed.`;
    $('#en-summary').innerHTML = `${verdict}<br><span class="muted">Needed ${n0(p.remaining)}: ${parts.join(' + ')}.</span>`;

    $('#en-feed').innerHTML = r.steps.map((st) => {
      const when = st.at <= data.now ? (st.when ?? 'Now') : st.when ?? `${tct(st.at)} <span class="muted">· in ${until(st.at)}</span>`;
      return `<li class="step ${st.kind}"><div class="when">${when}</div><div class="what">${esc(st.title)}</div>${st.detail ? `<div class="sub">${esc(st.detail)}</div>` : ''}</li>`;
    }).join('');
  }

  function renderWeek(s, spent) {
    const { week, now, sessions, deltas, bars } = data;
    const days = dailyTotals(sessions, week.start);
    const peak = Math.max(1, ...days.map((d) => d.energy), s.target / 7);
    const evenDay = s.target / 7;
    $('#en-days').innerHTML = '<div class="bars">' + days.map((d) => {
      const future = d.start > now;
      const today = d.start <= now && now < d.start + 86400;
      const label = new Date(d.start * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short' });
      return `<div class="day${future ? ' future' : ''}${today ? ' today' : ''}" title="${tct(d.start)}: ${n0(d.energy)} gym energy">
        <div class="bar"><span style="height:${(d.energy / peak * 100).toFixed(1)}%"></span></div>
        <div class="n">${d.energy ? n0(d.energy) : ''}</div><div class="d">${label}</div></div>`;
    }).join('') + `<div class="even" style="top:${Math.round((1 - evenDay / peak) * 120)}px" title="Even pace: ${n0(evenDay)} a day"></div></div>
      <div class="legend muted"><span class="swatch"></span> gym energy per day · <span class="swatch line"></span> even pace (${n0(evenDay)}/day)</div>`;

    const attacks = attackEnergy(deltas);
    const tracked = spent + (attacks ?? 0);
    const share = (v) => (tracked && v != null ? ` <span class="muted">${Math.round(v / tracked * 100)}%</span>` : '');
    const missing = sessions.filter((x) => x.energy == null).length;
    const d = deltas;
    const max = bars.energy.maximum;
    const regenSoFar = Math.max(0, (now - week.start) / 3600) * (bars.energy.interval ? bars.energy.increment * 3600 / bars.energy.interval : 0);
    const row = (label, v, note = '') => `<tr><td>${label}</td><td class="num">${v}</td><td class="muted">${note}</td></tr>`;
    $('#en-usage').innerHTML = `
      <h3>Energy used</h3>
      <table class="mini"><tbody>
        ${row('Gym training', `${n0(spent)}${share(spent)}`, `${sessions.length} sessions${missing ? `, ${missing} without energy data` : ''}`)}
        ${row('Attacks', attacks == null ? '—' : `≈ ${n0(attacks)}${share(attacks)}`, attacks == null ? 'stats unavailable' : `${n0(attacks / 25)} attacks × 25`)}
      </tbody></table>
      <h3>Energy gained</h3>
      <table class="mini"><tbody>
        ${row('Xanax', d.xantaken == null ? '—' : n0(d.xantaken * XANAX_ENERGY), d.xantaken == null ? '' : `${d.xantaken} taken`)}
        ${row('Energy refills', d.refills == null ? '—' : `≈ ${n0(d.refills * max)}`, d.refills == null ? '' : `${d.refills} used`)}
        ${row('Energy drinks', d.energydrinkused == null ? '—' : `${d.energydrinkused} cans`, 'energy varies by can')}
        ${d.lsdtaken ? row('LSD', `≈ ${n0(d.lsdtaken * 50)}`, `${d.lsdtaken} taken`) : ''}
        ${row('Natural regen', `≤ ${n0(regenSoFar)}`, 'most you could have regenerated')}
      </tbody></table>`;
  }

  return { load, render, get loaded() { return data.loaded; } };
}
