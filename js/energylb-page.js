import { meta } from './db.js';
import { DEFAULTS as ENERGY, weekWindow } from './energy.js';
import { addSnapshot, contributorMap, leaderboard, leaderboardText, weekSnapshots } from './energylb.js';
import { copyFrom } from './share.js';

const DAY = 86400;

/**
 * The Faction energy page: a week's gym energy per member, as two leaderboards (1.2m+ total battle
 * stats and under), with anyone who overdosed in the week highlighted. Needs a key with faction API access.
 * @param {{ $, store, status, esc, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, onError: (err) => void }} ctx
 */
export function createEnergyLbPage(ctx) {
  const { $, store, status, esc, num } = ctx;
  // `saved` is kept in the browser: { snaps: [{ at, energy, od }], members, membersAt, at }.
  const data = { loaded: false, live: false, player: null, saved: null };
  let summary = '';

  // Who has 1.2m+ battle stats: Torn doesn't share other players' stats, so it's ticked by hand.
  const big = () => store.get('energylb', {}).big ?? {};
  function setBig(id, on) {
    const s = store.get('energylb', {});
    const b = { ...(s.big ?? {}) };
    if (on) b[id] = true; else delete b[id];
    store.set('energylb', { ...s, big: b });
    render();
  }

  // ---------- week picker (weeks follow the Energy page's faction week start) ----------
  const weekOf = (t) => {
    const e = store.get('energy', {});
    return weekWindow(t, e.weekStartDay ?? ENERGY.weekStartDay, e.weekStartHour ?? ENERGY.weekStartHour);
  };
  let week = weekOf(Date.now() / 1000);
  function setWeek(t) {
    week = weekOf(Math.min(t, Date.now() / 1000));
    $('#el-date').value = new Date(week.start * 1000).toISOString().slice(0, 10);
    $('#el-next').disabled = week.end > Date.now() / 1000;
    render();
  }
  $('#el-prev').addEventListener('click', () => setWeek(week.start - DAY));
  $('#el-next').addEventListener('click', () => setWeek(week.end + 1));
  $('#el-this').addEventListener('click', () => setWeek(Date.now() / 1000));
  $('#el-date').addEventListener('change', () => {
    const t = Date.parse(`${$('#el-date').value}T12:00:00Z`) / 1000;
    if (Number.isFinite(t)) setWeek(t);
  });
  $('#el-date').value = new Date(week.start * 1000).toISOString().slice(0, 10);
  $('#el-next').disabled = true;
  $('#el-refresh').addEventListener('click', () => load());
  $('#el-copy').addEventListener('click', () => copyFrom($('#el-copy'), () => summary, status));
  $('#el-results').addEventListener('change', (e) => {
    const box = e.target.closest('input[data-big]');
    if (box) setBig(box.dataset.big, box.checked);
  });

  // ---------- loading ----------
  let loading = null;
  function load() {
    loading ??= loadNow().finally(() => { loading = null; });
    return loading;
  }

  async function loadNow() {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to see your faction\'s gym energy.');
    $('#el-refresh').disabled = true;
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      const before = client.calls;
      const key = `energylb:${player}`;
      const s = data.player === player && data.saved ? data.saved : (await meta.get(db, key)) ?? { snaps: [], members: [] };
      status('Reading the faction\'s members…');
      s.members = (await client.factionMembers()).map((m) => ({
        id: m.id, name: m.name, position: m.position, level: m.level, days_in_faction: m.days_in_faction, last_action: m.last_action,
      }));
      s.membersAt = Math.floor(Date.now() / 1000);
      status('Reading gym energy and overdoses…');
      const energy = contributorMap(await client.factionContributors('gymenergy'));
      const od = contributorMap(await client.factionContributors('drugoverdoses'));
      const now = Math.floor(Date.now() / 1000);
      s.snaps = addSnapshot(s.snaps, { at: now, energy, od });
      s.at = now;
      await meta.set(db, key, s);
      Object.assign(data, { loaded: true, live: true, player, saved: s });
      render();
      const calls = client.calls - before;
      status(`Up to date. ${calls} API call${calls === 1 ? '' : 's'}.`);
    } catch (err) {
      if (err.code === 6 || err.code === 7 || err.code === 16) {
        status('Reading your faction\'s gym energy needs a key with faction API access. Ask faction leadership to give your position "Faction API access", and make sure the key includes faction → contributors and members.', true);
        return;
      }
      ctx.onError(err);
    } finally {
      $('#el-refresh').disabled = false;
    }
  }

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player }) {
    if (data.loaded) return null;
    const s = await meta.get(db, `energylb:${player}`);
    if (!s?.at || data.loaded) return null;
    Object.assign(data, { loaded: true, player, saved: s });
    render();
    return s.at;
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const dayFmt = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const shortDay = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const who = (id, name) => `<a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener">${esc(name ?? `#${id}`)}</a>`;

  function rows(list, target) {
    if (!list.length) return '<tr><td colspan="6" class="muted">Nobody here — tick “1.2m+” on a member to move them.</td></tr>';
    return list.map((r) => {
      const od = r.overdoses > 0;
      const met = target > 0 && r.energy >= target;
      const tags = [
        od ? `<span class="tag od-tag">Overdose${r.overdoses > 1 ? ` ×${r.overdoses}` : ''}</span>` : '',
        r.joined ? '<span class="tag">joined mid-week</span>' : '',
        r.firstSeen ? `<span class="tag" title="Not in the faction's totals at the start of this window, so counted from the first read that includes them">counted from first read</span>` : '',
      ].join(' ');
      return `<tr class="${od ? 'od' : ''}">
        <td class="num">${r.rank}</td><td class="name">${who(r.id, r.name)} ${tags}</td>
        <td class="num">${n0(r.level)}</td>
        <td class="num ${r.energy ? '' : 'muted'}">${n0(r.energy)}</td>
        <td class="num ${target > 0 ? (met ? 'pos' : 'neg') : 'muted'}">${r.ofTarget == null ? '—' : `${Math.round(r.ofTarget * 100)}%`}</td>
        <td><label class="check"><input type="checkbox" data-big="${r.id}"${r.big ? ' checked' : ''}> 1.2m+</label></td></tr>`;
    }).join('');
  }

  function render() {
    $('#el-week').textContent = `${dayFmt(week.start)} – ${dayFmt(week.end - 1)}`;
    if (!data.loaded) return;
    $('#el-results').hidden = false;
    const s = data.saved;
    const now = Date.now() / 1000;
    const e = store.get('energy', {});
    const target = e.target ?? ENERGY.target;
    const startDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][e.weekStartDay ?? ENERGY.weekStartDay];
    const pair = weekSnapshots(s.snaps ?? [], { ...week, now });
    $('#el-asof').textContent = `Weeks start ${startDay} ${String(e.weekStartHour ?? ENERGY.weekStartHour).padStart(2, '0')}:00 TCT and the target is ${n0(target)} (set on the Energy page) · last read ${s.at ? `${tct(s.at)} TCT` : 'never'}`;
    $('#el-body').hidden = !pair;
    $('#el-notice').hidden = !!pair;
    if (!pair) {
      const first = s.snaps?.[0]?.at;
      summary = '';
      $('#el-notice').textContent = week.end <= (first ?? now)
        ? `There's no gym energy saved for this week: this device first read the faction's totals on ${first ? `${tct(first)} TCT` : 'no date yet'}.`
        : `Torn only gives each member's running total, so a week's energy is the change between two reads. The first read for this week was ${tct(first ?? now)} TCT — come back (or press Refresh) later and the leaderboard fills in from then.`;
      return;
    }

    const notes = [
      pair.late ? `the first read for this week was ${tct(pair.from.at)} TCT, so energy used before then isn't counted` : '',
      pair.early ? `the nearest read to the week's start was ${tct(pair.from.at)} TCT, before it began, so a little of the previous week is included` : '',
      pair.short ? `the last read in this week was ${tct(pair.to.at)} TCT, so energy after that isn't counted` : '',
      pair.over ? `the nearest read to the week's end was ${tct(pair.to.at)} TCT, after it ended, so a little of the next week is included` : '',
    ].filter(Boolean);
    $('#el-window').innerHTML = `Gym energy from <strong>${esc(tct(pair.from.at))}</strong> to <strong>${esc(tct(pair.to.at))}</strong> TCT${notes.length ? ` — <span class="warn">${esc(notes.join('; '))}</span>` : ''}.`;

    const board = leaderboard({ from: pair.from, to: pair.to, members: s.members ?? [], membersAt: s.membersAt, big: big(), target });
    const t = board.totals;
    const card = (label, value, sub, cls = '') => `<div class="card"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
    $('#el-cards').innerHTML = [
      card('Faction gym energy', n0(t.all.energy), `${n0(t.all.members)} members · ${t.all.members ? n0(t.all.energy / t.all.members) : '—'} each on average${week.end > now ? ' · week in progress' : ''}`),
      card('1.2m+ stats', n0(t.high.energy), `${n0(t.high.members)} members${t.high.metTarget != null ? ` · ${n0(t.high.metTarget)} hit the target` : ''}`),
      card('Under 1.2m stats', n0(t.low.energy), `${n0(t.low.members)} members${t.low.metTarget != null ? ` · ${n0(t.low.metTarget)} hit the target` : ''}`),
      card('Overdosed', n0(t.all.overdosed), t.all.overdosed ? `${n0(t.all.overdoses)} overdose${t.all.overdoses === 1 ? '' : 's'} this week` : 'nobody this week', t.all.overdosed ? 'neg' : 'pos'),
      card('No gym energy', n0(t.all.zero), 'members who didn\'t train', t.all.zero ? 'neg' : ''),
    ].join('');
    $('#el-high-title').textContent = `1.2m+ stats (${n0(t.high.members)})`;
    $('#el-low-title').textContent = `Under 1.2m stats (${n0(t.low.members)})`;
    $('#el-high tbody').innerHTML = rows(board.high, target);
    $('#el-low tbody').innerHTML = rows(board.low, target);
    summary = leaderboardText(board, { label: `${shortDay(week.start)}–${shortDay(week.end - 1)}` });
  }

  render();
  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
