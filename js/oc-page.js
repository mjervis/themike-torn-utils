import { meta } from './db.js';
import { DEFAULTS as ENERGY, weekWindow } from './energy.js';
import { DEFAULTS, LATE_DAYS, ocReport, newsletterHtml, newsletterText } from './oc.js';

const DAY = 86400;
const OPEN = new Set(['Recruiting', 'Planning']);

/**
 * The Organised Crime page: a week of the faction's OCs — what they made, each member's share of
 * the money, who wasn't in one — and a copy of it for the faction newsletter.
 * Needs a key with faction API access.
 * @param {{ $, store, status, esc, money, num, client: () => object|null, db: () => Promise<object>,
 *   player: () => Promise<{ id: number }>, catalog: () => Promise<Map>, onError: (err) => void }} ctx
 */
export function createOcPage(ctx) {
  const { $, store, status, esc, money, num } = ctx;
  // `saved` is what's kept in the browser: { crimes: { id: crime }, members, membersAt, fetched: { weekStart: at } }.
  const data = { loaded: false, live: false, membersLive: false, saved: null, catalog: new Map() };
  let lastReport = null; // the report on screen, for the newsletter buttons

  // ---------- settings ----------
  const saved = { ...DEFAULTS, ...store.get('oc', {}) };
  $('#oc-share').value = saved.share;
  $('#oc-missing-news').checked = saved.includeMissing;
  $('#oc-items').checked = saved.items;
  $('#oc-refund').checked = saved.refund;
  const read = () => ({
    share: $('#oc-share').value === '' ? DEFAULTS.share : Number($('#oc-share').value),
    items: $('#oc-items').checked,
    refund: $('#oc-refund').checked,
    includeMissing: $('#oc-missing-news').checked,
  });
  const save = () => { store.set('oc', read()); render(); };
  $('#oc-share').addEventListener('change', save);
  $('#oc-items').addEventListener('change', save);
  $('#oc-refund').addEventListener('change', save);
  $('#oc-missing-news').addEventListener('change', save);

  // The week follows the Energy page's faction week start.
  const weekOf = (t) => {
    const e = store.get('energy', {});
    return weekWindow(t, e.weekStartDay ?? ENERGY.weekStartDay, e.weekStartHour ?? ENERGY.weekStartHour);
  };
  let week = weekOf(Date.now() / 1000);
  function setWeek(t) {
    week = weekOf(Math.min(t, Date.now() / 1000));
    $('#oc-date').value = new Date(week.start * 1000).toISOString().slice(0, 10);
    $('#oc-next').disabled = week.end > Date.now() / 1000;
    render();
    if (ctx.client()) load();
  }
  $('#oc-prev').addEventListener('click', () => setWeek(week.start - DAY));
  $('#oc-next').addEventListener('click', () => setWeek(week.end + 1));
  $('#oc-this').addEventListener('click', () => setWeek(Date.now() / 1000));
  $('#oc-date').addEventListener('change', () => {
    const t = Date.parse(`${$('#oc-date').value}T12:00:00Z`) / 1000;
    if (Number.isFinite(t)) setWeek(t);
  });
  $('#oc-date').value = new Date(week.start * 1000).toISOString().slice(0, 10);
  $('#oc-next').disabled = true;
  $('#oc-refresh').addEventListener('click', () => load({ force: true }));
  $('#oc-copy-rich').addEventListener('click', () => copy('rich'));
  $('#oc-copy-html').addEventListener('click', () => copy('html'));

  // ---------- loading ----------
  let loading = null;
  function load(opts = {}) {
    loading ??= loadNow(opts).finally(() => { loading = null; });
    return loading;
  }

  async function loadNow({ force = false } = {}) {
    const client = ctx.client();
    if (!client) return status('Add your API key on the Settings tab to see your faction\'s organised crimes.');
    $('#oc-refresh').disabled = true;
    try {
      const db = await ctx.db();
      status('Checking your key…');
      const player = (await ctx.player()).id;
      const before = client.calls;
      const key = `oc:${player}`;
      const s = data.player === player && data.saved ? data.saved : (await meta.get(db, key)) ?? { crimes: {}, members: [], fetched: {} };
      const now = Math.floor(Date.now() / 1000);
      const { start, end } = week;
      // OCs joined in the week can finish up to LATE_DAYS after it; once that's passed, the week is final.
      const until = Math.min(now, end + LATE_DAYS * DAY);
      if (!data.membersLive || data.player !== player) {
        status('Reading the faction\'s members…');
        s.members = (await client.factionMembers()).map((m) => ({
          id: m.id, name: m.name, position: m.position, level: m.level, days_in_faction: m.days_in_faction,
          last_action: m.last_action, is_in_oc: m.is_in_oc,
        }));
        s.membersAt = now;
      }
      if (force || !(s.fetched[start] >= end + LATE_DAYS * DAY)) {
        status('Reading the faction\'s organised crimes…');
        const done = await client.factionCrimes({ cat: 'completed', filters: 'executed_at', from: start, to: until });
        for (const c of done) s.crimes[c.id] = c;
        if (until >= now - DAY) {
          // OCs still recruiting or planning; any saved as open that aren't any more have finished or expired.
          const open = await client.factionCrimes({ cat: 'available' });
          for (const [id, c] of Object.entries(s.crimes)) if (OPEN.has(c.status)) delete s.crimes[id];
          for (const c of open) s.crimes[c.id] = c;
        }
        s.fetched[start] = until;
      }
      s.at = now;
      await meta.set(db, key, s);
      const hasItems = Object.values(s.crimes).some((c) => c.rewards?.items?.length || c.slots?.some((sl) => sl.item_requirement));
      // Item rewards and items used are valued at today's market prices (re-read at most every 15 minutes).
      if (hasItems) data.catalog = await ctx.catalog();
      Object.assign(data, { loaded: true, live: true, membersLive: true, player, saved: s });
      $('#oc-results').hidden = false;
      render();
      const calls = client.calls - before;
      status(`Up to date. ${calls} API call${calls === 1 ? '' : 's'} for this week.`);
    } catch (err) {
      if (err.code === 6 || err.code === 7 || err.code === 16) {
        status('Reading your faction\'s organised crimes needs a key with faction API access. Ask faction leadership to give your position "Faction API access", and make sure the key includes faction → crimes and members.', true);
        return;
      }
      ctx.onError(err);
    } finally {
      $('#oc-refresh').disabled = false;
    }
  }

  /** Show what's saved in this browser without a key or API calls. Returns when it's from, or null. */
  async function restoreSaved({ db, player, catalog }) {
    if (data.loaded) return null;
    const s = await meta.get(db, `oc:${player}`);
    if (!s?.at || data.loaded) return null;
    Object.assign(data, { loaded: true, player, saved: s, catalog: catalog?.size ? catalog : data.catalog });
    $('#oc-results').hidden = false;
    render();
    return s.at;
  }

  // ---------- rendering ----------
  const tct = (t) => new Date(t * 1000).toLocaleString('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const dayFmt = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const n0 = (n) => (n == null || !Number.isFinite(n) ? '—' : num.format(Math.round(n)));
  const plural = (n, word) => `${n0(n)} ${word}${n === 1 ? '' : 's'}`;
  const who = (id, name) => `<a href="https://www.torn.com/profiles.php?XID=${id}" target="_blank" rel="noopener">${esc(name ?? `#${id}`)}</a>`;
  function ago(t) {
    if (!t) return '—';
    const s = Math.max(0, Date.now() / 1000 - t);
    return s < 3600 ? `${Math.round(s / 60)}m ago` : s < DAY ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / DAY)}d ago`;
  }

  function report() {
    const s = data.saved;
    const crimes = Object.values(s.crimes ?? {});
    return ocReport(crimes, s.members ?? [], {
      start: week.start, end: week.end, share: read().share, items: read().items, refund: read().refund, now: s.membersAt ?? Date.now() / 1000,
      itemValue: (id) => data.catalog.get(id)?.value?.market_price ?? null,
      itemName: (id) => data.catalog.get(id)?.name ?? null,
    });
  }

  function render() {
    $('#oc-week').textContent = `${dayFmt(week.start)} – ${dayFmt(week.end - 1)}`;
    if (!data.loaded) return;
    const s = data.saved;
    const r = report();
    const t = r.totals;
    const now = Date.now() / 1000;
    const names = new Map((s.members ?? []).map((m) => [m.id, m.name]));
    const fetchedTo = s.fetched?.[week.start];

    const e = store.get('energy', {});
    const startDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][e.weekStartDay ?? ENERGY.weekStartDay];
    $('#oc-asof').textContent = `Weeks start ${startDay} ${String(e.weekStartHour ?? ENERGY.weekStartHour).padStart(2, '0')}:00 TCT (set on the Energy page) · `
      + (fetchedTo ? `OCs read ${tct(s.at)} TCT` : 'this week hasn\'t been read from Torn yet');
    // A week that's never been read would show as no OCs, so show nothing until it has been.
    $('#oc-body').hidden = !fetchedTo;
    $('#oc-notice').hidden = !!fetchedTo;
    $('#oc-notice').textContent = ctx.client() ? 'Reading this week from Torn…'
      : 'This week hasn\'t been read from Torn on this device. Add your API key on the Settings tab to read it.';

    const state = week.end > now ? ' · week in progress' : '';
    const noOc = r.missing.filter((m) => !m.pending).length;
    $('#oc-cards').innerHTML = `
      <div class="card"><div class="label">OCs completed</div><div class="value">${n0(t.ocs)}</div>
        <div class="sub">${n0(t.successful)} successful · ${n0(t.failed)} failed${esc(state)}</div></div>
      <div class="card"><div class="label">Total take</div><div class="value">${money(t.money)}</div>
        <div class="sub">${t.withItems && t.itemsValue ? `${money(t.cash)} cash + ${money(t.itemsValue)} items` : 'cash from successful OCs'}${t.respect ? ` · ${n0(t.respect)} respect` : ''}</div></div>
      <div class="card"><div class="label">To players · ${n0(t.share)}%</div><div class="value pos">${money(t.toPlayers)}</div>
        <div class="sub">split evenly between each OC's players</div></div>
      <div class="card"><div class="label">Faction keeps · ${n0(100 - t.share)}%</div><div class="value pos">${money(t.toFaction)}</div>
        <div class="sub">of the week's OC ${t.withItems ? 'take' : 'cash'}</div></div>
      <div class="card"><div class="label">Members taking part</div><div class="value">${n0(t.participants)}<span class="of"> / ${n0(t.members)}</span></div>
        <div class="sub">${t.participants ? `${t.perPlayer.toFixed(1)} OCs each on average` : 'nobody yet'}</div></div>
      <div class="card"><div class="label">No OC</div><div class="value ${noOc ? 'neg' : 'pos'}">${n0(noOc)}</div>
        <div class="sub">${r.missing.length - noOc ? `plus ${n0(r.missing.length - noOc)} in an OC still running` : 'current members'}</div></div>
      ${t.cost || t.kitValue ? `<div class="card"><div class="label">Items used</div><div class="value ${t.cost ? 'neg' : ''}">${money(t.cost)}</div>
        <div class="sub">${[t.used ? `${n0(t.used)} used up` : '', t.lost ? `${n0(t.lost)} lost` : ''].filter(Boolean).join(' · ') || 'nothing used up'}`
          + `${t.cost ? ` · take after items ${money(t.net)}` : ''}${t.refund && t.refunded ? ` · ${money(t.refunded)} armoury items paid back to the faction first` : ''}`
          + `${t.kitValue ? ` · reusable kit needed ${money(t.kitValue)} (${plural(t.kit, 'item')})` : ''}`
          + `${t.costUnpriced ? ` · <span class="warn">${n0(t.costUnpriced)} with no price</span>` : ''}</div></div>` : ''}
      ${r.items.length ? `<div class="card"><div class="label">Item rewards</div><div class="value">${t.itemsValue ? money(t.itemsValue) : n0(r.items.reduce((n, i) => n + i.qty, 0))}</div>
        <div class="sub">${esc(r.items.map((i) => `${n0(i.qty)}× ${i.name ?? `#${i.id}`}`).join(', '))} · ${t.withItems ? 'at market value, in the split' : 'market value, not in the split'}${t.unpriced ? ` · <span class="warn">${n0(t.unpriced)} with no price</span>` : ''}</div></div>` : ''}`;

    $('#oc-players tbody').innerHTML = r.players.map((p, i) => `<tr>
      <td class="num">${i + 1}</td><td class="name">${who(p.id, p.name)}${p.member ? '' : ' <span class="tag">left</span>'}</td>
      <td class="num">${n0(p.ocs)}</td><td class="num">${n0(p.successful)}</td><td class="num">${p.failed ? n0(p.failed) : '<span class="muted">0</span>'}</td>
      <td class="num">${p.supplied ? money(p.supplied) : '<span class="muted">—</span>'}</td>
      <td class="num">${money(p.money)}</td></tr>`).join('')
      || '<tr><td colspan="7" class="muted">No OCs completed in this week.</td></tr>';
    $('#oc-players tfoot').innerHTML = r.players.length ? `<tr><th></th><th>Total</th><th class="num">${n0(t.slots)}</th>
      <th class="num">${n0(r.players.reduce((n, p) => n + p.successful, 0))}</th><th class="num">${n0(r.players.reduce((n, p) => n + p.failed, 0))}</th>
      <th class="num">${money(r.players.reduce((n, p) => n + p.supplied, 0))}</th><th class="num">${money(t.toPlayers)}</th></tr>` : '';

    $('#oc-missing-title').textContent = `No OC this week (${n0(r.missing.length)})`;
    $('#oc-missing tbody').innerHTML = r.missing.map((m) => {
      const note = [
        m.pending ? `In ${esc(m.pending.name)} — ${m.pending.executed ? `finished ${esc(tct(m.pending.executed))}` : esc(m.pending.status.toLowerCase())}` : '',
        m.joinedMidWeek ? 'joined the faction mid-week' : '',
      ].filter(Boolean).join(' · ');
      return `<tr${m.pending ? ' class="muted"' : ''}><td class="name">${who(m.id, m.name)}</td><td>${esc(m.position ?? '')}</td>
        <td class="num">${n0(m.level)}</td><td class="num">${n0(m.daysInFaction)}</td><td>${ago(m.lastAction)}</td><td>${note}</td></tr>`;
    }).join('') || `<tr><td colspan="6" class="muted">${s.members?.length ? 'Every member was in an OC this week.' : 'No member list saved yet.'}</td></tr>`;

    $('#oc-crimes tbody').innerHTML = [...r.crimes].reverse().map((c) => `<tr>
      <td>${tct(c.executed)}</td><td>${esc(c.name)} <span class="muted small">level ${n0(c.difficulty)}</span></td>
      <td>${c.status === 'Successful' ? '<span class="pos">Success</span>' : '<span class="neg">Failed</span>'}</td>
      <td class="wrap">${c.players.map((id) => who(id, names.get(id))).join(', ')}</td>
      <td class="wrap">${c.items.length ? `${esc(c.items.map((i) => `${n0(i.qty)}× ${i.name ?? `#${i.id}`}`).join(', '))} <span class="muted small">${c.itemsValue ? money(c.itemsValue) : 'no price'}</span>` : '<span class="muted">—</span>'}</td>
      <td class="wrap">${c.used.length ? `${esc(c.used.map((u) => `${u.name ?? `#${u.id}`}${u.lost ? ' (lost)' : ''}`).join(', '))} <span class="muted small">${c.cost ? money(c.cost) : 'no price'}</span>` : '<span class="muted">—</span>'}</td>
      <td class="num">${money(c.money)}</td><td class="num">${money(c.toPlayers)}</td><td class="num">${money(c.toFaction)}</td>
      <td class="num">${c.respect ? n0(c.respect) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="10" class="muted">No OCs completed in this week.</td></tr>';

    $('#oc-news-preview').innerHTML = newsletterHtml(r, { ...week, includeMissing: read().includeMissing });
    lastReport = r;
  }

  // ---------- newsletter ----------
  async function copy(kind) {
    if (!lastReport) return;
    const opts = { ...week, includeMissing: read().includeMissing };
    const html = newsletterHtml(lastReport, opts);
    const text = newsletterText(lastReport, opts);
    const btn = kind === 'rich' ? $('#oc-copy-rich') : $('#oc-copy-html');
    try {
      if (kind === 'rich' && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(kind === 'rich' ? text : html);
      }
    } catch {
      // Some browsers (and embedded views) refuse the Clipboard API; copying a selection still works there.
      if (!copySelection(kind === 'rich' ? html : null, kind === 'rich' ? null : html)) {
        status('Your browser blocked the clipboard. Select the preview below and copy it by hand.', true);
        return;
      }
    }
    status(kind === 'rich' ? 'Report copied — paste it into the newsletter editor.' : 'HTML copied — paste it into the editor\'s source / HTML view.');
    const label = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = label; }, 1500);
  }

  /** Copy formatted `html`, or `plain` text, by selecting it off-screen and using the old copy command. */
  function copySelection(html, plain) {
    const el = document.createElement(html ? 'div' : 'textarea');
    el.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;color:#000';
    if (html) el.innerHTML = html; else el.value = plain;
    document.body.append(el);
    const sel = window.getSelection();
    try {
      if (html) { const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range); } else el.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      sel.removeAllRanges();
      el.remove();
    }
  }

  render();
  return { load, restoreSaved, render, get live() { return !!data.live; } };
}
