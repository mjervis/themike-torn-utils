import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, snapshotTotals, series, snapshotOnOrBefore, itemChanges, utcDate } from '../js/history.js';
import { parseFind, lotsByItem, costBasis, isDefaultFindLog, isFindLogTitle, extractItems } from '../js/costing.js';

const snap = (date, items) => ({ date, items });

test('snapshot totals apply the fee only to costed items', () => {
  const s = snap('2026-10-01', [
    { id: 1, qty: 10, price: 100, cost: 50 },
    { id: 2, qty: 1, price: 1000, cost: null },
  ]);
  const t = snapshotTotals(s, () => true, 0.05);
  assert.equal(t.value, 2000);
  assert.equal(t.paid, 500);
  assert.equal(t.profit, 10 * 100 * 0.95 - 500);
});

test('series filters by range and orders oldest first', () => {
  const now = Date.UTC(2026, 9, 10) / 1000;
  const snaps = [snap('2026-10-09', []), snap('2026-08-01', []), snap('2026-10-05', [])];
  assert.deepEqual(series(snaps, () => true, 0, 7, now).map((p) => p.date), ['2026-10-05', '2026-10-09']);
  assert.equal(series(snaps, () => true, 0, null, now).length, 3);
  assert.equal(snapshotOnOrBefore(snaps, '2026-10-06').date, '2026-10-05');
});

test('itemChanges reports quantity and value moves', () => {
  const a = snap('d1', [{ id: 1, name: 'X', qty: 2, price: 10 }, { id: 2, name: 'Y', qty: 1, price: 5 }]);
  const b = snap('d2', [{ id: 1, name: 'X', qty: 3, price: 10 }, { id: 3, name: 'Z', qty: 1, price: 100 }]);
  const c = itemChanges(a, b, () => true);
  assert.deepEqual(c.map((r) => [r.id, r.qtyDelta, r.valueDelta]), [[3, 1, 100], [1, 1, 10], [2, -1, -5]]);
});

test('buildSnapshot keeps price and cost per item under the UTC date', () => {
  const s = buildSnapshot([{ id: 1, name: 'X', type: 'Drug', qty: 2, unitPrice: 10, unitCost: 5 }], Date.UTC(2026, 9, 10, 23) / 1000);
  assert.equal(s.date, '2026-10-10');
  assert.deepEqual(s.items[0], { id: 1, name: 'X', type: 'Drug', qty: 2, price: 10, cost: 5 });
  assert.equal(utcDate(0), '1970-01-01');
});

test('find logs become $0 lots and mix with purchases', () => {
  const buy = { id: 'b', timestamp: 100, details: { id: 1, title: 'Abroad buy' }, data: { item: 260, quantity: 10, cost_each: 300 } };
  const find = { id: 'f', timestamp: 200, details: { id: 2, title: 'Crime item gain' }, data: { items_gained: { 260: 2 } } };
  assert.deepEqual(parseFind(find).map((l) => [l.itemId, l.qty, l.unitCost, l.kind]), [[260, 2, 0, 'find']]);
  const lots = lotsByItem([buy, find], new Set([2])).get(260);
  const b = costBasis(lots, 5, 'recent');
  assert.equal(b.unitCost, (2 * 0 + 3 * 300) / 5);
  assert.equal(costBasis(lots, 12, 'average').unitCost, 3000 / 12);
});

test('extractItems understands nested reward shapes', () => {
  assert.deepEqual(extractItems({ items_gained: [{ id: 5, qty: 1 }] }), [{ id: 5, qty: 1 }]);
  assert.deepEqual(extractItems({ reward: { id: 5, amount: 3 } }), [{ id: 5, qty: 3 }]);
  assert.deepEqual(extractItems({ loot: { 7: 2 } }), [{ id: 7, qty: 2 }]);
});

test('find log title selection', () => {
  assert.ok(isDefaultFindLog('City item find'));
  assert.ok(isDefaultFindLog('Dump find'));
  assert.ok(isDefaultFindLog('Attack receive loot'));
  assert.ok(isFindLogTitle('Crime success item gain'));
  assert.ok(!isFindLogTitle('Crime fail'));
  assert.ok(!isFindLogTitle('Attack lost'));
  assert.ok(!isFindLogTitle('Crime success money gain'));
});
