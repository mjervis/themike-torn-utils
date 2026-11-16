import { meta } from './db.js';
import { DEFAULTS, ocPlan } from './ocplan.js';

const DAY = 86400;
const OPEN = new Set(['Recruiting', 'Planning']);
const MODES = new Set(['level', 'cpr', 'completed', 'respect']);
// Saved OCs from before this version lack respect and planning times: read their history again.
const VERSION = 2;

/** Just what planning needs from an OC, so months of them stay small in the browser. */
const slim = (c) => ({
  id: c.id, name: c.name, difficulty: c.difficulty, status: c.status, created_at: c.created_at,
  executed_at: c.executed_at ?? null, expired_at: c.expired_at ?? null, ready_at: c.ready_at ?? null, planning_at: c.planning_at ?? null,
  rewards: c.rewards ? { respect: c.rewards.respect ?? 0 } : null,
  slots: (c.slots ?? []).map((s) => ({
    position: s.position, position_info: s.position_info ? { label: s.position_info.label, number: s.position_info.number } : undefined,
    position_number: s.position_number, checkpoint_pass_rate: s.checkpoint_pass_rate ?? s.success_chance ?? null,
    item_requirement: s.item_requirement ? { id: s.item_requirement.id, is_reusable: s.item_requirement.is_reusable } : null,
    user: s.user ? { id: s.user.id, joined_at: s.user.joined_at, progress: s.user.progress ?? null } : null,
  })),
});

/**
 * The OC planning page: which free faction member to put in each open OC slot, from the pass rates
 * (CPR) members have had in the faction's OCs. Needs a key with faction API access.
 * @param {{ $, store, status, esc, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, catalog: () => Promise<Map>, onError: (err) => void }} ctx
 */
