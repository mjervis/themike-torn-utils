import { DEFAULTS, weekWindow, isGymLogTitle, gymSessions } from './energy.js';
import { syncLogs, backfillOlder, historyCoverage, loadGyms } from './sync.js';
import {
  CONSUMABLE_TYPES, trainingEffect, trainingBursts, costUses, detectJumps, usesByItem, sources,
  weeklyTraining, trainingTotals,
} from './training.js';

/**
 * The Training cost page: consumables used for training, happy jumps and what each one cost.
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
  const read = () => ({
    range: document.querySelector('input[name=tr-range]:checked').value,
    valueAt: document.querySelector('input[name=tr-value]:checked').value,
  });
  document.querySelectorAll('input[name=tr-range], input[name=tr-value]').forEach((el) =>
    el.addEventListener('change', () => { store.set('training', read()); render(); }));
  $('#tr-refresh').addEventListener('click', () => load());
  $('#tr-older').addEventListener('click', () => readOlder());

  // ---------- loading ----------
  async function load() {
    const client = ctx.client();
    if (!client) return status('Enter your API key and press Load to see what your training costs.');
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
        status('No item use log types are ticked — pick them under Inventory profit → Settings → Item use log types.', true);
        return;
      }
      if (!data.gymCost) {
        const gyms = (await loadGyms(db, client).catch(() => null))?.value ?? [];
        data.gymCost = Object.fromEntries(gyms.map((g) => [g.id, g.energy_cost]));
      }

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

      Object.assign(data, { loaded: true, now: Math.floor(Date.now() / 1000), db, player, catalog, ids, gymIds: new Set(gymIds), logs });
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

  async function readOlder() {
    const client = ctx.client();
    if (!client || !data.loaded) return load();
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
    const jumps = detectJumps(allUses, trainingBursts(allSessions), effectOf).filter((j) => j.start >= from);
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

  function renderWeeks(weeks) {
    $('#tr-weeks tbody').innerHTML = weeks.map((w) => `
      <tr><td>${tct(w.start)}</td><td class="num">${money(w.spend)}${approx(w)}</td><td class="num">${n0(w.energy)}</td>
      <td class="num">${w.hasGain ? n0(w.gain) : '—'}</td><td class="num">${w.jumps || ''}</td>
      <td class="num">${w.energy ? money(w.spend / w.energy) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">Nothing in this range.</td></tr>';
  }

  return { load, render, get loaded() { return data.loaded; } };
}
