import { DEFAULTS, weekWindow, isGymLogTitle, gymSessions } from './energy.js';
import { syncLogs, backfillOlder, historyCoverage, loadGyms, loadBars, loadInventoryCategories, savedInventory, savedLogs } from './sync.js';
import { meta } from './db.js';
import {
  CONSUMABLE_TYPES, trainingEffect, trainingBursts, costUses, detectJumps, usesByItem, sources,
  weeklyTraining, trainingTotals, jumpRole, planJumps, stockLevels, calibrate, gymDots, jumpGain,
} from './training.js';

/**
 * The Training cost page: consumables used for training, happy jumps and what each one cost,
 * plus the training stock held and jumps suggested to use it.
 * @param {{ $, store, status, esc, money, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, catalog: () => Promise<Map>, logTypes: () => Promise<object[]>,
 *   ledgerLogIds: () => number[], ledgerFor: (logs: object[]) => object, hasUseTypes: () => boolean,
 *   logPages: () => number, onError: (err) => void }} ctx
 */
export function createTrainingPage(ctx) {
  const { $, store, status, esc, money, num } = ctx;
  const data = { loaded: false };

  // ---------- settings ----------
  const saved = store.get('training', {});
  for (const [name, value] of [['tr-range', saved.range], ['tr-value', saved.valueAt]]) {
    const el = value && document.querySelector(`input[name=${name}][value="${value}"]`);
    if (el) el.checked = true;
  }
  if (saved.stat) $('#tr-stat').value = saved.stat;
  if (saved.happy) $('#tr-happy').value = saved.happy;
  const read = () => ({
    range: document.querySelector('input[name=tr-range]:checked').value,
    valueAt: document.querySelector('input[name=tr-value]:checked').value,
    // Until one is picked, the plan estimates for the stat you trained last.
    stat: store.get('training', {}).stat ?? null,
    happy: Number($('#tr-happy').value) || null,
  });
  document.querySelectorAll('input[name=tr-range], input[name=tr-value], #tr-happy').forEach((el) =>
    el.addEventListener('change', () => { store.set('training', read()); render(); }));
  $('#tr-stat').addEventListener('change', () => { store.set('training', { ...read(), stat: $('#tr-stat').value }); render(); });
  $('#tr-refresh').addEventListener('click', () => load());
  $('#tr-older').addEventListener('click', () => readOlder());

  // ---------- loading ----------
  async function load() {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to see what your training costs.');
    const btns = [$('#tr-refresh'), $('#tr-older')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      status('Loading item catalogue…');
      const catalog = await ctx.catalog();
      const logTypes = await ctx.logTypes();
      if (!ctx.hasUseTypes()) {
        status('No item use log types are ticked — pick them under Settings → Item use log types.', true);
        return;
      }
      if (!data.gyms) setGyms((await loadGyms(db, client).catch(() => null))?.value);
      // Max happy, for the jump estimates; shared with the Energy page's read.
      data.bars = (await loadBars(db, client, player).catch((err) => { if (err.fatal) throw err; return null; }))?.value ?? data.bars;

      await loadStock(db, client, player);

      const gymIds = logTypes.filter((t) => isGymLogTitle(t.title)).map((t) => t.id);
      const ledgerIds = ctx.ledgerLogIds();
      const ids = [...ledgerIds, ...gymIds];
      let { logs } = await syncLogs(db, client, player, ids, { maxPages: ctx.logPages(), onProgress: status });

      // The Energy page only reads gym logs back to the start of the week; reach back as far as the
      // item use history so older jumps have their training.
      const [gym, items] = await Promise.all([historyCoverage(db, player, gymIds), historyCoverage(db, player, ledgerIds)]);
      if (gymIds.length && !gym.complete && gym.oldest != null && items.oldest != null && gym.oldest > items.oldest) {
        status('Reading older gym logs…');
        await backfillOlder(db, client, player, gymIds, { maxPages: ctx.logPages(), onProgress: status });
        ({ logs } = await syncLogs(db, client, player, ids, { maxPages: ctx.logPages() }));
      }

      Object.assign(data, { loaded: true, live: true, now: Math.floor(Date.now() / 1000), db, player, catalog, ids, gymIds: new Set(gymIds), logs });
      await renderCoverage();
      $('#tos').open = false;
      $('#tr-results').hidden = false;
      status(gymIds.length ? `${client.calls} API call${client.calls === 1 ? '' : 's'} this session.` : 'No gym training log types found — training can\'t be counted.', !gymIds.length);
      render();
    } catch (err) {
      ctx.onError(err);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  const setGyms = (gyms) => {
    data.gyms = new Map((gyms ?? []).map((g) => [g.id, g]));
    data.gymCost = Object.fromEntries((gyms ?? []).map((g) => [g.id, g.energy_cost]));
  };

  const STOCK_CATEGORIES = [...CONSUMABLE_TYPES];
  const setStock = (inv) => {
    const owned = new Map();
    for (const it of inv.value.items) if (!it.faction_owned) owned.set(it.id, (owned.get(it.id) ?? 0) + it.amount);
    Object.assign(data, { owned, stockAt: inv.at, stockError: null });
  };

  /** The training consumables in your inventory, shared with the Inventory and Energy pages' reads. */
  async function loadStock(db, client, player) {
    status('Checking your training stock…');
    try {
      setStock(await loadInventoryCategories(db, client, player, STOCK_CATEGORIES, {
        onCategory: (cat, i, n) => status(`Checking your training stock… ${cat} (${i}/${n})`),
      }));
    } catch (err) {
      if (err.fatal) throw err;
      // The cost history still works without it.
      data.stockError = err.code === 16 ? 'Your key needs the user → inventory selection to show your stock.' : err.message;
    }
  }

  /**
   * Show what's saved in this browser, without a key or any API calls, as of the last sync.
   * Returns when that was, or null if there's nothing saved to show.
   */
  async function restoreSaved({ db, player, catalog, logTypes }) {
    if (data.loaded || !ctx.hasUseTypes()) return null;
    const gymIds = logTypes.filter((t) => isGymLogTitle(t.title)).map((t) => t.id);
    const ids = [...ctx.ledgerLogIds(), ...gymIds];
    const [logs, cov, gyms, stock, bars, energy] = await Promise.all([savedLogs(db, player, ids), historyCoverage(db, player, ids), meta.get(db, 'cache:gyms'),
      savedInventory(db, player, STOCK_CATEGORIES, { keep: (it) => CONSUMABLE_TYPES.has(catalog.get(it.id)?.type) }),
      meta.get(db, `cache:bars:${player}`), meta.get(db, `cache:energy:${player}`)]);
    if (!logs.length || cov.newest == null || data.loaded) return null; // nothing saved, or a load started meanwhile
    if (!data.gyms) setGyms(gyms?.value);
    data.bars ??= bars?.value ?? energy?.value.bars ?? null;
    if (stock) setStock(stock);
    Object.assign(data, { loaded: true, now: cov.newest, db, player, catalog, ids, gymIds: new Set(gymIds), logs, coverage: cov });
    $('#tr-older').hidden = cov.complete;
    $('#tr-results').hidden = false;
    render();
    return cov.newest;
  }

  async function readOlder() {
    const client = ctx.client();
    if (!client || !data.live) return load();
    $('#tr-older').disabled = true;
    try {
      const before = client.calls;
      const { added, complete, logs } = await backfillOlder(data.db, client, data.player, data.ids, { maxPages: ctx.logPages(), onProgress: status });
      data.logs = logs;
      status(`Added ${added} older logs${complete ? ' — that\'s your full history' : ''} (${client.calls - before} API calls).`);
      await renderCoverage();
      render();
    } catch (err) {
      ctx.onError(err);
    } finally {
      $('#tr-older').disabled = false;
    }
  }

  async function renderCoverage() {
    const cov = await historyCoverage(data.db, data.player, data.ids);
    data.coverage = cov;
    $('#tr-older').hidden = cov.complete;
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const day = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const ratio = (n) => (n == null || !Number.isFinite(n) ? '—' : n >= 10 ? num.format(Math.round(n)) : n.toFixed(2));
  // "62 bought · 25 free · 3 no record" — where the used units came from.
  const sourceLabel = (u) => {
    const src = sources(Array.isArray(u) ? u : [u]);
    return [src.bought && `${n0(src.bought)} bought`, src.free && `${n0(src.free)} free`, src.unknown && `${n0(src.unknown)} no record`]
      .filter(Boolean).join(' · ');
  };
  const approx = (u) => (u.estimatedQty ? ' <span class="tag warn" title="Some units had no purchase on record and are valued at today\'s market price">≈</span>' : '');

  function render() {
    if (!data.loaded) return;
    const s = read();
    const { catalog, logs, now } = data;
    const from = s.range === 'all' ? -Infinity : now - Number(s.range) * 86400;

    const effects = new Map();
    const effectOf = (id) => {
      if (!effects.has(id)) effects.set(id, trainingEffect(catalog.get(id)));
      return effects.get(id);
    };
    const price = (id) => catalog.get(id)?.value?.market_price || null;
    const ledger = ctx.ledgerFor(logs);
    const allUses = costUses(ledger.uses.filter((u) => CONSUMABLE_TYPES.has(catalog.get(u.itemId)?.type)), price, s.valueAt);
    const allSessions = gymSessions(logs.filter((l) => data.gymIds.has(l.details?.id)), data.gymCost ?? {});
    const allJumps = detectJumps(allUses, trainingBursts(allSessions), effectOf);
    const jumps = allJumps.filter((j) => j.start >= from);
    const uses = allUses.filter((u) => u.timestamp >= from);
    const sessions = allSessions.filter((x) => x.timestamp >= from);
    const totals = trainingTotals({ uses, sessions, jumps });

    const cov = data.coverage;
    $('#tr-asof').textContent = `As of ${tct(now)} TCT${cov?.oldest ? ` · history back to ${day(cov.oldest)}${cov.complete ? ' (complete)' : ''}` : ''}`;
    renderCards(totals, sessions, s, sources(uses));
    renderJumps(jumps);
    renderItems(usesByItem(uses), effectOf);
    const energy = store.get('energy', {});
    const anchor = weekWindow(now, energy.weekStartDay ?? DEFAULTS.weekStartDay, energy.weekStartHour ?? DEFAULTS.weekStartHour).start;
    renderWeeks(weeklyTraining({ uses, sessions, jumps }, anchor));

    const days = (now - (s.range === 'all' ? Math.min(now, ...allUses.map((u) => u.timestamp)) : from)) / 86400;
    renderStock(data.owned ? stockLevels(data.owned, uses, days) : null, effectOf, price);
    renderPlan(effectOf, price, energy.boosterCapHours ?? DEFAULTS.boosterCapHours, estimator(allSessions, allJumps, s));
  }

  function renderCards(t, sessions, s, src) {
    const gainKnown = t.gain != null;
    const boost = t.jumpGainPerEnergy && t.otherGainPerEnergy ? t.jumpGainPerEnergy / t.otherGainPerEnergy : null;
    $('#tr-cards').innerHTML = `
      <div class="card"><div class="label">Consumables used</div><div class="value">${money(t.spend)}</div>
        <div class="sub">${s.valueAt === 'market' ? 'at today\'s market value'
          : `at what they cost you · ${n0(src.free)} free (crimes, finds, gifts)${src.unknown ? ` · ${n0(src.unknown)} with no record, at market value` : ''}`}</div></div>
      <div class="card"><div class="label">Gym energy trained</div><div class="value">${n0(t.energy)}</div>
        <div class="sub">${n0(sessions.length)} gym logs · ${t.perEnergy == null ? '—' : `${money(t.perEnergy)} per energy`}</div></div>
      <div class="card"><div class="label">Stats gained</div><div class="value">${gainKnown ? n0(t.gain) : '—'}</div>
        <div class="sub">${gainKnown ? (t.perGain == null ? '' : `${money(t.perGain)} per stat point`) : 'not in your gym logs'}</div></div>
      <div class="card"><div class="label">Jumps</div><div class="value">${n0(t.jumps)}</div>
        <div class="sub">${t.jumps ? `${money(t.jumpCost / t.jumps)} each on average · ${n0(t.jumpEnergy)} energy` : 'none in this range'}</div></div>
      <div class="card"><div class="label">Jump vs normal training</div><div class="value">${boost ? `×${boost.toFixed(1)}` : '—'}</div>
        <div class="sub">${boost ? `${ratio(t.jumpGainPerEnergy)} vs ${ratio(t.otherGainPerEnergy)} stats per energy` : 'needs stat gains from both'}</div></div>`;
  }

  function stackLabel(uses) {
    const counts = new Map();
    for (const u of uses) counts.set(u.itemId, (counts.get(u.itemId) ?? 0) + u.qty);
    return [...counts.entries()].map(([id, n]) => `${n}× ${data.catalog.get(id)?.name ?? `Item ${id}`}`).join(', ');
  }

  function renderJumps(jumps) {
    $('#tr-jumps tbody').innerHTML = jumps.map((j) => {
      const stacked = j.stackFrom < j.start - 3600 ? ` <span class="muted">· stacked from ${tct(j.stackFrom)}</span>` : '';
      return `<tr>
        <td>${tct(j.start)}${stacked}</td>
        <td class="wrap">${esc(stackLabel(j.uses))}<div class="muted small">${esc(sourceLabel(j.uses))}</div></td>
        <td class="num">${money(j.cost)}${approx(j)}</td>
        <td class="num">${n0(j.energy)}</td>
        <td class="num">${j.gain == null ? '—' : n0(j.gain)}${j.stats.length ? ` <span class="muted">${esc(j.stats.join(', '))}</span>` : ''}</td>
        <td class="num">${j.gain ? money(j.cost / j.gain) : '—'}</td>
        <td class="num">${j.gain != null && j.energy ? ratio(j.gain / j.energy) : '—'}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No jumps in this range — a jump is training straight after Ecstasy or a big happy item like an erotic DVD.</td></tr>';
  }

  function effectLabel(e) {
    const parts = [];
    if (e.energy) parts.push(`+${n0(e.energy)} energy`);
    if (e.toMax) parts.push('refills energy');
    if (e.happy) parts.push(`+${n0(e.happy)} happy`);
    if (e.doublesHappy) parts.push('doubles happy');
    return parts.join(' · ');
  }

  function renderItems(items, effectOf) {
    $('#tr-items tbody').innerHTML = items.map((r) => {
      const item = data.catalog.get(r.itemId);
      const e = effectOf(r.itemId);
      return `<tr>
        <td class="name"><div class="cell">${item?.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : ''}<span>${esc(item?.name ?? `Item ${r.itemId}`)}</span>${e.jump ? ' <span class="tag found">jump</span>' : ''}</div></td>
        <td class="num">${n0(r.qty)}</td>
        <td class="muted">${esc(sourceLabel({ qty: r.qty, freeQty: r.freeQty, unknownQty: r.unknownQty }))}</td>
        <td class="num">${money(r.value)}${approx(r)}</td>
        <td class="num muted">${money(r.qty ? r.value / r.qty : null)}</td>
        <td class="num">${e.energy ? n0(e.energy * r.qty) : ''}</td>
        <td class="muted">${esc(effectLabel(e))}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No consumables used in this range.</td></tr>';
  }

  const lasts = (d) => (d == null ? '—' : d < 1 ? 'under a day' : d < 14 ? `${Math.floor(d)} day${Math.floor(d) === 1 ? '' : 's'}` : `${Math.floor(d / 7)} weeks`);
  const itemCell = (item, extra = '') => `<div class="cell">${item?.image ? `<img src="${esc(item.image)}" alt="" loading="lazy">` : ''}<span>${esc(item?.name ?? 'Unknown item')}</span>${extra}</div>`;

  function renderStock(rows, effectOf, price) {
    $('#tr-stock-asof').textContent = data.stockError ?? (data.stockAt ? `Inventory as of ${tct(data.stockAt)} TCT` : '');
    if (!rows) {
      $('#tr-stock tbody').innerHTML = '<tr><td colspan="7" class="muted">Refresh to read your stock from Torn.</td></tr>';
      return;
    }
    $('#tr-stock tbody').innerHTML = rows.map((r) => {
      const item = data.catalog.get(r.itemId);
      const e = effectOf(r.itemId);
      const p = price(r.itemId);
      return `<tr>
        <td class="name">${itemCell(item ?? { name: `Item ${r.itemId}` }, e.jump ? ' <span class="tag found">jump</span>' : '')}</td>
        <td class="num">${r.qty ? n0(r.qty) : '<span class="tag warn">out</span>'}</td>
        <td class="num">${r.qty && p ? money(r.qty * p) : '—'}</td>
        <td class="num">${r.used ? n0(r.used) : ''}</td>
        <td class="num">${r.perWeek ? ratio(r.perWeek) : ''}</td>
        <td class="num">${r.qty ? lasts(r.daysLeft) : ''}</td>
        <td class="muted">${esc(effectLabel(e))}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No drugs, energy drinks, boosters or candy in your inventory, and none used in this range.</td></tr>';
  }

  const partLabel = (p) => [p.stock && `${n0(p.stock)}× ${p.item.name}`, p.buy && `buy ${n0(p.buy)}× ${p.item.name}`].filter(Boolean).join(' + ');

  /**
   * What the jump estimates need — your current stat, gym and max happy — with perks fitted to your
   * ordinary training. Returns { stat, estimate(jump), … }, or { stat, missing } saying what's absent.
   */
  function estimator(sessions, jumps, s) {
    const latest = [...sessions].sort((a, b) => b.timestamp - a.timestamp);
    const stat = s.stat ?? jumps[0]?.stats[0] ?? latest.find((x) => x.stat)?.stat ?? 'strength';
    $('#tr-stat').value = stat;
    const maxHappy = s.happy ?? data.bars?.happy?.maximum ?? null;
    $('#tr-happy').placeholder = data.bars?.happy?.maximum ? `${data.bars.happy.maximum} from Torn` : 'from Torn';
    const last = latest.find((x) => x.stat === stat && x.before != null && x.gain != null);
    // You train where you last trained.
    const gym = data.gyms?.get(latest.find((x) => x.gym != null)?.gym);
    const dots = gymDots(gym, stat);
    if (!last) return { stat, missing: `No ${stat} training in your gym logs to estimate gains from.` };
    if (maxHappy == null) return { stat, missing: 'Enter your max happy above to estimate gains.' };
    if (!gym?.energy_cost) return { stat, missing: 'Your gym\'s details aren\'t saved yet — Refresh to estimate gains.' };
    if (!dots) return { stat, missing: `${gym.name} doesn't train ${stat} — pick another stat.` };
    const jumpIds = new Set(jumps.flatMap((j) => j.sessionIds));
    const fit = calibrate(sessions.filter((x) => !jumpIds.has(x.id)), { stat, maxHappy, gymOf: (id) => data.gyms.get(id) });
    const o = { stat, value: last.before + last.gain, maxHappy, energyPerTrain: gym.energy_cost, dots, perks: fit.perks ?? 1, happyPerEnergy: fit.happyPerEnergy };
    return { ...o, gym, fit, estimate: (jump) => jumpGain(jump, o) };
  }

  /** Market value of a jump's Ecstasy and happy items: what the jump costs over training normally. */
  const happyCost = (j) => j.parts.filter((p) => p.item.role !== 'xanax').reduce((t, p) => t + (p.stock + p.buy) * (p.item.price ?? 0), 0);

  function renderPlan(effectOf, price, boosterCapHours, est) {
    const items = [...data.catalog.values()]
      .filter((i) => CONSUMABLE_TYPES.has(i.type))
      .map((i) => {
        const e = effectOf(i.id);
        return { id: i.id, name: i.name, role: jumpRole(i, e), happy: e.happy, cooldownHours: e.cooldownHours, price: price(i.id), qty: data.owned?.get(i.id) ?? 0 };
      })
      .filter((i) => i.role);
    // Spread happy items evenly or pack them into fewer jumps, whichever is estimated to gain more.
    const plans = (est.estimate ? ['even', 'fill'] : ['even']).map((spread) => {
      const p = planJumps(items, { boosterCapHours, spread });
      for (const j of p.jumps) j.est = est.estimate?.(j);
      return { ...p, spread, gain: p.jumps.reduce((t, j) => t + (j.est?.gain ?? 0), 0) };
    });
    const plan = plans.reduce((a, b) => (b.gain > a.gain ? b : a));
    const { jumps, more, full, leftover } = plan;
    const fromStock = jumps.filter((j) => !j.buyCost).length;
    const stockValue = jumps.reduce((t, j) => t + j.stockValue, 0);
    const buyCost = jumps.reduce((t, j) => t + j.buyCost, 0);
    const gain = plan.gain;
    const normal = jumps.reduce((t, j) => t + (j.est?.normal ?? 0), 0);
    const extraCost = jumps.reduce((t, j) => t + happyCost(j), 0);
    const fullEst = est.estimate && full.parts.length ? est.estimate(full) : null;

    $('#tr-plan-cards').innerHTML = `
      <div class="card"><div class="label">Jumps from stock</div><div class="value">${n0(fromStock)}<span class="of"> of ${n0(jumps.length + more)}</span></div>
        <div class="sub">${data.owned ? `with nothing to buy · booster limit ${n0(boosterCapHours)}h` : 'stock not read yet'}</div></div>
      <div class="card"><div class="label">Estimated gain</div><div class="value">${est.estimate && jumps.length ? n0(gain) : '—'}</div>
        <div class="sub">${est.estimate ? (jumps.length ? `${esc(est.stat)} · ×${ratio(gain / normal)} training normally (${n0(normal)})` : 'nothing planned') : esc(est.missing)}</div></div>
      <div class="card"><div class="label">Cost per extra stat</div><div class="value">${est.estimate && gain > normal ? money(extraCost / (gain - normal)) : '—'}</div>
        <div class="sub">Ecstasy and happy items at market, over the gain of training normally</div></div>
      <div class="card"><div class="label">Stock used</div><div class="value">${money(stockValue)}</div><div class="sub">at market value</div></div>
      <div class="card"><div class="label">Still to buy</div><div class="value">${money(buyCost)}</div>
        <div class="sub">${jumps.length ? `to finish ${n0(jumps.length - fromStock)} jump${jumps.length - fromStock === 1 ? '' : 's'}` : 'nothing planned'}</div></div>
      <div class="card"><div class="label">Full jump at market</div><div class="value">${full.parts.length ? money(full.buyCost) : '—'}</div>
        <div class="sub">${esc(full.parts.map((p) => `${p.buy}× ${p.item.name}`).join(', '))}${fullEst ? ` · ≈ ${n0(fullEst.gain)} ${esc(est.stat)}` : ''}</div></div>`;

    $('#tr-plan tbody').innerHTML = jumps.map((j, i) => {
      const topUpGain = j.topUp && est.estimate ? est.estimate({ ...j, happy: j.happy + j.topUp.happy }).gain - j.est.gain : null;
      return `<tr>
        <td>${i + 1}</td>
        <td class="wrap">${esc(j.parts.map(partLabel).join(', '))}</td>
        <td class="num">${j.est ? n0(j.est.happy) : `${j.happy ? `+${n0(j.happy)}` : '—'}${j.parts.some((p) => p.item.role === 'ecstasy') ? ' <span class="muted">then ×2</span>' : ''}`}</td>
        <td class="num">${j.est ? n0(j.est.gain) : '—'}</td>
        <td class="num">${j.est?.normal ? `×${ratio(j.est.gain / j.est.normal)}` : '—'}</td>
        <td class="num">${money(j.stockValue)}</td>
        <td class="num">${j.buyCost ? money(j.buyCost) : '<span class="tag found">nothing</span>'}</td>
        <td class="muted">${j.topUp ? `${n0(j.topUp.qty)}× ${esc(j.topUp.item.name)} for ${money(j.topUp.cost)}${topUpGain != null ? ` · +${n0(topUpGain)} ${esc(est.stat)}` : ` (+${n0(j.topUp.happy)} happy)`}` : ''}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="8" class="muted">${data.owned ? 'No Xanax, Ecstasy or big happy items in stock to plan a jump around.' : 'Refresh to read your stock from Torn.'}</td></tr>`;

    const notes = [];
    if (est.estimate) {
      notes.push(`Estimates for ${est.stat} from ${n0(est.value)} at ${est.gym.name ?? `gym ${est.gym.id}`} (${est.dots} dots, ${est.energyPerTrain}E a train), max happy ${n0(est.maxHappy)};`
        + (est.fit.perks != null ? ` perks ×${est.fit.perks.toFixed(2)}, fitted to your last ${est.fit.sessions} ordinary ${est.stat} session${est.fit.sessions === 1 ? '' : 's'}.`
          : ` no ordinary ${est.stat} sessions to fit your perks to, so none are included.`));
      const other = plans.find((p) => p !== plan);
      if (other && Math.round(plan.gain) > Math.round(other.gain)) {
        notes.push(`${plan.spread === 'fill' ? 'Packing happy items into fewer jumps' : 'Spreading happy items evenly'} is estimated to gain ${n0(plan.gain - other.gain)} more than ${plan.spread === 'fill' ? 'spreading them evenly' : 'packing them into fewer jumps'}.`);
      }
    }
    if (more) notes.push(`Your stock would stretch to ${n0(more)} more jump${more === 1 ? '' : 's'} after these.`);
    if (leftover.length) notes.push(`Left over: ${leftover.map((l) => `${n0(l.qty)}× ${l.item.name}`).join(', ')}.`);
    $('#tr-plan-note').textContent = notes.join(' ');
  }

  function renderWeeks(weeks) {
    $('#tr-weeks tbody').innerHTML = weeks.map((w) => `
      <tr><td>${tct(w.start)}</td><td class="num">${money(w.spend)}${approx(w)}</td><td class="num">${n0(w.energy)}</td>
      <td class="num">${w.hasGain ? n0(w.gain) : '—'}</td><td class="num">${w.jumps || ''}</td>
      <td class="num">${w.energy ? money(w.spend / w.energy) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">Nothing in this range.</td></tr>';
  }

  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
