// Daily snapshots of holdings, and the series/changes the History view draws from them.

export const utcDate = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** One snapshot per UTC (Torn City Time) day; a later load the same day replaces it. */
export function buildSnapshot(rows, now = Math.floor(Date.now() / 1000)) {
  return {
    date: utcDate(now),
    at: now,
    items: rows.map((r) => ({
      id: r.id, name: r.name, type: r.type ?? null,
      qty: r.qty, price: r.unitPrice ?? null, cost: r.unitCost ?? null,
    })),
  };
}

/** Totals for one snapshot, for the items `include` accepts, after a sale fee. */
export function snapshotTotals(snap, include, fee) {
  let value = 0, paid = 0, costedNet = 0, count = 0;
  for (const it of snap.items) {
    if (!include(it)) continue;
    count++;
    if (it.price == null) continue;
    value += it.qty * it.price;
    if (it.cost != null) {
      paid += it.qty * it.cost;
      costedNet += it.qty * it.price * (1 - fee);
    }
  }
  return { date: snap.date, at: snap.at, value, paid, profit: costedNet - paid, count };
}

/** Totals per day, oldest first, limited to the last `days` days (null = all). */
export function series(snapshots, include, fee, days = null, now = Math.floor(Date.now() / 1000)) {
  const cutoff = days ? utcDate(now - days * 86400) : '';
  return snapshots
    .filter((s) => s.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => snapshotTotals(s, include, fee));
}

/** The latest snapshot on or before `date`. */
export function snapshotOnOrBefore(snapshots, date) {
  return snapshots.filter((s) => s.date <= date).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}

/** Per-item change in quantity and value between two snapshots, biggest moves first. */
export function itemChanges(before, after, include) {
  const map = new Map();
  const add = (snap, side) => {
    for (const it of snap?.items ?? []) {
      if (!include(it)) continue;
      const row = map.get(it.id) ?? { id: it.id, name: it.name, qtyBefore: 0, qtyAfter: 0, valueBefore: 0, valueAfter: 0, priceBefore: null, priceAfter: null };
      row[`qty${side}`] = it.qty;
      row[`value${side}`] = it.qty * (it.price ?? 0);
      row[`price${side}`] = it.price;
      if (side === 'After') row.name = it.name;
      map.set(it.id, row);
    }
  };
  add(before, 'Before');
  add(after, 'After');
  return [...map.values()]
    .map((r) => ({ ...r, qtyDelta: r.qtyAfter - r.qtyBefore, valueDelta: r.valueAfter - r.valueBefore }))
    .filter((r) => r.qtyDelta !== 0 || r.valueDelta !== 0)
    .sort((a, b) => Math.abs(b.valueDelta) - Math.abs(a.valueDelta));
}

// ---------- chart (DOM) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

function niceTicks(min, max, count = 4) {
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return ticks;
}

/**
 * Single-series line chart with a crosshair tooltip.
 * points: [{ label, value, t }] — t (any number, e.g. a timestamp) positions points on the x axis
 * so gaps between days show as gaps; without it points are evenly spaced. fmt formats values.
 */
export function lineChart(container, points, { fmt, shortFmt = fmt, zeroLine = false, ariaLabel }) {
  container.replaceChildren();
  if (points.length === 0) {
    container.textContent = 'No snapshots yet.';
    return;
  }
  const W = 640, H = 200, M = { t: 10, r: 12, b: 24, l: 64 };
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values, zeroLine ? 0 : Infinity), Math.max(...values, zeroLine ? 0 : -Infinity));
  const yMin = ticks[0], yMax = ticks[ticks.length - 1];
  const ts = points.map((p, i) => p.t ?? i);
  const t0 = ts[0], span = ts[ts.length - 1] - t0;
  const x = (i) => M.l + (span === 0 ? (W - M.l - M.r) / 2 : ((ts[i] - t0) / span) * (W - M.l - M.r));
  const y = (v) => M.t + (1 - (v - yMin) / (yMax - yMin)) * (H - M.t - M.b);

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': ariaLabel });
  for (const t of ticks) {
    svg.append(el('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), class: t === 0 && zeroLine ? 'zero' : 'grid' }));
    const label = el('text', { x: M.l - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' });
    label.textContent = shortFmt(t);
    svg.append(label);
  }
  // Always label the last point; add others right-to-left only where they won't collide.
  const MIN_GAP = 72;
  let lastX = Infinity;
  for (let i = points.length - 1; i >= 0; i--) {
    if (lastX - x(i) < MIN_GAP) continue;
    const t = el('text', { x: x(i), y: H - 6, class: 'axis', 'text-anchor': i === points.length - 1 && points.length > 1 ? 'end' : 'middle' });
    t.textContent = points[i].label;
    svg.append(t);
    lastX = x(i);
  }

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  svg.append(el('path', { d, class: 'line' }));
  const last = points.length - 1;
  svg.append(el('circle', { cx: x(last), cy: y(points[last].value), r: 4, class: 'dot' }));

  const cross = el('line', { y1: M.t, y2: H - M.b, class: 'crosshair', visibility: 'hidden' });
  const marker = el('circle', { r: 4, class: 'dot', visibility: 'hidden' });
  svg.append(cross, marker);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const tipValue = document.createElement('strong');
  const tipLabel = document.createElement('span');
  tip.append(tipValue, tipLabel);

  const hit = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: 'transparent', tabindex: 0 });
  const show = (i) => {
    const p = points[i];
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    marker.setAttribute('cx', x(i)); marker.setAttribute('cy', y(p.value));
    cross.setAttribute('visibility', 'visible'); marker.setAttribute('visibility', 'visible');
    tipValue.textContent = fmt(p.value);
    tipLabel.textContent = p.label;
    tip.hidden = false;
    const pct = x(i) / W;
    tip.style.left = `${pct * 100}%`;
    tip.style.transform = `translateX(${pct > 0.7 ? '-100%' : pct < 0.3 ? '0' : '-50%'})`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); marker.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  let focusIdx = last;
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    // Snap to the nearest point in x.
    focusIdx = points.reduce((best, _, i) => (Math.abs(x(i) - px) < Math.abs(x(best) - px) ? i : best), 0);
    show(Math.max(0, Math.min(last, focusIdx)));
  });
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('focus', () => show(focusIdx));
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') focusIdx = Math.max(0, focusIdx - 1);
    else if (e.key === 'ArrowRight') focusIdx = Math.min(last, focusIdx + 1);
    else return;
    e.preventDefault();
    show(focusIdx);
  });
  svg.append(hit);
  container.append(svg, tip);
}
