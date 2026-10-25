import {
  COMPETITION, DEFAULT_TEAMS, matchTeams, chainState, memberTotals, standings, syncChain, savedChain,
} from './chain.js';

// The chain report and live chain are re-read this often while the page is open (2 calls each time).
const REFRESH_SECS = 60;

/**
 * The Chain page: a live leaderboard for the faction's chain competition, from the faction's chain
 * reports (any member's key with public access will do).
 * @param {{ $, store, status, esc, money, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, onError: (err) => void }} ctx
 */
export function createChainPage(ctx) {
  const { $, store, status, esc, money, num } = ctx;
  const comp = COMPETITION;
  const teams = DEFAULT_TEAMS;
  const data = { loaded: false, live: false, saved: null };
  // Member id -> team id ('' for no team), where someone has changed the announced line-up on this device.
  let overrides = store.get('chainTeams', {});

  $('#ch-auto').checked = store.get('chainAuto', true);
  $('#ch-auto').addEventListener('change', () => store.set('chainAuto', $('#ch-auto').checked));
  $('#ch-refresh').addEventListener('click', () => load());
  $('#ch-setup-table').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-id]');
    if (!sel) return;
    overrides = { ...overrides, [sel.dataset.id]: sel.value };
    store.set('chainTeams', overrides);
    render();
  });
  $('#ch-reset-teams').addEventListener('click', () => {
    overrides = {};
    store.del('chainTeams');
    render();
  });

  // ---------- loading ----------
  let loading = null;
  function load({ quiet = false } = {}) {
    loading ??= loadNow(quiet).finally(() => { loading = null; });
    return loading;
  }

  async function loadNow(quiet) {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to see the chain competition.');
    $('#ch-refresh').disabled = true;
    try {
      const db = await ctx.db();
      if (!quiet) status('Checking your key…');
      const player = (await ctx.player()).id;
      const before = client.calls;
      // The member list and finished chains are read once a session; the live chain on every refresh.
      const first = !data.live || data.player !== player;
      const saved = await syncChain(db, client, player, { comp, members: first, listChains: first, onProgress: quiet ? null : status });
      Object.assign(data, { loaded: true, live: true, db, player, saved });
      $('#ch-results').hidden = false;
      render();
      if (!quiet) status(`Chain updated (${client.calls - before} API calls). Refreshes every minute while this page is open.`);
    } catch (err) {
      if (err.code === 7 || err.code === 6) {
        status('This key\'s owner isn\'t in a faction, so there\'s no chain to show.', true);
        return;
      }
      ctx.onError(err);
    } finally {
      $('#ch-refresh').disabled = false;
    }
  }

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player }) {
    if (data.loaded) return null;
    const saved = await savedChain(db, player);
    if (!saved?.members || data.loaded) return null;
    Object.assign(data, { loaded: true, db, player, saved });
    $('#ch-results').hidden = false;
    render();
    return saved.at;
  }

  // ---------- working it out ----------
  /** Who's on which team: the announced line-up matched to members, with this device's changes on top. */
  function lineUp() {
    const members = data.saved.members ?? [];
    const { assigned, unmatched } = matchTeams(members, teams);
    const ids = new Set(members.map((m) => m.id));
    const assignment = new Map(assigned);
    for (const [id, team] of Object.entries(overrides)) {
      if (!ids.has(Number(id))) continue;
      if (team) assignment.set(Number(id), team); else assignment.delete(Number(id));
    }
    return { members, assignment, unmatched, guessed: assigned };
  }

  function compute() {
    const s = data.saved;
    const reports = Object.values(s.reports ?? {});
    const state = chainState(reports, s.live, comp);
    const counted = new Set(state.chains.map((c) => c.id));
    const totals = memberTotals(reports.filter((r) => counted.has(r.id)));
    const line = lineUp();
    const names = new Map(line.members.map((m) => [m.id, m.name]));
    return { state, line, table: standings({ teams, assignment: line.assignment, names, totals, broken: state.broken && !state.reached, comp }) };
  }

  // ---------- rendering ----------
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const r2 = (n) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(2));
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const shortMoney = (n) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : money(n));
  /** "3h 20m", "12m 05s" */
  function span(secs) {
    secs = Math.max(0, Math.round(secs));
    const d = Math.floor(secs / 86400); const h = Math.floor(secs / 3600) % 24; const m = Math.floor(secs / 60) % 60; const s = secs % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const playerLink = (m) => `<a href="https://www.torn.com/profiles.php?XID=${m.id}" target="_blank" rel="noopener">${esc(m.name)}</a>`;
  const teamName = (id) => teams.find((t) => t.id === id)?.name ?? 'No team';

  function render() {
    if (!data.loaded) return;
    const now = Math.floor(Date.now() / 1000);
    const { state, line, table } = compute();
    const live = data.saved.live;
    const halved = state.broken && !state.reached;

    $('#ch-asof').textContent = `Updated ${tct(data.saved.at)} TCT${data.live ? '' : ' (saved)'}`;
    $('#ch-banner').innerHTML = banner(state, live, now, halved);

    const reportHits = state.chains.reduce((s, c) => s + c.length, 0);
    $('#ch-cards').innerHTML = `
      <div class="card"><div class="label">Team hits</div><div class="value">${n0(table.hits)}</div>
        <div class="sub">${n0(reportHits)} in the chain${state.chains.length > 1 ? 's' : ''} · ${n0(table.others.reduce((s, m) => s + m.hits, 0))} by members not on a team</div></div>
      <div class="card"><div class="label">Qualified</div><div class="value">${n0(table.players.filter((m) => m.qualified).length)} / ${n0(table.players.length)}</div>
        <div class="sub">${comp.qualify}+ hits for a team payout</div></div>
      <div class="card"><div class="label">Prizes</div><div class="value ${halved ? 'neg' : 'pos'}">${halved ? 'Halved' : 'Full'}</div>
        <div class="sub">${halved ? 'the chain broke before 2,500' : state.reached ? 'goal reached!' : 'as long as the chain holds'}</div></div>
      <div class="card"><div class="label">Leader</div><div class="value small">${esc(table.teams[0]?.name ?? '—')}</div>
        <div class="sub">${r2(table.teams[0]?.score)} hits per member</div></div>`;

    $('#ch-standings tbody').innerHTML = table.teams.map((t) => `<tr class="team-${t.id}">
      <td class="num">${placeLabel(t.place)}</td>
      <td><span class="team-dot"></span>${esc(t.name)}</td>
      <td class="num">${n0(t.size)}</td>
      <td class="num">${n0(t.hits)}</td>
      <td class="num"><strong>${r2(t.score)}</strong></td>
      <td class="num">${n0(t.qualified)} / ${n0(t.size)}</td>
      <td class="num">${shortMoney(t.prizeEach)}</td>
      <td class="num">${shortMoney(t.payout)}</td>
    </tr>`).join('');

    $('#ch-teams').innerHTML = table.teams.map(teamCard).join('');
    $('#ch-prizes').innerHTML = prizes(table);
    $('#ch-others').innerHTML = table.others.length ? `
      <h2 class="section-title">Hitting, but not on a team</h2>
      <p class="muted">These members have chain hits but aren't on a team here. If they should be, put them on one under Teams below.</p>
      <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Hits</th><th class="num">Respect</th></tr></thead>
      <tbody>${table.others.map((m) => `<tr><td>${playerLink(m)}</td><td class="num">${n0(m.hits)}</td><td class="num">${r2(m.regularRespect)}</td></tr>`).join('')}</tbody></table></div>` : '';
    renderSetup(line);
  }

  function banner(state, live, now, halved) {
    if (now < comp.start) {
      return `<div class="ch-title">${esc(comp.name)}</div><div class="ch-sub">Starts ${tct(comp.start)} TCT · <span data-until="${comp.start}">${span(comp.start - now)}</span> to go</div>`;
    }
    const ongoing = live?.current > 0;
    // The running chain while there is one; after a break, the longest since the start.
    const length = ongoing ? live.current : state.length;
    const pctDone = Math.min(100, (length / comp.goal) * 100);
    const longest = state.length > length ? ` · longest since the start ${n0(state.length)}` : '';
    const left = ongoing ? live.timeout - (now - live.at) : null;
    const pill = state.reached ? '<span class="tag found">Goal reached</span>'
      : halved ? '<span class="tag warn">Chain broke — prizes halved</span>'
      : ongoing ? '<span class="tag found">Chain live</span>' : '<span class="tag">No chain running</span>';
    const timer = ongoing && !state.reached
      ? ` · breaks in <strong data-break="${live.at + live.timeout}" class="${left < 60 ? 'neg' : ''}">${span(left)}</strong>` : '';
    const early = state.early ? '<div class="muted small">A counted chain started before 14:00 TCT, so its earlier hits are included too.</div>' : '';
    return `<div class="ch-title">${esc(comp.name)} ${pill}</div>
      <div class="ch-chain"><span class="ch-count">${n0(length)}</span> / ${n0(comp.goal)} hits${timer}${longest}</div>
      <div class="meter ch-meter"><span style="width:${pctDone.toFixed(1)}%"></span></div>
      <div class="muted small">Started ${tct(comp.start)} TCT · ${span(now - comp.start)} in${state.chains.length > 1 ? ` · ${state.chains.length} chains since the start` : ''}</div>${early}`;
  }

  const placeLabel = (p) => ['1st', '2nd', '3rd', '4th'][p - 1] ?? `${p}th`;

  function teamCard(t) {
    const rows = t.members.map((m, i) => `<tr>
      <td class="num muted">${i + 1}</td>
      <td>${playerLink(m)}</td>
      <td class="num"><strong>${n0(m.hits)}</strong></td>
      <td class="num">${r2(m.regularRespect)}</td>
      <td>${m.qualified ? `<span class="pos" title="${comp.qualify}+ hits: qualified for the team payout">✓</span>` : `<span class="muted small">needs ${n0(comp.qualify - m.hits)}</span>`}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No members matched yet — set them under Teams below.</td></tr>';
    return `<section class="ch-team team-${t.id}">
      <header><h3>${placeLabel(t.place)} · ${esc(t.name)}</h3><span>${r2(t.score)} <span class="muted small">per member</span></span></header>
      <table class="mini"><thead><tr><th></th><th>Member</th><th class="num">Hits</th><th class="num">Respect</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="muted small">${n0(t.hits)} hits · ${n0(t.qualified)} of ${n0(t.size)} qualified · ${shortMoney(t.prizeEach)} each</div>
    </section>`;
  }

  function prizes(table) {
    const soul = table.soulCollector;
    const soulList = soul.leaders.map((m, i) => `<div>${i + 1}. ${playerLink(m)} <span class="muted small">${esc(teamName(m.team))}</span> — ${r2(m.regularRespect)}</div>`).join('')
      || '<div class="muted">No respect yet</div>';
    const raffle = (r) => `<div class="card"><div class="label">${esc(r.name)} · ${shortMoney(r.prize)}</div>
      <div class="value">${n0(r.entrants.length)} <span class="of">in the draw</span></div>
      <div class="sub">Random raffle among ${r.min}+ hits${r.entrants.length ? `: ${r.entrants.map((m) => esc(m.name)).join(', ')}` : ''}</div></div>`;
    return `
      <div class="card"><div class="label">Soul Collector · ${shortMoney(soul.prize)}</div>
        <div class="sub">Highest respect from regular hits (bonus hits don't count)</div>
        <div class="ch-list">${soulList}</div></div>
      ${table.raffles.map(raffle).join('')}
      <div class="card"><div class="label">${esc(table.mvp.name)} · ${shortMoney(table.mvp.prize)}</div>
        <div class="value small">Leadership vote</div><div class="sub">Halloween MVP, chosen by leadership</div></div>`;
  }

  function renderSetup(line) {
    const options = (current) => [['', 'No team'], ...teams.map((t) => [t.id, t.name])]
      .map(([v, l]) => `<option value="${v}"${v === (current ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('');
    // Members on no team first: they're the ones that may need picking by hand.
    const members = [...line.members].sort((a, b) => {
      const ta = line.assignment.get(a.id) ?? ''; const tb = line.assignment.get(b.id) ?? '';
      return ta.localeCompare(tb) || a.name.localeCompare(b.name);
    });
    $('#ch-setup-table tbody').innerHTML = members.map((m) => {
      const changed = String(m.id) in overrides && (overrides[m.id] || null) !== (line.guessed.get(m.id) ?? null);
      return `<tr><td>${playerLink(m)} <span class="muted small">[${m.id}]</span></td><td class="muted">${esc(m.position ?? '')}</td>
        <td><select data-id="${m.id}">${options(line.assignment.get(m.id))}</select>${changed ? ' <span class="muted small">changed</span>' : ''}</td></tr>`;
    }).join('');
    const size = (id) => [...line.assignment.values()].filter((v) => v === id).length;
    const counts = teams.map((t) => `${esc(t.name)} ${size(t.id)}/${t.members.length}`).join(' · ');
    // A name that wasn't found is dealt with once its team has been made up to strength by hand.
    const missing = line.unmatched.filter((u) => size(u.team) < (teams.find((t) => t.id === u.team)?.members.length ?? 0));
    $('#ch-setup-note').innerHTML = `${counts}.${missing.length
      ? ` <span class="warn">Couldn't find ${missing.map((u) => `${esc(u.name)} (${esc(teamName(u.team))})`).join(', ')} in the faction — pick their team by hand.</span>` : ''}`;
    $('#ch-setup').classList.toggle('needs-attention', missing.length > 0);
  }

  // Countdowns tick every second; the chain is re-read every minute while the page is open.
  let sinceRefresh = 0;
  setInterval(() => {
    if (!data.loaded || $('#page-chain').hidden) return;
    const now = Math.floor(Date.now() / 1000);
    document.querySelectorAll('#ch-banner [data-break], #ch-banner [data-until]').forEach((el) => {
      const left = Number(el.dataset.break ?? el.dataset.until) - now;
      el.textContent = span(left);
      el.classList.toggle('neg', el.dataset.break != null && left < 60);
    });
    if (++sinceRefresh >= REFRESH_SECS && $('#ch-auto').checked && ctx.client() && document.visibilityState === 'visible') {
      sinceRefresh = 0;
      load({ quiet: true });
    }
  }, 1000);

  return { load, restoreSaved, render, get live() { return data.live; } };
}
