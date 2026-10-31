import { syncAttacks, savedAttacks, WIN_RESULTS } from './targets.js';
import { syncLogs, savedLogs, historyCoverage } from './sync.js';
import { eventWindow, treatStats, parseTreat, DEFAULT_START_TIME } from './halloween.js';

/**
 * The Halloween page: Trick or Treat attacks and the treats they dropped — how many attacks got
 * a treat at all, and how many got 2, 3 or more once multiplier upgrades kick in.
 * @param {{ $, store, status, esc, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, logTypes: () => Promise<object[]>, treatLogIds: () => number[],
 *   logPages: () => number, onError: (err) => void }} ctx
 */
export function createHalloweenPage(ctx) {
  const { $, store, status, esc, num } = ctx;
  const data = { loaded: false, attacks: [], treatLogs: [] };

  // ---------- settings ----------
  const DEFAULTS = { start: DEFAULT_START_TIME, count: 'all' };
  const saved = { ...DEFAULTS, ...store.get('halloween', {}) };
  $('#hw-start').value = saved.start;
  const countEl = document.querySelector(`input[name=hw-count][value="${saved.count}"]`);
  if (countEl) countEl.checked = true;
  const read = () => ({
    start: $('#hw-start').value || DEFAULT_START_TIME,
    count: document.querySelector('input[name=hw-count]:checked').value,
  });
  const save = () => { store.set('halloween', read()); render(); };
  $('#hw-start').addEventListener('change', save);
  document.querySelectorAll('input[name=hw-count]').forEach((el) => el.addEventListener('change', save));
  $('#hw-refresh').addEventListener('click', () => load());

  const window_ = () => eventWindow(read().start);

  // ---------- loading ----------
  let loading = null;
  function load() {
    loading ??= loadNow().finally(() => { loading = null; });
    return loading;
  }

  async function loadNow() {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to track your Trick or Treat attacks.');
    $('#hw-refresh').disabled = true;
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      const synced = await syncAttacks(db, client, player, { maxPages: ctx.logPages(), onProgress: status });
      await ctx.logTypes();
      const ids = ctx.treatLogIds();
      if (ids.length) status('Reading your treat logs…');
      // Read back to a day before the earliest possible start, so a later change of start time still has the logs.
      const since = eventWindow('00:00').start - 86400;
      const treatLogs = ids.length ? (await syncLogs(db, client, player, ids, { maxPages: ctx.logPages(), since, onProgress: status })).logs : [];
      Object.assign(data, { loaded: true, live: true, player, attacks: synced.attacks, at: synced.at, treatLogs });
      $('#hw-results').hidden = false;
      render();
      status(`Up to date. ${client.calls} API call${client.calls === 1 ? '' : 's'} this session.`);
    } catch (err) {
      ctx.onError(err);
    } finally {
      $('#hw-refresh').disabled = false;
    }
  }

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player }) {
    if (data.loaded) return null;
    const ids = ctx.treatLogIds();
    const [saved, treatLogs, coverage] = await Promise.all([savedAttacks(db, player), savedLogs(db, player, ids), historyCoverage(db, player, ids)]);
    if (!saved?.attacks.length || coverage.newest == null || data.loaded) return null;
    Object.assign(data, { loaded: true, player, attacks: saved.attacks, at: saved.at, treatLogs });
    $('#hw-results').hidden = false;
    render();
    return saved.at;
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');
  const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  function span(secs) {
    secs = Math.max(0, Math.round(secs));
    const d = Math.floor(secs / 86400); const h = Math.floor(secs / 3600) % 24; const m = Math.floor(secs / 60) % 60;
    return d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
  }

  function render() {
    if (!data.loaded) return;
    const s = read();
    const now = Math.floor(Date.now() / 1000);
    const { start, end } = window_();
    const include = s.count === 'wins' ? (a) => WIN_RESULTS.has(a.result) : undefined;
    const st = treatStats(data.attacks, data.treatLogs, data.player, { start, end, include });
    const noTypes = !ctx.treatLogIds().length;

    $('#hw-asof').textContent = `Event ${tct(start)} – ${tct(end)} TCT · attacks as of ${tct(data.at)} TCT`;
    $('#hw-notice').hidden = !noTypes && !(st.total && !st.treats);
    $('#hw-notice').textContent = noTypes
      ? 'No treat log types are ticked in Settings → Treat log types, so no treats can be counted. Tick the type Torn uses for treats you collect, then Refresh.'
      : 'None of these attacks has a treat matched to it. Check Settings → Treat log types has the right type ticked, and open “Raw treat logs” below to see what was read.';

    const state = now < start ? `starts in ${span(start - now)}` : now < end ? `${span(end - now)} left` : 'event over';
    $('#hw-cards').innerHTML = `
      <div class="card"><div class="label">Attacks</div><div class="value">${n0(st.total)}</div>
        <div class="sub">${s.count === 'wins' ? 'wins you started' : 'you started'} · ${esc(state)}</div></div>
      <div class="card"><div class="label">Got a treat</div><div class="value pos">${pct(st.withTreat, st.total)}</div>
        <div class="sub">${n0(st.withTreat)} of ${n0(st.total)} attacks</div></div>
      <div class="card"><div class="label">Treats</div><div class="value">${n0(st.treats)}</div>
        <div class="sub">${st.total ? (st.treats / st.total).toFixed(2) : '—'} per attack${st.withTreat ? ` · ${(st.treats / st.withTreat).toFixed(2)} per treat attack` : ''}</div></div>
      <div class="card"><div class="label">Multiplied (2+)</div><div class="value">${pct(st.multiplied, st.total)}</div>
        <div class="sub">${n0(st.multiplied)} attacks · ${pct(st.multiplied, st.withTreat)} of treat attacks</div></div>
      ${st.unmatched.logs ? `<div class="card"><div class="label">Not matched</div><div class="value">${n0(st.unmatched.treats)}</div>
        <div class="sub">treats in ${n0(st.unmatched.logs)} log${st.unmatched.logs === 1 ? '' : 's'} with no attack at that time</div></div>` : ''}`;

    // Treats per attack, with the share that got at least that many.
    let atLeast = st.total;
    $('#hw-dist tbody').innerHTML = [...st.dist].map(([treats, n]) => {
      const row = `<tr><td class="num">${treats === 0 ? 'None' : n0(treats)}</td><td class="num">${n0(n)}</td>
        <td class="num">${pct(n, st.total)}</td><td class="num">${treats ? pct(n, st.withTreat) : '—'}</td>
        <td class="num">${treats ? pct(atLeast, st.total) : '—'}</td></tr>`;
      atLeast -= n;
      return row;
    }).join('') || '<tr><td colspan="5" class="muted">No attacks in the event yet.</td></tr>';

    $('#hw-days tbody').innerHTML = st.byDay.map((d) => `<tr><td>${dayLabel(d.date)}</td><td class="num">${n0(d.attacks)}</td>
      <td class="num">${n0(d.withTreat)} <span class="muted small">${pct(d.withTreat, d.attacks)}</span></td>
      <td class="num">${n0(d.multiplied)} <span class="muted small">${pct(d.multiplied, d.attacks)}</span></td>
      <td class="num">${n0(d.treats)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No attacks in the event yet.</td></tr>';

    $('#hw-recent tbody').innerHTML = st.attacks.slice(0, 50).map((a) => `<tr><td>${tct(a.started)}</td>
      <td class="name"><a href="https://www.torn.com/profiles.php?XID=${a.defender.id}" target="_blank" rel="noopener">${esc(a.defender.name ?? a.defender.id)}</a></td>
      <td>${esc(a.result)}</td><td class="num">${a.treats ? `<span class="tag found">${n0(a.treats)}</span>` : '<span class="muted">0</span>'}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">No attacks in the event yet.</td></tr>';

    const logs = data.treatLogs.filter((l) => l.timestamp >= start - 86400 && l.timestamp < end);
    $('#hw-raw-count').textContent = `(${n0(logs.length)} in the event)`;
    $('#hw-raw').textContent = logs.slice(0, 5)
      .map((l) => `${tct(l.timestamp)} · ${l.details?.title ?? ''} · read as ${parseTreat(l).treats} treat(s)\n${JSON.stringify(l.data, null, 2)}`)
      .join('\n\n') || 'No treat logs saved for the event.';
  }

  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
