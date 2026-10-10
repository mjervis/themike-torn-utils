import { createClient } from './api.js';
import {
  saleRoutes, isPurchaseLogTitle, isDefaultPurchaseLog,
  lotsByItem, costBasis, profit, breakEven,
} from './costing.js';

const $ = (sel) => document.querySelector(sel);

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
  catalog: new Map(),      // itemId -> TornItem
  logTypes: [],            // [{id, title}]
  holdings: [],            // [{id, name, qty, equipped}]
  lots: new Map(),         // itemId -> purchase lots
  rawLogs: new Map(),      // logId -> log
  lowest: store.get('lowest', {}),        // itemId -> { price, at }
  overrides: store.get('overrides', {}),  // itemId -> unit cost
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
      selectedLogs: [...document.querySelectorAll('#log-types input:checked')].map((i) => Number(i.value)),
    };
  },
  save() {
    const s = this.read();
    store.set('settings', { ...s, bypassCache: false });
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
async function load() {
  const key = $('#api-key').value.trim();
  if (!key) return;
  if (state.rejectedKeys.has(key)) {
    return status('Torn rejected this key earlier. Check it on Torn, or create a new one, before trying again.', true);
  }
  if ($('#remember-key').checked) store.set('key', key); else store.del('key');

  state.client = createClient(key);
  const btn = $('#load-btn');
  btn.disabled = true;
  try {
    status('Loading item catalogue…');
    // Sequential, so a bad key costs a single request rather than several.
    const items = await state.client.items();
    const logTypes = await state.client.logTypes();
    state.catalog = new Map(items.map((i) => [i.id, i]));
    state.logTypes = logTypes;
    renderLogTypes();

    status('Loading inventory…');
    const inv = await state.client.inventory({
      bypassCache: settings.read().bypassCache,
      onCategory: (cat, i, n) => status(`Loading inventory… ${cat} (${i}/${n})`),
    });
    state.inventoryAt = inv.timestamp;
    state.holdings = aggregate(inv.items);

    const s = settings.read();
    if (!s.selectedLogs.length) throw new Error('No purchase log types selected in Settings.');
    status('Reading purchase logs…');
    const logs = await state.client.logs(s.selectedLogs, {
      maxPages: s.logPages,
      onPage: (n, p) => status(`Reading purchase logs… ${n} found (page ${p}/${s.logPages})`),
    });
    state.rawLogs = new Map(logs.map((l) => [l.id, l]));
    state.lots = lotsByItem(logs);

    $('#tos').open = false;
    $('#results').hidden = false;
    settings.save();

    if (s.priceSource === 'lowest') await refreshLowest();
    const oldest = logs.length ? date(logs[logs.length - 1].timestamp) : null;
    status(`Loaded ${state.holdings.length} items and ${logs.length} purchase logs${oldest ? ` (back to ${oldest})` : ''}. ` +
      `Inventory as of ${state.inventoryAt ? date(state.inventoryAt) : 'now'}.`);
    render();
  } catch (err) {
    console.error(err);
    if (err.deadKey) {
      // Torn ToS: stop using invalid or disabled keys straight away.
      state.rejectedKeys.add(key);
      state.client = null;
      store.del('key');
      $('#remember-key').checked = false;
    }
    const hint = err.deadKey ? ' — the key has been forgotten and won\'t be used again.'
      : err.code === 16 ? ' — the key needs access to user → log (Full Access or the custom key above).'
      : err.fatal ? ' — Torn asked us to stop for now; try again in a minute.' : '';
    status(`${err.message}${hint}`, true);
  } finally {
    btn.disabled = false;
  }
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
    return {
      ...h,
      image: item?.image,
      type: item?.type,
      tradable: item?.is_tradable ?? false,
      basis, override, unitCost,
      unitPrice: price,
      breakEven: breakEven(unitCost, fee),
      partial: !override && basis && basis.coveredQty < h.qty,
      ...p,
    };
  });
}

