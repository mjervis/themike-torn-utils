// Faction Organised Crime report: what the faction's OCs made in a week, what each member earned
// from them, and which members weren't in one. Pure functions only — times are unix seconds, TCT is UTC.

const DAY = 86400;

export const DEFAULTS = {
  share: 90,          // % of each OC's take paid out to the players who ran it; the faction keeps the rest
  items: true,        // count item rewards in the take at market value
  refund: false,      // pay the faction back for armoury items used up or lost in an OC before the split
  includeMissing: true, // list members with no OC in the newsletter
};

/** How long after a week ends an OC joined in it may still finish (planning can take days). */
export const LATE_DAYS = 7;

const isDone = (c) => c.status === 'Successful' || c.status === 'Failure';
const playersIn = (c) => (c.slots ?? []).map((s) => s.user?.id).filter((id) => id != null);

/** The share setting as a fraction, clamped to 0–100%. */
export const shareOf = (pct) => Math.min(100, Math.max(0, Number.isFinite(+pct) ? +pct : DEFAULTS.share)) / 100;

/**
 * The OC report for the week `start`–`end`:
 *  { crimes, players, missing, totals }
 * An OC counts in the week it was executed. Its take — cash, plus item rewards at `itemValue` when
 * `items` is on — is split `share`% to the players in its slots (evenly, as Torn's payouts do) and the
 * rest to the faction; failed OCs count as OCs that made nothing. Items with no price add nothing.
 * `missing` is every current member with no OC executed in the week, noting anyone who joined one
 * in the week that hadn't finished by the end of it, and anyone who joined the faction mid-week.
 * Items the players needed are priced too: single-use items used up and reusable ones lost cost the
 * OC (Torn records this for OCs from late July 2025). With `refund` on, items from the faction's
 * armoury are paid back to the faction out of the OC's take (as far as it covers them) before the
 * split; members aren't paid back for their own items. Reusable items that came back are reported as
 * kit the OCs needed, not as a cost.
 * `itemValue(id)` prices items (e.g. at market value) and `itemName(id)` names them.
 */
