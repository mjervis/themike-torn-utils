import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractItems, parsePurchase, lotsByItem, costBasis, profit, breakEven,
  saleRoutes, isDefaultPurchaseLog,
} from '../js/costing.js';

const log = (id, timestamp, data, title = 'Item market buy') => ({ id, timestamp, data, details: { title } });

test('extractItems handles the common shapes', () => {
  assert.deepEqual(extractItems({ items: [{ id: 206, qty: 3 }] }), [{ id: 206, qty: 3 }]);
  assert.deepEqual(extractItems({ items: { 206: 2 } }), [{ id: 206, qty: 2 }]);
  assert.deepEqual(extractItems({ item: 206, quantity: 5 }), [{ id: 206, qty: 5 }]);
  assert.deepEqual(extractItems({ item: { id: 206, amount: 4 } }), [{ id: 206, qty: 4 }]);
  assert.deepEqual(extractItems({ foo: 1 }), []);
});

test('parsePurchase uses cost_each, or splits cost_total', () => {
  assert.equal(parsePurchase(log('a', 1, { items: [{ id: 1, qty: 2 }], cost_each: 500, cost_total: 1000 }))[0].unitCost, 500);
  assert.equal(parsePurchase(log('a', 1, { item: 1, quantity: 4, cost_total: 1000 }))[0].unitCost, 250);
  assert.deepEqual(parsePurchase(log('a', 1, { items: [{ id: 1, qty: 2 }] })), []);
});

test('costBasis "recent" uses the newest lots that cover the held quantity', () => {
  const lots = lotsByItem([
    log('old', 100, { item: 1, quantity: 10, cost_each: 100 }),
    log('new', 200, { item: 1, quantity: 2, cost_each: 400 }),
  ]).get(1);
  const b = costBasis(lots, 4, 'recent');
  assert.equal(b.coveredQty, 4);
  assert.equal(b.unitCost, (2 * 400 + 2 * 100) / 4);
});

test('costBasis reports partial coverage and supports averaging', () => {
  const lots = lotsByItem([log('x', 1, { item: 1, quantity: 2, cost_each: 300 })]).get(1);
  assert.equal(costBasis(lots, 5).coveredQty, 2);
  const avg = costBasis(lotsByItem([
    log('a', 1, { item: 1, quantity: 1, cost_each: 100 }),
    log('b', 2, { item: 1, quantity: 3, cost_each: 200 }),
  ]).get(1), 1, 'average');
  assert.equal(avg.unitCost, 175);
});

test('profit and break-even apply sale fees', () => {
  const r = saleRoutes({ marketFee: 5, anonFee: 10 });
  assert.equal(r.market.fee, 0.05);
  assert.equal(r.anon.fee, 0.15);
  const p = profit({ qty: 10, unitCost: 900, unitPrice: 1000, fee: r.market.fee });
  assert.equal(p.net, 9500);
  assert.equal(p.profit, 500);
  assert.equal(breakEven(950, 0.05), 1000);
  assert.equal(profit({ qty: 1, unitCost: null, unitPrice: 10, fee: 0 }).profit, null);
});

test('default purchase log selection', () => {
  assert.ok(isDefaultPurchaseLog('Item market buy'));
  assert.ok(isDefaultPurchaseLog('Bazaar buy'));
  assert.ok(!isDefaultPurchaseLog('Item market sell'));
  assert.ok(!isDefaultPurchaseLog('Points market buy'));
});

test('gifts and faction payouts count as free item sources', async () => {
  const { isDefaultFindLog } = await import('../js/costing.js');
  for (const t of ['Item receive', 'Faction give item receive', 'Faction payout item receive', 'Seasonal gift items', 'Crime success item gain (new)']) {
    assert.ok(isDefaultFindLog(t), t);
  }
  for (const t of ['Faction loan item receive', 'Trade items add other user', 'Money receive', 'Faction item receive ownership']) {
    assert.ok(!isDefaultFindLog(t), t);
  }
});