function filteredRows() {
  const q = $('#filter').value.trim().toLowerCase();
  const hideUnpriced = $('#hide-unpriced').checked;
  const onlyCosted = $('#only-costed').checked;
  const rows = buildRows().filter((r) =>
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
  const saved = store.get('settings', null)?.selectedLogs;
  const candidates = state.logTypes.filter((t) => isPurchaseLogTitle(t.title))
    .sort((a, b) => a.title.localeCompare(b.title));
  $('#log-types').innerHTML = candidates.map((t) => {
    const checked = saved?.length ? saved.includes(t.id) : isDefaultPurchaseLog(t.title);
    return `<label class="check"><input type="checkbox" value="${t.id}" ${checked ? 'checked' : ''}> ${esc(t.title)} <span class="muted">#${t.id}</span></label>`;
  }).join('') || '<em>No purchase log types found.</em>';
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
    <div class="card"><div class="label">Market value</div><div class="value">${money(totalValue)}</div><div class="sub">${rows.length} items shown</div></div>
    <div class="card"><div class="label">Paid (costed items)</div><div class="value">${money(paid)}</div><div class="sub">${costed.length} of ${rows.length} have a cost</div></div>
    <div class="card"><div class="label">Net if sold (costed)</div><div class="value">${money(netCosted)}</div><div class="sub">ROI ${pct(paid ? prof / paid : null)}</div></div>
    ${byRoute}`;
}

function renderTable(rows) {
  document.querySelectorAll('#table th').forEach((th) => {
    th.classList.toggle('sorted-asc', th.dataset.sort === state.sort.key && state.sort.dir === 'asc');
    th.classList.toggle('sorted-desc', th.dataset.sort === state.sort.key && state.sort.dir === 'desc');
  });

  $('#table tbody').innerHTML = rows.map((r) => {
    const tags = [
      r.equipped ? `<span class="tag">${r.equipped} equipped</span>` : '',
      !r.tradable ? '<span class="tag">untradeable</span>' : '',
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
    <tr><td>${date(l.timestamp)}</td><td>${esc(l.title)}</td><td class="num">${money0.format(l.qty)}</td>
    <td class="num">${money(l.unitCost)}${l.approximate ? ' <span class="tag warn" title="Split from a multi-item total">≈</span>' : ''}</td>
    <td class="num">${used.has(`${l.logId}`) ? money0.format(used.get(`${l.logId}`)) : ''}</td></tr>`).join('');
  const raw = lots.slice(0, 5).map((l) => state.rawLogs.get(l.logId)).filter(Boolean);
  return `
    <tr class="detail"><td colspan="9">
      <div class="muted">Torn market value ${money(state.catalog.get(r.id)?.value?.market_price)}${lowest?.price ? ` · lowest listing ${money(lowest.price)} (${date(lowest.at)})` : ''}</div>
      ${lots.length ? `<table class="lots"><thead><tr><th>When</th><th>Source</th><th class="num">Qty</th><th class="num">Each</th><th class="num">Counted</th></tr></thead><tbody>${lotRows}</tbody></table>`
        : '<p class="muted">No purchase logs found for this item. Type a cost into “Paid / unit” to include it.</p>'}
      ${r.override != null ? `<button type="button" class="secondary clear-override" data-id="${r.id}">Clear manual cost</button>` : ''}
      ${raw.length ? `<details class="raw"><summary class="muted">Raw log data</summary><pre>${esc(JSON.stringify(raw, null, 2))}</pre></details>` : ''}
    </td></tr>`;
}

function render() {
  if ($('#results').hidden) return;
  renderRouteLabels();
  const rows = filteredRows();
  renderCards(rows);
  renderTable(rows);
}

// ---------- events ----------
$('#key-form').addEventListener('submit', (e) => { e.preventDefault(); load(); });

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
document.querySelectorAll('input[name=route]').forEach((r) => r.addEventListener('change', () => { settings.save(); render(); }));
$('#log-types').addEventListener('change', () => settings.save());
$('#log-pages').addEventListener('change', () => settings.save());
$('#price-source').addEventListener('change', async () => {
  settings.save();
  const needsFetch = $('#price-source').value === 'lowest' && state.holdings.some((h) => !state.lowest[h.id]);
  if (needsFetch && state.client) await refreshLowest(); else render();
});
$('#refresh-prices').addEventListener('click', refreshLowest);
$('#forget-btn').addEventListener('click', () => {
  try { Object.keys(localStorage).filter((k) => k.startsWith('tip.')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  state.client = null;
  state.lowest = {};
  state.overrides = {};
  $('#api-key').value = '';
  $('#remember-key').checked = false;
  $('#results').hidden = true;
  status('Your key and all data saved by this page have been removed from this browser.');
});

// ---------- init ----------
settings.restore();
const savedKey = store.get('key', '');
if (savedKey) {
  $('#api-key').value = savedKey;
  $('#remember-key').checked = true;
}