export function ocReport(crimes, members, {
  start, end, share = DEFAULTS.share, items: withItems = DEFAULTS.items, refund = DEFAULTS.refund, now = Date.now() / 1000, itemValue = () => null, itemName = () => null,
}) {
  const frac = shareOf(share);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const players = new Map();
  const player = (id) => {
    let p = players.get(id);
    if (!p) players.set(id, p = { id, name: names.get(id) ?? null, member: names.has(id), ocs: 0, successful: 0, failed: 0, money: 0, supplied: 0 });
    return p;
  };

  const inWeek = crimes.filter((c) => isDone(c) && c.executed_at >= start && c.executed_at < end)
    .sort((a, b) => a.executed_at - b.executed_at);
  const items = new Map();
  const kitHeld = new Map(); // reusable items the OCs needed, once per player and item
  const rows = inWeek.map((c) => {
    const ids = playersIn(c);
    const ok = c.status === 'Successful';
    const got = ok ? c.rewards?.items ?? [] : [];
    const cash = ok ? c.rewards?.money ?? 0 : 0;
    const itemsValue = got.reduce((t, it) => t + (itemValue(it.id) ?? 0) * (it.quantity ?? 0), 0);
    const unpriced = got.filter((it) => itemValue(it.id) == null).length;
    const money = cash + (withItems ? itemsValue : 0);

    const used = [];
    const kit = [];
    for (const s of c.slots ?? []) {
      const req = s.item_requirement;
      const out = s.user?.item_outcome;
      // A reusable item marked "used" came back; one that's "lost" didn't. Single-use items are used up.
      if (out && (out.outcome === 'lost' || (out.outcome === 'used' && !req?.is_reusable))) {
        used.push({
          id: out.item_id, name: itemName(out.item_id), value: itemValue(out.item_id), lost: out.outcome === 'lost',
          reusable: !!req?.is_reusable, by: out.owned_by === 'faction' ? null : s.user.id,
        });
      } else if (req?.is_reusable && s.user?.id != null) {
        const k = { id: req.id, name: itemName(req.id), value: itemValue(req.id), player: s.user.id };
        kit.push(k);
        kitHeld.set(`${k.player}:${k.id}`, k);
      }
    }
    const cost = used.reduce((t, u) => t + (u.value ?? 0), 0);
    const armoury = used.reduce((t, u) => t + (u.by == null ? u.value ?? 0 : 0), 0);
    const refunded = refund ? Math.min(armoury, money) : 0;
    const toPlayers = (money - refunded) * frac;
    for (const id of ids) {
      const p = player(id);
      p.ocs++;
      if (ok) p.successful++; else p.failed++;
      p.money += ids.length ? toPlayers / ids.length : 0;
    }
    for (const u of used) if (u.by != null) player(u.by).supplied += u.value ?? 0;
    for (const it of got) {
      const row = items.get(it.id) ?? { id: it.id, name: itemName(it.id), qty: 0, value: itemValue(it.id) };
      row.qty += it.quantity ?? 0;
      items.set(it.id, row);
    }
    return {
      id: c.id, name: c.name, difficulty: c.difficulty, status: c.status, executed: c.executed_at,
      players: ids, cash, itemsValue, unpriced, money, toPlayers, toFaction: money - toPlayers, respect: ok ? c.rewards?.respect ?? 0 : 0,
      used, cost, refunded, net: money - cost, kit, kitValue: kit.reduce((t, k) => t + (k.value ?? 0), 0),
      items: got.map((it) => ({ id: it.id, name: itemName(it.id), qty: it.quantity ?? 0, value: itemValue(it.id) })),
    };
  });

  // Joined an OC in the week that was still recruiting, planning or finished after the week ended.
  const pending = new Map();
  for (const c of crimes) {
    if (c.status === 'Expired' || (isDone(c) && c.executed_at < end)) continue;
    for (const s of c.slots ?? []) {
      if (s.user?.id != null && s.user.joined_at < end) pending.set(s.user.id, c);
    }
  }
  const missing = members
    .filter((m) => !players.has(m.id))
    .map((m) => {
      const joined = m.days_in_faction != null ? now - m.days_in_faction * DAY : null;
      const c = pending.get(m.id);
      return {
        id: m.id, name: m.name, position: m.position ?? null, level: m.level ?? null,
        daysInFaction: m.days_in_faction ?? null, lastAction: m.last_action?.timestamp ?? null,
        joinedMidWeek: joined != null && joined > start,
        pending: c ? { id: c.id, name: c.name, status: c.status, executed: isDone(c) ? c.executed_at : null } : null,
      };
    })
    // Someone who joined the faction after the week ended wasn't there to take part.
    .filter((m) => m.daysInFaction == null || now - m.daysInFaction * DAY < end + DAY)
    .sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.name.localeCompare(b.name));

  const list = [...players.values()].sort((a, b) => b.money - a.money || b.ocs - a.ocs || (a.name ?? '').localeCompare(b.name ?? ''));
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);
  const itemList = [...items.values()].sort((a, b) => (b.value ?? 0) * b.qty - (a.value ?? 0) * a.qty);
  const slots = rows.reduce((t, r) => t + r.players.length, 0);
  const allUsed = rows.flatMap((r) => r.used);
  const kitList = [...kitHeld.values()];
  return {
    crimes: rows,
    players: list,
    missing,
    items: itemList,
    totals: {
      ocs: rows.length,
      successful: rows.filter((r) => r.status === 'Successful').length,
      failed: rows.filter((r) => r.status === 'Failure').length,
      cash: sum('cash'),
      itemsValue: sum('itemsValue'),
      unpriced: itemList.filter((i) => i.value == null).length,
      withItems,
      money: sum('money'),
      toPlayers: sum('toPlayers'),
      toFaction: sum('toFaction'),
      cost: sum('cost'),
      used: allUsed.filter((u) => !u.lost).length,
      lost: allUsed.filter((u) => u.lost).length,
      costUnpriced: allUsed.filter((u) => u.value == null).length,
      refunded: sum('refunded'),
      refund,
      net: sum('net'),
      kit: kitList.length,
      kitValue: kitList.reduce((t, k) => t + (k.value ?? 0), 0),
      respect: sum('respect'),
      slots,
      participants: list.length,
      perPlayer: list.length ? slots / list.length : 0,
      members: members.length,
      share: frac * 100,
    },
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n0 = (n) => Math.round(n).toLocaleString('en-GB');
const cash = (n) => `$${n0(n)}`;
const dayFmt = (t) => new Date(t * 1000).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const profile = (p) => `<a href="https://www.torn.com/profiles.php?XID=${p.id}">${esc(p.name ?? `#${p.id}`)}</a>`;

/**
 * The report as simple HTML for a faction newsletter: headings, short paragraphs and plain tables,
 * with only inline styles, so it survives being pasted into Torn's editor.
 */
export function newsletterHtml(report, { start, end, includeMissing = DEFAULTS.includeMissing } = {}) {
  const t = report.totals;
  const cell = 'style="padding:2px 8px;border-bottom:1px solid #999;text-align:left"';
  const num = 'style="padding:2px 8px;border-bottom:1px solid #999;text-align:right"';
  const parts = [];
  parts.push(`<h2>Organised Crime report</h2>`);
  parts.push(`<p><i>${esc(dayFmt(start))} – ${esc(dayFmt(end - 1))} (TCT)</i></p>`);
  if (!t.ocs) {
    parts.push('<p>No organised crimes were completed this week.</p>');
  } else {
    parts.push(`<p><b>${n0(t.ocs)}</b> OC${t.ocs === 1 ? '' : 's'} completed (${n0(t.successful)} successful, ${n0(t.failed)} failed), `
      + `with <b>${n0(t.participants)}</b> member${t.participants === 1 ? '' : 's'} taking part — ${t.perPlayer.toFixed(1)} OCs each on average.</p>`);
    const split = t.withItems && t.itemsValue ? ` (${cash(t.cash)} cash + ${cash(t.itemsValue)} in items at market value)` : '';
    parts.push(`<p>Total take: <b>${cash(t.money)}</b>${split}<br>Paid to players (${n0(t.share)}%): <b>${cash(t.toPlayers)}</b><br>`
      + `Kept by the faction (${n0(100 - t.share)}%): <b>${cash(t.toFaction)}</b>`
      + `${t.respect ? `<br>Respect earned: <b>${n0(t.respect)}</b>` : ''}</p>`);
    if (t.cost || t.kitValue) {
      const spent = [t.used ? `${n0(t.used)} used up` : '', t.lost ? `${n0(t.lost)} lost` : ''].filter(Boolean).join(', ');
      parts.push('<p>'
        + (t.cost ? `Items used in the OCs: <b>${cash(t.cost)}</b> (${spent}, at market value)`
          + `${t.refund && t.refunded ? ` — ${cash(t.refunded)} of it paid back to the faction for armoury items before the split` : ''}<br>`
          + `Take after items: <b>${cash(t.net)}</b>` : '')
        + (t.kitValue ? `${t.cost ? '<br>' : ''}Reusable items needed: ${cash(t.kitValue)} (${n0(t.kit)} item${t.kit === 1 ? '' : 's'}, all returned to their owners)` : '')
        + '</p>');
    }
    if (report.items.length) {
      parts.push(`<p>Item rewards: ${report.items.map((i) => `${n0(i.qty)}× ${esc(i.name ?? `item #${i.id}`)}`).join(', ')}`
        + `${t.itemsValue && !t.withItems ? ` (about ${cash(t.itemsValue)} at market value, not included above)` : ''}</p>`);
    }
    parts.push('<h3>Earnings by member</h3>');
    parts.push(`<table style="border-collapse:collapse"><thead><tr><th ${cell}>#</th><th ${cell}>Member</th><th ${num}>OCs</th><th ${num}>Successful</th><th ${num}>Earned</th></tr></thead><tbody>`
      + report.players.map((p, i) => `<tr><td ${cell}>${i + 1}</td><td ${cell}>${profile(p)}</td><td ${num}>${n0(p.ocs)}</td><td ${num}>${n0(p.successful)}</td><td ${num}>${cash(p.money)}</td></tr>`).join('')
      + '</tbody></table>');
  }
  if (includeMissing) {
    const none = report.missing.filter((m) => !m.pending);
    const waiting = report.missing.filter((m) => m.pending);
    parts.push('<h3>No OC this week</h3>');
    parts.push(none.length
      ? `<p>${none.map((m) => `${profile(m)}${m.joinedMidWeek ? ' (new)' : ''}`).join(', ')}</p>`
      : '<p>Everyone took part in an OC this week. 🎉</p>');
    if (waiting.length) parts.push(`<p><i>In an OC that hadn't finished by the end of the week:</i> ${waiting.map(profile).join(', ')}</p>`);
  }
  return parts.join('\n');
}

/** The report as plain text, for pasting where HTML isn't accepted. */
export function newsletterText(report, opts = {}) {
  return newsletterHtml(report, opts)
    .replace(/<br>/g, '\n').replace(/<\/(p|h2|h3|tr|table)>/g, '\n').replace(/<\/t[dh]>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
