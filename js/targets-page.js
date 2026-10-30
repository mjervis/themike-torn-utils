import {
  syncAttacks, savedAttacks, beatenTargets, targetStatus, compareTargets, trimProfile, savedStatuses, saveStatuses, mugTotals,
} from './targets.js';
import { syncLogs, savedLogs, backfillOlder, historyCoverage } from './sync.js';

// A status checked this recently isn't asked for again by "Check statuses".
const FRESH_SECS = 60;

/**
 * The Targets page: players you've beaten, from your attack history, with where they are now
 * and how much you've mugged them for.
 * @param {{ $, store, status, esc, money, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, logTypes: () => Promise<object[]>, mugLogIds: () => number[],
 *   logPages: () => number, onError: (err) => void }} ctx
 */
export function createTargetsPage(ctx) {
  const { $, store, status, esc, money, num } = ctx;
  const data = { loaded: false, statuses: {}, checking: false, mugLogs: [] };

  // ---------- settings ----------
  const DEFAULTS = { show: 'all', range: 'all', minLevel: '', maxLevel: '', active: 'any', sort: 'status', checkLimit: 20 };
  const saved = { ...DEFAULTS, ...store.get('targets', {}) };
  for (const [name, value] of [['tg-show', saved.show], ['tg-range', saved.range]]) {
    const el = document.querySelector(`input[name=${name}][value="${value}"]`);
    if (el) el.checked = true;
  }
  $('#tg-min-level').value = saved.minLevel;
  $('#tg-max-level').value = saved.maxLevel;
  $('#tg-active').value = saved.active;
  $('#tg-sort').value = saved.sort;
  $('#tg-check-limit').value = saved.checkLimit;
  const read = () => ({
    show: document.querySelector('input[name=tg-show]:checked').value,
    range: document.querySelector('input[name=tg-range]:checked').value,
    minLevel: $('#tg-min-level').value,
    maxLevel: $('#tg-max-level').value,
    active: $('#tg-active').value,
    sort: $('#tg-sort').value,
    checkLimit: Math.min(100, Math.max(1, Number($('#tg-check-limit').value) || DEFAULTS.checkLimit)),
  });
  const save = () => { store.set('targets', read()); render(); };
  document.querySelectorAll('input[name=tg-show], input[name=tg-range]').forEach((el) => el.addEventListener('change', save));
  for (const sel of ['#tg-min-level', '#tg-max-level', '#tg-active', '#tg-sort', '#tg-check-limit']) $(sel).addEventListener('input', save);
  $('#tg-refresh').addEventListener('click', () => load());
  $('#tg-check').addEventListener('click', () => checkStatuses());
  $('#tg-older').addEventListener('click', () => readOlder());
  $('#tg-table tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('.tg-check-one');
    if (btn) checkStatuses([Number(btn.dataset.id)]);
  });

  // ---------- loading ----------
  // A key being entered and the tab being opened can both ask for a load; share the one in flight.
  let loading = null;
  function load() {
    loading ??= loadNow().finally(() => { loading = null; });
    return loading;
  }

  async function loadNow() {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to find targets you\'ve beaten.');
    const btns = [$('#tg-refresh'), $('#tg-older')];
    btns.forEach((b) => { b.disabled = true; });
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      const synced = await syncAttacks(db, client, player, { maxPages: ctx.logPages(), onProgress: status });
      await ctx.logTypes();
      const mugIds = ctx.mugLogIds();
      if (mugIds.length) status('Reading your mug logs…');
      const mugLogs = mugIds.length ? (await syncLogs(db, client, player, mugIds, { maxPages: ctx.logPages(), onProgress: status })).logs : [];
      const statuses = data.player === player ? data.statuses : await savedStatuses(db, player);
      const mugCoverage = await historyCoverage(db, player, mugIds);
      Object.assign(data, { loaded: true, live: true, db, player, statuses, mugLogs, mugCoverage, ...pick(synced) });
      $('#tg-results').hidden = false;
      render();
    } catch (err) {
      ctx.onError(err);
      return;
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
    await checkStatuses();
  }

  const pick = ({ attacks, complete, at }) => ({ attacks, complete, at });

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player }) {
    if (data.loaded) return null;
    const mugIds = ctx.mugLogIds();
    const [saved, statuses, mugLogs, mugCoverage] = await Promise.all([
      savedAttacks(db, player), savedStatuses(db, player), savedLogs(db, player, mugIds), historyCoverage(db, player, mugIds),
    ]);
    if (!saved?.attacks.length || data.loaded) return null;
    Object.assign(data, { loaded: true, db, player, statuses, mugLogs, mugCoverage, ...pick(saved) });
    $('#tg-results').hidden = false;
    render();
    return saved.at;
  }

  async function readOlder() {
    const client = ctx.client();
    if (!client || !data.live) return load();
    $('#tg-older').disabled = true;
    try {
      const before = client.calls;
      const synced = await syncAttacks(data.db, client, data.player, { maxPages: ctx.logPages(), older: true, onProgress: status });
      const mugIds = ctx.mugLogIds();
      if (mugIds.length) {
        data.mugLogs = (await backfillOlder(data.db, client, data.player, mugIds, { maxPages: ctx.logPages(), onProgress: status })).logs;
        data.mugCoverage = await historyCoverage(data.db, data.player, mugIds);
      }
      Object.assign(data, pick(synced));
      status(`Added ${synced.added} older attacks${synced.complete ? ' — that\'s your full history' : ''} (${client.calls - before} API calls).`);
      render();
    } catch (err) {
      ctx.onError(err);
    } finally {
      $('#tg-older').disabled = false;
    }
  }

  /**
   * Look up where targets are now: the given ids, or the first few shown (by "Check up to")
   * whose status is older than a minute. One profile call each, spaced by the client.
   */
  async function checkStatuses(ids) {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to check where your targets are.');
    if (data.checking || !data.loaded) return;
    const now = Math.floor(Date.now() / 1000);
    if (!ids) {
      ids = visibleRows({ ignoreStatusFilters: true })
        .sort((a, b) => (b.lastWin ?? 0) - (a.lastWin ?? 0))
        .filter((r) => !(now - (data.statuses[r.id]?.at ?? 0) < FRESH_SECS))
        .slice(0, read().checkLimit)
        .map((r) => r.id);
    }
    if (!ids.length) return status(`Statuses are up to date. ${client.calls} API call${client.calls === 1 ? '' : 's'} this session.`);
    data.checking = true;
    $('#tg-check').disabled = true;
    try {
      for (const [i, id] of ids.entries()) {
        status(`Checking where your targets are… ${i + 1} of ${ids.length}`);
        try {
          const profile = await client.profile(id);
          data.statuses[id] = { at: Math.floor(Date.now() / 1000), profile: trimProfile(profile) };
        } catch (err) {
          if (err.fatal) throw err;
          console.warn(`Couldn't check player ${id}:`, err); // e.g. a deleted account: skip it
        }
        if (i % 5 === 4) render();
      }
      await saveStatuses(data.db, data.player, data.statuses);
      status(`Checked ${ids.length} target${ids.length === 1 ? '' : 's'}. ${client.calls} API call${client.calls === 1 ? '' : 's'} this session.`);
    } catch (err) {
      ctx.onError(err);
    } finally {
      data.checking = false;
      $('#tg-check').disabled = false;
      render();
    }
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const day = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  /** "3h 20m", "12m 05s" */
  function span(secs) {
    secs = Math.max(0, Math.round(secs));
    const d = Math.floor(secs / 86400); const h = Math.floor(secs / 3600) % 24; const m = Math.floor(secs / 60) % 60; const s = secs % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const ago = (t, now) => (!t ? '—' : now - t < 60 ? 'just now' : `${span(now - t).replace(/ \d+s$/, '')} ago`);

  const rangeStart = (s, now) => (s.range === 'all' ? -Infinity : now - Number(s.range) * 86400);

  /** Targets with their current status and mug money, filtered by the toolbar choices. */
  function visibleRows({ ignoreStatusFilters = false, mugs } = {}) {
    const s = read();
    const now = Math.floor(Date.now() / 1000);
    const from = rangeStart(s, now);
    const minLevel = s.minLevel === '' ? -Infinity : Number(s.minLevel);
    const maxLevel = s.maxLevel === '' ? Infinity : Number(s.maxLevel);
    mugs ??= mugTotals(data.mugLogs, data.attacks, data.player, from);
    return beatenTargets(data.attacks, data.player)
      .map((r) => {
        const checked = data.statuses[r.id];
        const p = checked?.profile;
        return { ...r, level: p?.level ?? r.level, name: p?.name ?? r.name, checkedAt: checked?.at ?? null, profile: p ?? null,
          where: p ? targetStatus(p.status, now) : null, mugged: mugs.byTarget.get(r.id) ?? null };
      })
      .filter((r) => r.lastWin >= from && r.level >= minLevel && r.level <= maxLevel)
      .filter((r) => {
        if (ignoreStatusFilters) return true;
        if (s.show === 'ready' && !r.where?.ready) return false;
        if (s.active === 'any') return true;
        const last = r.profile?.last_action?.timestamp;
        if (last == null) return false;
        const days = (now - last) / 86400;
        return s.active.startsWith('in') ? days >= Number(s.active.slice(2)) : days <= Number(s.active);
      });
  }

  function render() {
    if (!data.loaded) return;
    const now = Math.floor(Date.now() / 1000);
    const s = read();
    const mugs = mugTotals(data.mugLogs, data.attacks, data.player, rangeStart(s, now));
    const all = visibleRows({ ignoreStatusFilters: true, mugs });
    const rows = visibleRows({ mugs }).sort(SORTS[s.sort] ?? compareTargets);
    const checked = all.filter((r) => r.where);
    const count = (kind) => checked.filter((r) => (kind === 'ready' ? r.where.ready : !r.where.ready && r.where.kind === kind)).length;

    $('#tg-asof').textContent = `Attacks as of ${tct(data.at)} TCT · ${n0(data.attacks.length)} attacks saved${data.complete ? ' (full history)' : ''}`;
    $('#tg-older').hidden = data.complete;
    $('#tg-cards').innerHTML = `
      <div class="card"><div class="label">Beaten</div><div class="value">${n0(all.length)}</div>
        <div class="sub">${n0(checked.length)} checked</div></div>
      <div class="card"><div class="label">Ready to hit</div><div class="value pos">${n0(count('ready'))}</div>
        <div class="sub">okay and in Torn</div></div>
      <div class="card"><div class="label">In hospital</div><div class="value">${n0(count('hospital'))}</div>
        <div class="sub">${n0(count('jail'))} in jail</div></div>
      <div class="card"><div class="label">Away</div><div class="value">${n0(count('abroad') + count('traveling'))}</div>
        <div class="sub">${n0(count('abroad'))} abroad · ${n0(count('traveling'))} flying</div></div>
      <div class="card"><div class="label">Mugged</div><div class="value">${mugsRead() ? money(mugs.total) : '—'}</div>
        <div class="sub">${mugSub(mugs)}</div></div>`;

    $('#tg-table tbody').innerHTML = rows.map((r) => row(r, now)).join('')
      || `<tr><td colspan="11" class="muted">${all.length ? 'No targets match these filters — statuses and last active only show once a target has been checked.' : 'No wins in your saved attacks yet.'}</td></tr>`;
  }

  // Mug logs are read on the first load with a key after mug tracking was added; until then there's nothing to add up.
  const mugsRead = () => ctx.mugLogIds().length > 0 && data.mugCoverage?.newest != null;

  function mugSub(mugs) {
    if (!ctx.mugLogIds().length) return 'pick mug log types in Settings';
    if (!mugsRead()) return data.live ? 'mug logs not read' : 'mug logs not read yet — load with your key';
    const cov = data.mugCoverage;
    const since = cov.complete ? '' : ` · logs back to ${day(cov.oldest)}`;
    if (!mugs.count) return `no mugs in this range${since}`;
    const biggest = Math.max(...[...mugs.byTarget.values()].map((t) => t.biggest), 0);
    return `${n0(mugs.count)} mug${mugs.count === 1 ? '' : 's'}${biggest ? ` · biggest ${money(biggest)}` : ''}${mugs.unmatched ? ` · ${n0(mugs.unmatched)} not matched to a player` : ''}${since}`;
  }

  const SORTS = {
    status: compareTargets,
    mugged: (a, b) => (b.mugged?.money ?? 0) - (a.mugged?.money ?? 0) || compareTargets(a, b),
    lastMug: (a, b) => (b.mugged?.lastAmount ?? 0) - (a.mugged?.lastAmount ?? 0) || compareTargets(a, b),
    lastWin: (a, b) => (b.lastWin ?? 0) - (a.lastWin ?? 0),
    level: (a, b) => (b.level ?? 0) - (a.level ?? 0) || compareTargets(a, b),
    // Both from your last win on them, so they reflect the target's current stats against yours.
    respect: (a, b) => (b.respect ?? 0) - (a.respect ?? 0) || compareTargets(a, b),
    ff: (a, b) => (b.ff ?? 0) - (a.ff ?? 0) || compareTargets(a, b),
  };

  const KIND_TAG = { okay: 'found', hospital: 'warn', jail: 'warn', federal: 'warn', abroad: '', traveling: '', gone: '' };

  function statusCell(r, now) {
    const w = r.where;
    if (!w) return `<button type="button" class="secondary small tg-check-one" data-id="${r.id}">Check</button>`;
    const label = w.ready ? 'Ready' : w.label;
    const timer = w.until && w.until > now && !w.ready ? ` <span class="muted" data-until="${w.until}">${span(w.until - now)}</span>` : '';
    const reason = w.reason ? ` title="${esc(w.reason)}"` : '';
    return `<span class="tag ${w.ready ? 'found' : KIND_TAG[w.kind]}"${reason}>${esc(label)}</span>${timer}
      <div class="muted small">checked ${ago(r.checkedAt, now)} <button type="button" class="link tg-check-one" data-id="${r.id}" title="Check again">↻</button></div>`;
  }

  function row(r, now) {
    const p = r.profile;
    const last = p?.last_action;
    const life = p?.life;
    return `<tr>
      <td class="name"><a href="https://www.torn.com/profiles.php?XID=${r.id}" target="_blank" rel="noopener">${esc(r.name)}</a>
        <span class="muted small">[${r.id}]</span>${r.faction ? `<div class="muted small">${esc(r.faction)}</div>` : ''}</td>
      <td class="num">${n0(r.level)}</td>
      <td>${statusCell(r, now)}</td>
      <td>${r.where ? esc(r.where.location) : '—'}</td>
      <td>${last ? `${esc(last.status)}<div class="muted small">${ago(last.timestamp, now)}</div>` : '—'}</td>
      <td class="num">${life ? `${n0(life.current)} / ${n0(life.maximum)}` : '—'}</td>
      <td class="num">${n0(r.wins)}${r.losses ? ` <span class="neg small">${n0(r.losses)} lost</span>` : ''}</td>
      <td class="num">${r.mugged ? `${money(r.mugged.money)}<div class="muted small">last ${money(r.mugged.lastAmount)} · ${day(r.mugged.lastMug)}</div><div class="muted small">${n0(r.mugged.mugs)} mug${r.mugged.mugs === 1 ? '' : 's'} · best ${money(r.mugged.biggest)}</div>`
        : r.mugs ? `<span class="muted" title="Mugged in your attacks, but no mug log found for the money">${n0(r.mugs)} mug${r.mugs === 1 ? '' : 's'}</span>` : '—'}</td>
      <td>${tct(r.lastWin)}<div class="muted small">${esc(r.lastResult)}${r.respect ? ` · ${r.respect.toFixed(2)} respect` : ''}</div></td>
      <td class="num">${r.ff == null ? '—' : r.ff.toFixed(2)}</td>
      <td><a class="button" href="https://www.torn.com/loader.php?sid=attack&amp;user2ID=${r.id}" target="_blank" rel="noopener">Attack</a></td>
    </tr>`;
  }

  // Hospital and jail countdowns tick down; when one runs out, re-render so the target moves to Ready.
  setInterval(() => {
    if (!data.loaded || $('#page-targets').hidden) return;
    const now = Math.floor(Date.now() / 1000);
    let expired = false;
    document.querySelectorAll('#tg-table [data-until]').forEach((el) => {
      const left = Number(el.dataset.until) - now;
      if (left <= 0) expired = true; else el.textContent = span(left);
    });
    if (expired) render();
  }, 1000);

  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