export function createOcPlanPage(ctx) {
  const { $, store, status, esc, num } = ctx;
  // `saved`: { crimes: { id: crime }, members, exp, self, at, fetchedTo }
  const data = { loaded: false, live: false, player: null, saved: null, catalog: new Map() };

  // ---------- settings ----------
  const saved = { ...DEFAULTS, ...store.get('ocplan', {}) };
  $('#op-min').value = saved.minCpr;
  $('#op-prioritise').value = saved.prioritise;
  $('#op-active').value = saved.activeDays;
  const read = () => ({
    minCpr: $('#op-min').value === '' ? DEFAULTS.minCpr : Math.min(100, Math.max(0, Number($('#op-min').value))),
    prioritise: MODES.has($('#op-prioritise').value) ? $('#op-prioritise').value : DEFAULTS.prioritise,
    activeDays: $('#op-active').value === '' ? DEFAULTS.activeDays : Math.max(0, Number($('#op-active').value)),
    historyDays: saved.historyDays,
  });
  const save = () => { store.set('ocplan', read()); render(); };
  ['#op-min', '#op-prioritise', '#op-active'].forEach((s) => $(s).addEventListener('change', save));
  $('#op-refresh').addEventListener('click', () => load());

  // ---------- loading ----------
  let loading = null;
  function load() {
    loading ??= loadNow().finally(() => { loading = null; });
    return loading;
  }

  async function loadNow() {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to plan your faction\'s organised crimes.');
    $('#op-refresh').disabled = true;
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      const before = client.calls;
      const key = `ocplan:${player}`;
      let s = (data.player === player && data.saved) || (await meta.get(db, key));
      if (!s || s.version !== VERSION) s = { crimes: {}, members: [], exp: [], version: VERSION };
      const now = Math.floor(Date.now() / 1000);

      status('Reading the faction\'s members…');
      s.members = (await client.factionMembers()).map((m) => ({
        id: m.id, name: m.name, position: m.position, level: m.level, last_action: m.last_action,
        is_in_oc: m.is_in_oc, status: m.status ? { state: m.status.state, description: m.status.description } : null,
      }));
      try { s.exp = await client.factionCrimeExp(); } catch { s.exp = s.exp ?? []; } // only breaks ties

      // Past OCs give each member's pass rates: back `historyDays` the first time, then only newer ones.
      status('Reading the faction\'s past organised crimes…');
      const from = s.fetchedTo ? s.fetchedTo - DAY : now - read().historyDays * DAY;
      for (const c of await client.factionCrimes({ cat: 'completed', filters: 'executed_at', from, to: now })) s.crimes[c.id] = slim(c);
      // The Organised crime page's saved weeks add more history for free.
      const oc = await meta.get(db, `oc:${player}`);
      for (const c of Object.values(oc?.crimes ?? {})) if (!OPEN.has(c.status) && !s.crimes[c.id]) s.crimes[c.id] = slim(c);

      status('Reading the OCs that are recruiting…');
      const open = await client.factionCrimes({ cat: 'available' });
      for (const [id, c] of Object.entries(s.crimes)) if (OPEN.has(c.status)) delete s.crimes[id];
      for (const c of open) s.crimes[c.id] = slim(c);

      Object.assign(s, { self: player, at: now, fetchedTo: now });
      await meta.set(db, key, s);
      if (Object.values(s.crimes).some((c) => OPEN.has(c.status) && c.slots.some((sl) => !sl.user && sl.item_requirement))) {
        data.catalog = await ctx.catalog(); // names for the items open slots need
      }
      Object.assign(data, { loaded: true, live: true, player, saved: s });
      $('#op-results').hidden = false;
      render();
      const calls = client.calls - before;
      status(`Up to date. ${calls} API call${calls === 1 ? '' : 's'}.`);
    } catch (err) {
      if (err.code === 6 || err.code === 7 || err.code === 16) {
        status('Planning your faction\'s organised crimes needs a key with faction API access. Ask faction leadership to give your position "Faction API access", and make sure the key includes faction → crimes, crimeexp and members.', true);
        return;
      }
      ctx.onError(err);
    } finally {
      $('#op-refresh').disabled = false;
    }
  }

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player, catalog }) {
    if (data.loaded) return null;
    const s = await meta.get(db, `ocplan:${player}`);
    if (!s?.at || data.loaded) return null;
    Object.assign(data, { loaded: true, player, saved: s, catalog: catalog?.size ? catalog : data.catalog });
    $('#op-results').hidden = false;
    render();
    return s.at;
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const who = (m) => `<a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name ?? `#${m.id}`)}</a>`;
  const pct = (n) => `${n0(n)}%`;
  function ago(t, now = Date.now() / 1000) {
    if (!t) return '—';
    const s = Math.max(0, now - t);
    return s < 3600 ? `${Math.round(s / 60)}m ago` : s < DAY ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / DAY)}d ago`;
  }
  function until(t, now = Date.now() / 1000) {
    if (!t) return '';
    const s = t - now;
    if (s <= 0) return 'expired';
    return s < DAY ? `${Math.round(s / 3600)}h left` : `${Math.round(s / DAY)}d left`;
  }
  function when(t, now = Date.now() / 1000) {
    if (!t) return '—';
    const s = t - now;
    const rel = s <= 3600 ? 'within the hour' : s < DAY ? `in ${Math.round(s / 3600)}h` : `in ${(s / DAY).toFixed(1)}d`;
    return `${rel} <span class="muted small">${tct(t)}</span>`;
  }
  const crimeCell = (x) => `${esc(x.crime)} <span class="muted small">level ${n0(x.difficulty)} · ${n0(x.filled)}/${n0(x.total)} filled${x.expires ? ` · ${until(x.expires)}` : ''}</span>`;
  const itemCell = (x) => {
    if (!x.item) return '<span class="muted">—</span>';
    const name = data.catalog.get(x.item.id)?.name ?? `item #${x.item.id}`;
    return `${esc(name)}${x.item.reusable ? ' <span class="muted small">reusable</span>' : ''}`;
  };
  const cprClass = (c, min) => (c >= Math.max(min, 80) ? 'pos' : c >= min ? '' : 'neg');

  function render() {
    if (!data.loaded) return;
    const s = data.saved;
    const opts = read();
    const now = s.at ?? Date.now() / 1000;
    const p = ocPlan(Object.values(s.crimes ?? {}), s.members ?? [], { ...opts, self: s.self, exp: s.exp ?? [], now });
    const past = Object.values(s.crimes ?? {}).filter((c) => !OPEN.has(c.status)).length;

    $('#op-asof').textContent = `Read ${tct(s.at)} TCT · pass rates from ${n0(past)} past OCs`;
    $('#op-cards').innerHTML = `
      <div class="card"><div class="label">Open slots</div><div class="value">${n0(p.slots.length)}</div>
        <div class="sub">in ${n0(p.crimes)} OC${p.crimes === 1 ? '' : 's'} recruiting or planning</div></div>
      <div class="card"><div class="label">Free members</div><div class="value">${n0(p.free.length)}</div>
        <div class="sub">not in an OC${p.skipped.length ? ` · ${n0(p.skipped.length)} more left out` : ''}</div></div>
      <div class="card"><div class="label">Recommended</div><div class="value pos">${n0(p.assignments.length)}</div>
        <div class="sub">${p.assignments.length ? `average CPR ${pct(p.assignments.reduce((t, a) => t + a.cpr, 0) / p.assignments.length)}` : `nobody at ${pct(opts.minCpr)}+ for a slot`}</div></div>
      <div class="card"><div class="label">OCs ready to start</div><div class="value pos">${n0(p.ocs.filter((o) => o.complete).length)}<span class="of"> / ${n0(p.ocs.length)}</span></div>
        <div class="sub">fully filled with the recommendations${p.ocs.some((o) => o.complete) ? ` · ${n0(p.ocs.filter((o) => o.complete).reduce((t, o) => t + o.value.respect, 0))} expected respect` : ''}</div></div>
      <div class="card"><div class="label">Slots left empty</div><div class="value ${p.unfilled.length ? 'neg' : 'pos'}">${n0(p.unfilled.length)}</div>
        <div class="sub">no free member at ${pct(opts.minCpr)}+ on record</div></div>
      <div class="card"><div class="label">Members without a slot</div><div class="value">${n0(p.unplaced.length)}</div>
        <div class="sub">${p.unplaced.some((m) => m.known.length) ? 'see below for OCs they could start' : 'free members left over'}</div></div>`;

    $('#op-ocs tbody').innerHTML = p.ocs.map((o) => `<tr${o.complete ? '' : ' class="muted"'}>
      <td>${esc(o.crime)}${o.chosen ? ' <span class="tag">target</span>' : ''}</td><td class="num">${n0(o.difficulty)}</td><td>${esc(o.status)}</td>
      <td class="num">${n0(o.filled)}${o.recommended ? ` <span class="pos">+${n0(o.recommended)}</span>` : ''} / ${n0(o.total)}</td>
      <td>${o.complete ? when(o.ready, now) : `needs ${n0(o.empty)} more <span class="muted small">then ${when(o.ready, now)}</span>`}</td>
      <td class="num">${n0(o.value.respect)}${o.value.estimated ? ' <span class="muted small" title="Never done: the average for its level">≈</span>' : ''}${o.value.successRate != null ? ` <span class="muted small">${pct(o.value.successRate * 100)} success</span>` : ''}</td>
      <td>${o.expires ? until(o.expires, now) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No OCs are recruiting right now.</td></tr>';

    $('#op-assign tbody').innerHTML = p.assignments.map((a) => `<tr>
      <td>${crimeCell(a)}</td><td>${esc(a.label)}</td><td class="name">${who(a.member)}</td>
      <td class="num ${cprClass(a.cpr, opts.minCpr)}">${pct(a.cpr)}${a.exact ? '' : ' <span class="muted small" title="From another slot of the same role in this OC">≈</span>'}</td>
      <td>${ago(a.cprAt, now)}</td><td>${ago(a.member.lastAction, now)}</td><td>${itemCell(a)}</td>
      <td class="wrap">${a.alternatives.length ? a.alternatives.map((c) => `${who(c.member)} ${pct(c.cpr)}${c.placed ? ' <span class="muted small">placed</span>' : ''}`).join(', ') : '<span class="muted">—</span>'}</td>
    </tr>`).join('') || `<tr><td colspan="8" class="muted">${p.slots.length ? `No free member has a CPR of ${pct(opts.minCpr)} or more on record for an open slot.` : 'No OCs are recruiting right now.'}</td></tr>`;

    $('#op-unfilled-title').textContent = `Slots left empty (${n0(p.unfilled.length)})`;
    $('#op-unfilled tbody').innerHTML = p.unfilled.map((u) => `<tr>
      <td>${crimeCell(u)}</td><td>${esc(u.label)}</td><td>${itemCell(u)}</td>
      <td class="wrap">${u.candidates.length ? u.candidates.map((c) => `${who(c.member)} <span class="${cprClass(c.cpr, opts.minCpr)}">${pct(c.cpr)}</span>${c.placed ? ' <span class="muted small">placed elsewhere</span>' : ''}`).join(', ')
        : '<span class="muted">No free member has been in this slot</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Every open slot has a recommendation.</td></tr>';

    $('#op-unplaced-title').textContent = `Free members without a slot (${n0(p.unplaced.length)})`;
    $('#op-unplaced tbody').innerHTML = p.unplaced.map((m) => `<tr>
      <td class="name">${who(m)}</td><td class="num">${n0(m.level)}</td><td>${ago(m.lastAction, now)}</td>
      <td class="num">${m.expRank ? `#${n0(m.expRank)}` : '—'}</td>
      <td class="wrap">${m.known.length ? m.known.map((k) => `${esc(k.crime)} <span class="muted small">level ${n0(k.difficulty)}</span> ${esc(k.role)} ${pct(k.cpr)}`).join(' · ')
        : `<span class="muted">${m.anyCpr ? `No CPR of ${pct(opts.minCpr)}+ on record` : 'Not in any OC on record'}</span>`}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Every free member has a recommended slot.</td></tr>';

    $('#op-skipped-wrap').hidden = !p.skipped.length;
    $('#op-skipped').innerHTML = p.skipped.map((m) => `${who(m)} <span class="muted small">${esc(m.reason)}</span>`).join(', ');
  }

  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
