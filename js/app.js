import { createClient } from './api.js';
import {
  saleRoutes, isPurchaseLogTitle, isDefaultPurchaseLog, isFindLogTitle, isDefaultFindLog,
  lotsByItem, costBasis, profit, breakEven,
} from './costing.js';
import { openDb, STORES, meta } from './db.js';
import {
  keyFingerprint, identify, loadCatalog, loadLogTypes, loadInventory,
  syncLogs, backfillOlder, historyCoverage, savedSnapshots, saveSnapshotFor, savedLogs,
} from './sync.js';
import { buildSnapshot, series, snapshotOnOrBefore, itemChanges, utcDate, lineChart } from './history.js';
import { ITEM_TYPES, DEFAULT_TRADE_TYPES, GROUPS, classify } from './categories.js';
import { createEnergyPage } from './energy-page.js';

const $ = (sel) => document.querySelector(sel);

// Bump when the default free-item sources change, so earlier saved choices are replaced once.
const FINDS_VERSION = 2;

// ---------- storage (wrapped: private windows can throw) ----------
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(`tip.${k}`); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(`tip.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(`tip.${k}`); } catch { /* ignore */ } },
};

// ---------- state ----------
const state = {
  client: null,
  key: null,
  db: null,                // IndexedDB (or in-memory fallback), opened at start-up
  player: null,            // { id, name } of the key owner; saved data is kept per player
  snapshots: [],
  findTypeIds: new Set(),
  catalog: new Map(),      // itemId -> TornItem
  logTypes: [],            // [{id, title}]
  holdings: [],            // [{id, name, qty, equipped}]
  lots: new Map(),         // itemId -> purchase lots
  rawLogs: new Map(),      // logId -> log
  lowest: store.get('lowest', {}),        // itemId -> { price, at }
  overrides: store.get('overrides', {}),  // itemId -> unit cost
  itemGroups: store.get('itemGroups', {}), // itemId -> 'trade' | 'personal' (overrides type default)
  expanded: new Set(),
  sort: store.get('sort', { key: 'profit', dir: 'desc' }),
  inventoryAt: null,
  rejectedKeys: new Set(),  // keys Torn said are invalid/disabled; never re-sent this session
};

const settings = {
  read() {
    return {
      marketFee: Number($('#market-fee').value) || 0,
      anonFee: Number($('#anon-fee').value) || 0,
      costMethod: $('#cost-method').value,
      logPages: Math.max(1, Number($('#log-pages').value) || 20),
      priceSource: $('#price-source').value,
      bypassCache: $('#bypass-cache').checked,
      route: document.querySelector('input[name=route]:checked').value,
      view: document.querySelector('input[name=view]:checked').value,
      tradeTypes: [...document.querySelectorAll('#trade-types input:checked')].map((i) => i.value),
      selectedLogs: [...document.querySelectorAll('#log-types input:checked')].map((i) => Number(i.value)),
      selectedFinds: [...document.querySelectorAll('#find-types input:checked')].map((i) => Number(i.value)),
      range: document.querySelector('input[name=range]:checked').value,
    };
  },
  save() {
    const s = this.read();
    store.set('settings', { ...s, bypassCache: false, findsVersion: FINDS_VERSION });
  },
  restore() {
    const s = store.get('settings', null);
    if (!s) return;
    $('#market-fee').value = s.marketFee;
    $('#anon-fee').value = s.anonFee;
    $('#cost-method').value = s.costMethod;
    $('#log-pages').value = s.logPages;
    $('#price-source').value = s.priceSource;
    const r = document.querySelector(`input[name=route][value=${s.route}]`);
    if (r) r.checked = true;
    const v = document.querySelector(`input[name=view][value=${s.view}]`);
    if (v) v.checked = true;
    const rg = document.querySelector(`input[name=range][value="${s.range}"]`);
    if (rg) rg.checked = true;
  },
};

// ---------- formatting ----------
const money0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
function money(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n < 0 ? '-$' : '$') + money0.format(Math.abs(Math.round(n)));
}
const pct = (n) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`);
const signClass = (n) => (n == null ? 'muted' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const date = (ts) => new Date(ts * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function status(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

// ---------- loading ----------
/** A fresh client for the key in the form, or null if there's no usable key. */
function connect() {
  const key = $('#api-key').value.trim();
  if (!key) return null;
  if (state.rejectedKeys.has(key)) {
    status('Torn rejected this key earlier. Check it on Torn, or create a new one, before trying again.', true);
    return null;
  }
  if ($('#remember-key').checked) store.set('key', key); else store.del('key');
  // The key may belong to someone other than the player whose saved data is on screen.
  if (key !== state.key) state.player = null;
  state.key = key;
  state.client = createClient(key);
  return state.client;
}

function reportError(err) {
  console.error(err);
  if (err.deadKey) {
    // Torn ToS: stop using invalid or disabled keys straight away.
    state.rejectedKeys.add(state.key);
    state.client = null;
    store.del('key');
    $('#remember-key').checked = false;
  }
  const hint = err.deadKey ? ' — the key has been forgotten and won\'t be used again.'
    : err.code === 16 ? ' — the key needs more access (Full Access or the custom key above).'
    : err.fatal ? ' — Torn asked us to stop for now; try again in a minute.' : '';
  status(`${err.message}${hint}`, true);
}

/** Item catalogue (with market values), from the browser's saved copy when it's fresh enough. */
async function ensureCatalog({ force = false } = {}) {
  await dbReady;
  const r = await loadCatalog(state.db, state.client, { force });
  state.catalog = new Map(r.value.map((i) => [i.id, i]));
  return r;
}

/** Log type list, saved for a week. */
async function ensureLogTypes() {
  await dbReady;
  const r = await loadLogTypes(state.db, state.client);
  state.logTypes = r.value;
  renderLogTypes();
  return r;
}

/** `force` skips the saved inventory and prices (Update button, or the force-refresh setting). */
async function load({ force = settings.read().bypassCache } = {}) {
  if (!state.client) return;
  const btns = [$('#load-btn'), $('#inv-update')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    await dbReady;
    status('Checking your key…');
    // Sequential, so a bad key costs a single request rather than several.
    state.player = await identify(state.db, state.client, await keyFingerprint(state.key));
    // Remembered (id and name only) so saved data can be shown on the next visit before a key is entered.
    store.set('player', { id: state.player.id, name: state.player.name });
    state.snapshots = await savedSnapshots(state.db, state.player.id);
    status('Loading item catalogue…');
    const catalog = await ensureCatalog({ force });
    await ensureLogTypes();

    status('Loading inventory…');
    const inv = await loadInventory(state.db, state.client, state.player.id, {
      force,
      onCategory: (cat, i, n) => status(`Loading inventory… ${cat} (${i}/${n})`),
    });
    state.inventoryAt = inv.at;
    state.pricesAt = catalog.at;
    state.holdings = aggregate(inv.value.items);

    const s = settings.read();
    if (!s.selectedLogs.length) throw new Error('No purchase log types selected in Settings.');
    state.findTypeIds = new Set(s.selectedFinds);
    const synced = await syncLogs(state.db, state.client, state.player.id, [...s.selectedLogs, ...s.selectedFinds], {
      maxPages: s.logPages,
      onProgress: status,
    });
    applyLogs(synced.logs);

    $('#tos').open = false;
    $('#results').hidden = false;
    $('#bypass-cache').checked = false;
    settings.save();

    if (s.priceSource === 'lowest') await refreshLowest();
    await saveSnapshot();
    await renderSavedSummary();

    const calls = state.client.calls;
    status(`${state.player.name} · inventory ${inv.fromCache ? `saved ${ago(inv.at)}` : 'refreshed'} · prices ${catalog.fromCache ? `saved ${ago(catalog.at)}` : 'refreshed'} · ` +
      `${synced.added} new log${synced.added === 1 ? '' : 's'} (${synced.logs.length} saved) · ${calls} API call${calls === 1 ? '' : 's'} this load.`);
    render();
  } catch (err) {
    reportError(err);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function ago(t) {
  const mins = Math.round((Date.now() / 1000 - t) / 60);
  if (mins < 2) return 'just now';
  if (mins < 120) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

/**
 * Show what's saved in this browser for the last player who loaded, without a key or any API
 * calls. Update (or Load) then brings it up to date.
 */
async function restoreSaved() {
  const last = store.get('player', null);
  if (!last || state.client) return;
  await dbReady;
  const [catalog, logTypes, inv] = await Promise.all([
    meta.get(state.db, 'cache:catalog'), meta.get(state.db, 'cache:logtypes'), meta.get(state.db, `cache:inventory:${last.id}`),
  ]);
  if (!catalog || !inv || state.client) return; // nothing to show yet, or a load started meanwhile
  state.player = last;
  state.catalog = new Map(catalog.value.map((i) => [i.id, i]));
  if (logTypes) { state.logTypes = logTypes.value; renderLogTypes(); }
  state.inventoryAt = inv.at;
  state.pricesAt = catalog.at;
  state.holdings = aggregate(inv.value.items);
  state.snapshots = await savedSnapshots(state.db, last.id);
  const s = settings.read();
  state.findTypeIds = new Set(s.selectedFinds);
  applyLogs(await savedLogs(state.db, last.id, [...s.selectedLogs, ...s.selectedFinds]));
  $('#tos').open = false;
  $('#results').hidden = false;
  await renderSavedSummary();
  render();
  if (currentPage() === 'inventory') status(`Showing ${last.name}'s saved data. Press Update to get the latest from Torn.`);
}

/** Combine inventory rows of the same item (stacks, uid'd weapons, etc.). */
function aggregate(items) {
  const map = new Map();
  for (const it of items) {
    if (it.faction_owned) continue;
    const row = map.get(it.id) ?? { id: it.id, name: it.name, qty: 0, equipped: 0 };
    row.qty += it.amount;
    if (it.equipped) row.equipped += it.amount;
    map.set(it.id, row);
  }
  return [...map.values()];
}

function applyLogs(logs) {
  state.rawLogs = new Map(logs.map((l) => [l.id, l]));
  state.lots = lotsByItem(logs, state.findTypeIds);
  renderLogCounts();
}

async function saveSnapshot() {
  if (!state.holdings.length) return;
  const snap = await saveSnapshotFor(state.db, state.player.id, buildSnapshot(buildRows()));
  state.snapshots = [...state.snapshots.filter((x) => x.date !== snap.date), snap];
}

async function renderSavedSummary() {
  if (!state.db) return;
  $('#older-logs').disabled = true;
  if (!state.player) {
    $('#saved-summary').textContent = state.db.persistent
      ? 'Load with your key to see what\'s saved for you.' : 'This browser isn\'t allowing storage, so nothing will be kept.';
    return;
  }
  const s = settings.read();
  const [logs, cov] = await Promise.all([
    state.db.getAll(STORES.logs),
    historyCoverage(state.db, state.player.id, [...s.selectedLogs, ...s.selectedFinds]),
  ]);
  const mine = logs.filter((l) => l.player === state.player.id).length;
  const snaps = state.snapshots.map((x) => x.date).sort();
  const parts = [
    `Saved for ${state.player.name}: ${mine.toLocaleString('en-GB')} logs`,
    cov.oldest ? `history back to ${date(cov.oldest)}${cov.complete ? ' (complete)' : ''}` : null,
    snaps.length ? `${snaps.length} daily snapshot${snaps.length === 1 ? '' : 's'} since ${snaps[0]}` : null,
    state.db.persistent ? null : 'this browser isn\'t allowing storage, so nothing will be kept',
  ].filter(Boolean);
  $('#saved-summary').textContent = parts.join(' · ') || 'Nothing saved yet.';
  $('#older-logs').disabled = cov.complete || !state.client;
}

async function readOlderLogs() {
  if (!state.client) return status('Load with your key first.', true);
  const s = settings.read();
  const ids = [...s.selectedLogs, ...s.selectedFinds];
  $('#older-logs').disabled = true;
  try {
    const before = state.client.calls;
    const { added, complete, logs } = await backfillOlder(state.db, state.client, state.player.id, ids, { maxPages: s.logPages, onProgress: status });
    applyLogs(logs);
    status(`Added ${added} older logs${complete ? ' — that\'s your full history' : ''} (${state.client.calls - before} API calls).`);
    render();
  } catch (err) {
    reportError(err);
  } finally {
    await renderSavedSummary();
  }
}

async function refreshLowest() {
  if (!state.client) return;
  const btn = $('#refresh-prices');
  btn.disabled = true;
  const targets = state.holdings.filter((h) => state.catalog.get(h.id)?.is_tradable);
  try {
    for (let i = 0; i < targets.length; i++) {
      status(`Fetching lowest listings… ${i + 1}/${targets.length}`);
      try {
        const { lowest } = await state.client.lowestListing(targets[i].id);
        state.lowest[targets[i].id] = { price: lowest, at: Math.floor(Date.now() / 1000) };
      } catch (err) {
        if (err.fatal) throw err; // bad key or rate limited: stop rather than keep calling
      }
      if (i % 10 === 9) render();
    }
    store.set('lowest', state.lowest);
    status(`Lowest listings updated for ${targets.length} items.`);
    await saveSnapshot();
  } catch (err) {
    status(err.message, true);
  } finally {
    btn.disabled = false;
    render();
  }
}

// ---------- calculations ----------
function unitPrice(id, source) {
  if (source === 'lowest' && state.lowest[id]?.price) return state.lowest[id].price;
  return state.catalog.get(id)?.value?.market_price || null;
}

function buildRows() {
  const s = settings.read();
  const routes = saleRoutes(s);
  const fee = routes[s.route].fee;

  return state.holdings.map((h) => {
    const item = state.catalog.get(h.id);
    const basis = costBasis(state.lots.get(h.id), h.qty, s.costMethod);
    const override = state.overrides[h.id];
    const unitCost = override ?? basis?.unitCost ?? null;
    const price = unitPrice(h.id, s.priceSource);
    const p = profit({ qty: h.qty, unitCost, unitPrice: price, fee });
    const { group, source } = classify(item?.type, h.id, { tradeTypes: s.tradeTypes, itemOverrides: state.itemGroups });
    return {
      ...h,
      group, groupSource: source,
      image: item?.image,
      type: item?.type,
      tradable: item?.is_tradable ?? false,
      basis, override, unitCost,
      unitPrice: price,
      breakEven: breakEven(unitCost, fee),
      partial: !override && basis && basis.coveredQty < h.qty,
      foundQty: override == null ? (basis?.lots ?? []).filter((l) => l.kind === 'find').reduce((t, l) => t + (l.used ?? l.qty), 0) : 0,
      ...p,
    };
  });
}

function filteredRows() {
  const q = $('#filter').value.trim().toLowerCase();
  const hideUnpriced = $('#hide-unpriced').checked;
  const onlyCosted = $('#only-costed').checked;
  const view = settings.read().view;
  const all = buildRows();
  const visible = all.filter((r) => !hideUnpriced || (r.tradable && r.unitPrice));
  $('#count-trade').textContent = visible.filter((r) => r.group === 'trade').length;
  $('#count-personal').textContent = visible.filter((r) => r.group === 'personal').length;
  $('#count-all').textContent = visible.length;

  const rows = all.filter((r) =>
    (view === 'all' || r.group === view) &&
    (!q || r.name.toLowerCase().includes(q) || (r.type ?? '').toLowerCase().includes(q)) &&
    (!hideUnpriced || (r.tradable && r.unitPrice)) &&
    (!onlyCosted || r.unitCost != null));

  const { key, dir } = state.sort;
  const m = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls last regardless of direction
    if (bv == null) return -1;
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * m;
  });
  return rows;
}

// ---------- rendering ----------
function renderLogTypes() {
  const saved = store.get('settings', null);
  const list = (el, match, isDefault, chosen, empty) => {
    const candidates = state.logTypes.filter((t) => match(t.title)).sort((a, b) => a.title.localeCompare(b.title));
    $(el).innerHTML = candidates.map((t) => {
      const checked = chosen ? chosen.includes(t.id) : isDefault(t.title);
      return `<label class="check"><input type="checkbox" value="${t.id}" ${checked ? 'checked' : ''}> ${esc(t.title)} <span class="muted">#${t.id}</span> <span class="log-count" data-log-type="${t.id}"></span></label>`;
    }).join('') || `<em>${empty}</em>`;
  };
  list('#log-types', isPurchaseLogTitle, isDefaultPurchaseLog, saved?.selectedLogs?.length ? saved.selectedLogs : null, 'No purchase log types found.');
  // Saved find choices from an older version (or none at all) fall back to the current defaults.
  const finds = saved?.findsVersion === FINDS_VERSION ? saved.selectedFinds : null;
  list('#find-types', (t) => isFindLogTitle(t) && !isPurchaseLogTitle(t), isDefaultFindLog, finds, 'No find log types found.');
  renderLogCounts();
}

/** Show how many saved logs each log type has, so it's obvious when a type isn't coming through. */
function renderLogCounts() {
  const counts = new Map();
  for (const l of state.rawLogs.values()) counts.set(l.details?.id, (counts.get(l.details?.id) ?? 0) + 1);
  document.querySelectorAll('.log-count').forEach((el) => {
    const input = el.closest('label').querySelector('input');
    const n = counts.get(Number(el.dataset.logType)) ?? 0;
    el.textContent = input.checked && state.player ? `· ${n.toLocaleString('en-GB')} saved` : '';
    el.classList.toggle('none', input.checked && state.player && n === 0);
  });
}

function renderRouteLabels() {
  const routes = saleRoutes(settings.read());
  $('#route-direct').textContent = routes.direct.label;
  $('#route-market').textContent = routes.market.label;
  $('#route-anon').textContent = routes.anon.label;
}

function renderCards(rows) {
  const s = settings.read();
  const routes = saleRoutes(s);
  const costed = rows.filter((r) => r.cost != null && r.net != null);
  const sum = (arr, k) => arr.reduce((t, r) => t + (r[k] ?? 0), 0);
  const totalValue = sum(rows, 'value');
  const paid = sum(costed, 'cost');
  const netCosted = sum(costed, 'net');
  const prof = netCosted - paid;

  // Profit on costed items under each route, for side-by-side comparison.
  const byRoute = Object.entries(routes).map(([k, r]) => {
    const p = costed.reduce((t, row) => t + profit({ qty: row.qty, unitCost: row.unitCost, unitPrice: row.unitPrice, fee: r.fee }).profit, 0);
    return `<div class="card"><div class="label">Profit · ${esc(r.label)}</div><div class="value ${signClass(p)}">${money(p)}</div>${k === s.route ? '<div class="sub">selected</div>' : ''}</div>`;
  }).join('');

  $('#cards').innerHTML = `
    <div class="card"><div class="label">Market value</div><div class="value">${money(totalValue)}</div><div class="sub">${rows.length} items · ${esc(viewLabel())}</div></div>
    <div class="card"><div class="label">Paid (costed items)</div><div class="value">${money(paid)}</div><div class="sub">${costed.length} of ${rows.length} have a cost</div></div>
    <div class="card"><div class="label">Net if sold (costed)</div><div class="value">${money(netCosted)}</div><div class="sub">ROI ${pct(paid ? prof / paid : null)}</div></div>
    ${byRoute}`;
}

function viewLabel() {
  const v = settings.read().view;
  return v === 'all' ? 'all items' : GROUPS[v].toLowerCase();
}

function renderTradeTypes() {
  const selected = store.get('settings', null)?.tradeTypes ?? DEFAULT_TRADE_TYPES;
  $('#trade-types').innerHTML = ITEM_TYPES.map((t) =>
    `<label class="check"><input type="checkbox" value="${esc(t)}" ${selected.includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('');
}

function renderTable(rows) {
  document.querySelectorAll('#table th').forEach((th) => {
    th.classList.toggle('sorted-asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
    th.classList.toggle('sorted-desc', th.dataset.sort === state.sort.key && state.sort.dir === 'desc');
  });

  $('#table tbody').innerHTML = rows.map((r) => {
    const groupTitle = r.groupSource === 'item'
      ? 'You set this item\'s group. Click to switch.'
      : `${r.type ?? 'Unknown type'} items default to ${GROUPS[r.group].toLowerCase()}. Click to switch this item.`;
    const tags = [
      `<button type="button" class="group-tag ${r.group}${r.groupSource === 'item' ? ' item-override' : ''}" data-id="${r.id}" title="${esc(groupTitle)}">${r.group === 'trade' ? 'Trade' : 'Personal'}</button>`,
      r.equipped ? `<span class="tag">${r.equipped} equipped</span>` : '',
      !r.tradable ? '<span class="tag">untradeable</span>' : '',
      r.foundQty && r.foundQty >= r.basis.coveredQty ? '<span class="tag found" title="Every unit counted came from crimes, finds or loot">found</span>'
        : r.foundQty ? `<span class="tag found" title="Units counted at $0 because they were found">${r.foundQty} found</span>` : '',
      r.partial ? `<span class="tag warn" title="Purchases found for ${r.basis.coveredQty} of ${r.qty}">cost from ${r.basis.coveredQty}/${r.qty}</span>` : '',
      r.override != null ? '<span class="tag warn">manual cost</span>' : '',
    ].join(' ');
    const costVal = r.unitCost == null ? '' : Math.round(r.unitCost);
    const row = `
      <tr class="item" data-id="${r.id}">
        <td class="name"><div class="cell">${r.image ? `<img src="${esc(r.image)}" alt="" loading="lazy">` : ''}<span>${esc(r.name)}</span> ${tags}</div></td>
        <td class="num">${money0.format(r.qty)}</td>
        <td class="num"><input class="cost-input ${r.override != null ? 'override' : ''}" data-id="${r.id}" inputmode="numeric" value="${costVal}" placeholder="—" aria-label="Paid per unit for ${esc(r.name)}"></td>
        <td class="num">${money(r.unitPrice)}</td>
        <td class="num muted">${money(r.breakEven)}</td>
        <td class="num">${money(r.cost)}</td>
        <td class="num">${money(r.net)}</td>
        <td class="num ${signClass(r.profit)}">${money(r.profit)}</td>
        <td class="num ${signClass(r.roi)}">${pct(r.roi)}</td>
      </tr>`;
    return row + (state.expanded.has(r.id) ? detailRow(r) : '');
  }).join('') || '<tr><td colspan="9" class="muted">No items match.</td></tr>';
}

function detailRow(r) {
  const lots = state.lots.get(r.id) ?? [];
  const used = new Map((r.basis?.lots ?? []).map((l) => [`${l.logId}`, l.used ?? l.qty]));
  const lowest = state.lowest[r.id];
  const lotRows = lots.slice(0, 50).map((l) => `
    <tr><td>${date(l.timestamp)}</td><td>${l.kind === 'find' ? '<span class="tag found">found</span> ' : ''}${esc(l.title)}</td><td class="num">${money0.format(l.qty)}</td>
    <td class="num">${money(l.unitCost)}${l.approximate ? ' <span class="tag warn" title="Split from a multi-item total">≈</span>' : ''}</td>
    <td class="num">${used.has(`${l.logId}`) ? money0.format(used.get(`${l.logId}`)) : ''}</td></tr>`).join('');
  const raw = lots.slice(0, 5).map((l) => state.rawLogs.get(l.logId)).filter(Boolean);
  return `
    <tr class="detail"><td colspan="9">
      <div class="muted">Torn market value ${money(state.catalog.get(r.id)?.value?.market_price)}${lowest?.price ? ` · lowest listing ${money(lowest.price)} (${date(lowest.at)})` : ''}</div>
      ${lots.length ? `<table class="lots"><thead><tr><th>When</th><th>Source</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Counted</th></tr></thead><tbody>${lotRows}</tbody></table>`
        : '<p class="muted">No purchase or find logs for this item. Type a cost into “Paid / unit” to include it (0 if it was free).</p>'}
      <p class="muted">${esc(r.type ?? 'Unknown type')} · ${r.groupSource === 'item'
        ? `you moved this item to ${GROUPS[r.group].toLowerCase()} <button type="button" class="secondary clear-group" data-id="${r.id}">Use type default</button>`
        : `${GROUPS[r.group].toLowerCase()} by type default`}</p>
      ${r.override != null ? `<button type="button" class="secondary clear-override" data-id="${r.id}">Clear manual cost</button>` : ''}
      ${raw.length ? `<details class="raw"><summary class="muted">Raw log data</summary><pre>${esc(JSON.stringify(raw, null, 2))}</pre></details>` : ''}
    </td></tr>`;
}

function render() {
  if ($('#results').hidden) return;
  $('#inv-asof').textContent = state.inventoryAt
    ? `Inventory from ${date(state.inventoryAt)} (${ago(state.inventoryAt)}) · prices ${ago(state.pricesAt)}` : '';
  renderRouteLabels();
  const rows = filteredRows(); // also updates the group counts
  const tab = state.tab ?? 'holdings';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('#holdings-view').hidden = tab !== 'holdings';
  $('#history-view').hidden = tab !== 'history';
  document.querySelectorAll('.holdings-only').forEach((e) => { e.hidden = tab !== 'holdings'; });
  if (tab === 'holdings') {
    renderCards(rows);
    renderTable(rows);
  } else {
    renderHistory();
  }
}

// ---------- pages ----------
const energy = createEnergyPage({
  $, store, status, esc, money, num: money0,
  client: () => state.client,
  db: async () => (await dbReady, state.db),
  player: async () => {
    await dbReady;
    if (!state.player) state.player = await identify(state.db, state.client, await keyFingerprint(state.key));
    return state.player;
  },
  catalog: async () => (state.catalog.size ? state.catalog : (await ensureCatalog(), state.catalog)),
  logTypes: async () => (state.logTypes.length ? state.logTypes : (await ensureLogTypes()).value),
  onError: reportError,
});
const loaded = { inventory: () => !$('#results').hidden, energy: () => energy.loaded };
const loaders = { inventory: load, energy: () => energy.load() };

function currentPage() {
  return location.hash === '#energy' ? 'energy' : 'inventory';
}

function showPage() {
  const page = currentPage();
  document.querySelectorAll('.page').forEach((el) => { el.hidden = el.id !== `page-${page}`; });
  document.querySelectorAll('.tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.page === page));
  document.title = page === 'energy' ? 'Energy · Torn Utils' : 'Inventory profit · Torn Utils';
  status('');
  if (state.client && !loaded[page]()) loaders[page]();
}
window.addEventListener('hashchange', showPage);

// ---------- history view ----------
function historyFilter() {
  const s = settings.read();
  const rules = { tradeTypes: s.tradeTypes, itemOverrides: state.itemGroups };
  const hideUnpriced = $('#hide-unpriced').checked;
  return (it) => {
    if (hideUnpriced && !it.price) return false;
    return s.view === 'all' || classify(it.type ?? state.catalog.get(it.id)?.type, it.id, rules).group === s.view;
  };
}

const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
function shortMoney(n) {
  const a = Math.abs(n);
  const f = a >= 1e9 ? `${+(a / 1e9).toFixed(1)}b` : a >= 1e6 ? `${+(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${+(a / 1e3).toFixed(0)}k` : `${a}`;
  return (n < 0 ? '-$' : '$') + f;
}
const signed = (n) => `${n > 0 ? '+' : ''}${money(n)}`;

function renderHistory() {
  const s = settings.read();
  const route = saleRoutes(s)[s.route];
  const include = historyFilter();
  const pts = series(state.snapshots, include, route.fee, s.range === 'all' ? null : Number(s.range));

  lineChart($('#chart-value'), pts.map((p) => ({ label: dayLabel(p.date), value: p.value, t: Date.parse(p.date) })),
    { fmt: money, shortFmt: shortMoney, ariaLabel: 'Market value by day' });
  lineChart($('#chart-profit'), pts.map((p) => ({ label: dayLabel(p.date), value: p.profit, t: Date.parse(p.date) })),
    { fmt: money, shortFmt: shortMoney, zeroLine: true, ariaLabel: 'Profit after fees by day' });
  $('#profit-caption').textContent = `Profit after fees · ${route.label}`;

  const latest = pts[pts.length - 1];
  const now = Math.floor(Date.now() / 1000);
  const delta = (daysBack) => {
    const snap = snapshotOnOrBefore(state.snapshots, utcDate(now - daysBack * 86400));
    if (!snap || !latest || snap.date === latest.date) return null;
    const then = series([snap], include, route.fee)[0];
    return { value: latest.value - then.value, profit: latest.profit - then.profit, date: snap.date };
  };
  const card = (title, d) => `<div class="card"><div class="label">${title}</div>${d
    ? `<div class="value ${signClass(d.value)}">${signed(d.value)}</div><div class="sub">value · profit ${signed(d.profit)} · vs ${dayLabel(d.date)}</div>`
    : '<div class="value muted">—</div><div class="sub">no snapshot that far back yet</div>'}</div>`;
  $('#history-cards').innerHTML = `
    <div class="card"><div class="label">Market value now</div><div class="value">${money(latest?.value)}</div><div class="sub">${latest ? `${latest.count} items · ${esc(viewLabel())}` : 'no snapshots yet'}</div></div>
    ${card('Since yesterday', delta(1))}${card('Last 7 days', delta(7))}${card('Last 30 days', delta(30))}`;

  const first = pts.length > 1 ? state.snapshots.find((x) => x.date === pts[0].date) : null;
  const last = latest && state.snapshots.find((x) => x.date === latest.date);
  const changes = first && last ? itemChanges(first, last, include) : [];
  $('#changes-title').textContent = first ? `Changes since ${dayLabel(first.date)}` : 'Changes';
  $('#changes-table tbody').innerHTML = changes.slice(0, 100).map((c) => `
    <tr><td>${esc(c.name)}</td><td class="num">${money0.format(c.qtyBefore)}</td><td class="num">${money0.format(c.qtyAfter)}</td>
    <td class="num">${money(c.priceBefore)}</td><td class="num">${money(c.priceAfter)}</td>
    <td class="num ${signClass(c.valueDelta)}">${signed(c.valueDelta)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="muted">${pts.length < 2 ? 'Changes appear once there are snapshots from at least two days.' : 'No changes in this range.'}</td></tr>`;

  $('#daily-table tbody').innerHTML = [...pts].reverse().map((p) => `
    <tr><td>${p.date}</td><td class="num">${p.count}</td><td class="num">${money(p.value)}</td><td class="num">${money(p.paid)}</td>
    <td class="num ${signClass(p.profit)}">${money(p.profit)}</td></tr>`).join('');
}

// ---------- backup ----------
const LOCAL_KEYS = ['settings', 'overrides', 'itemGroups', 'lowest', 'sort'];

async function exportBackup() {
  const [logs, metaRows, snapshots] = await Promise.all([
    state.db.getAll(STORES.logs), state.db.getAll(STORES.meta), state.db.getAll(STORES.snapshots),
  ]);
  const local = Object.fromEntries(LOCAL_KEYS.map((k) => [k, store.get(k, null)]));
  // The API key is never included.
  const backup = {
    app: 'torn-inventory-profit', version: 1, exportedAt: new Date().toISOString(),
    local, logs, snapshots, meta: metaRows.filter((m) => m.key.startsWith('logsync:')),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
  a.download = `torn-inventory-backup-${utcDate(Math.floor(Date.now() / 1000))}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  try {
    const b = JSON.parse(await file.text());
    if (b.app !== 'torn-inventory-profit') throw new Error('that file isn\'t a backup from this app');
    const valid = (arr, key) => (Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object' && x[key] != null) : []);
    const logs = valid(b.logs, 'id');
    const snaps = valid(b.snapshots, 'date');
    await state.db.putMany(STORES.logs, logs);
    await state.db.putMany(STORES.snapshots, valid(snaps, 'key'));
    await state.db.putMany(STORES.meta, valid(b.meta, 'key').filter((m) => String(m.key).startsWith('logsync:')));
    for (const k of LOCAL_KEYS) if (b.local?.[k] != null) store.set(k, b.local[k]);
    if (state.player) state.snapshots = await savedSnapshots(state.db, state.player.id);
    state.overrides = store.get('overrides', {});
    state.itemGroups = store.get('itemGroups', {});
    state.lowest = store.get('lowest', {});
    settings.restore();
    renderTradeTypes();
    status(`Backup restored: ${logs.length} logs and ${snaps.length} snapshots. Press Load to apply it.`);
    await renderSavedSummary();
  } catch (err) {
    status(`Couldn't restore backup: ${err.message}`, true);
  }
}


// ---------- events ----------
$('#key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (connect()) loaders[currentPage()]();
});

$('#table thead').addEventListener('click', (e) => {
  const key = e.target.closest('th')?.dataset.sort;
  if (!key) return;
  state.sort = state.sort.key === key
    ? { key, dir: state.sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' };
  store.set('sort', state.sort);
  render();
});

$('#table tbody').addEventListener('click', (e) => {
  if (e.target.closest('input')) return;
  const groupBtn = e.target.closest('.group-tag');
  if (groupBtn) return toggleGroup(Number(groupBtn.dataset.id));
  const clearGroup = e.target.closest('.clear-group');
  if (clearGroup) {
    delete state.itemGroups[clearGroup.dataset.id];
    store.set('itemGroups', state.itemGroups);
    return render();
  }
  const clear = e.target.closest('.clear-override');
  if (clear) {
    delete state.overrides[clear.dataset.id];
    store.set('overrides', state.overrides);
    return render();
  }
  const tr = e.target.closest('tr.item');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  render();
});

/** Move one item to the other group; drop the override if that matches its type default. */
function toggleGroup(id) {
  const s = settings.read();
  const type = state.catalog.get(id)?.type;
  const current = classify(type, id, { tradeTypes: s.tradeTypes, itemOverrides: state.itemGroups }).group;
  const next = current === 'trade' ? 'personal' : 'trade';
  if (classify(type, id, { tradeTypes: s.tradeTypes }).group === next) delete state.itemGroups[id];
  else state.itemGroups[id] = next;
  store.set('itemGroups', state.itemGroups);
  render();
}

$('#table tbody').addEventListener('change', (e) => {
  const input = e.target.closest('.cost-input');
  if (!input) return;
  const id = input.dataset.id;
  const v = Number(input.value.replace(/[$,\s]/g, ''));
  if (input.value.trim() === '' || !Number.isFinite(v)) delete state.overrides[id];
  else state.overrides[id] = v;
  store.set('overrides', state.overrides);
  render();
});

for (const sel of ['#filter', '#hide-unpriced', '#only-costed', '#market-fee', '#anon-fee', '#cost-method']) {
  $(sel).addEventListener('input', () => { settings.save(); render(); });
}
document.querySelectorAll('input[name=route], input[name=view]').forEach((r) => r.addEventListener('change', () => { settings.save(); render(); }));
$('#trade-types').addEventListener('change', () => { settings.save(); render(); });
$('#reset-trade-types').addEventListener('click', () => {
  document.querySelectorAll('#trade-types input').forEach((i) => { i.checked = DEFAULT_TRADE_TYPES.includes(i.value); });
  settings.save();
  render();
});
$('#clear-item-groups').addEventListener('click', () => {
  state.itemGroups = {};
  store.del('itemGroups');
  render();
});
$('#log-types').addEventListener('change', () => settings.save());
$('#log-pages').addEventListener('change', () => settings.save());
$('#price-source').addEventListener('change', async () => {
  settings.save();
  const needsFetch = $('#price-source').value === 'lowest' && state.holdings.some((h) => !state.lowest[h.id]);
  if (needsFetch && state.client) await refreshLowest(); else render();
});
$('#refresh-prices').addEventListener('click', refreshLowest);
$('#inv-update').addEventListener('click', () => {
  if (!state.client && !connect()) {
    if (!$('#api-key').value.trim()) status('Enter your API key above to get the latest from Torn.', true);
    return $('#api-key').focus();
  }
  load({ force: true });
});
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { state.tab = t.dataset.tab; render(); }));
document.querySelectorAll('input[name=range]').forEach((r) => r.addEventListener('change', () => { settings.save(); render(); }));
$('#find-types').addEventListener('change', () => settings.save());
$('#older-logs').addEventListener('click', readOlderLogs);
$('#export-btn').addEventListener('click', exportBackup);
$('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });
$('#forget-btn').addEventListener('click', async () => {
  await state.db?.clear();
  state.snapshots = [];
  state.player = null;
  try { Object.keys(localStorage).filter((k) => k.startsWith('tip.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  state.client = null;
  state.key = null;
  state.lowest = {};
  state.overrides = {};
  state.itemGroups = {};
  renderTradeTypes();
  $('#api-key').value = '';
  $('#remember-key').checked = false;
  $('#results').hidden = true;
  $('#en-results').hidden = true;
  status('Your key and all data saved by this page — logs, snapshots and settings — have been removed from this browser.');
  renderSavedSummary();
});

// ---------- init ----------
renderTradeTypes();
settings.restore();
// Loads await this, so a fast click on Load can't race the database opening.
const dbReady = openDb().then((db) => {
  state.db = db;
  renderSavedSummary();
});
const savedKey = store.get('key', '');
if (savedKey) {
  $('#api-key').value = savedKey;
  $('#remember-key').checked = true;
}
showPage();
restoreSaved().catch((err) => console.warn('Couldn\'t show saved data:', err));
