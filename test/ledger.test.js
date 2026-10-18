import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSellLogTitle, isDefaultSellLog, isUseLogTitle, isDefaultUseLog,
  parseSale, buildLedger, tradeSummary, realisedByDay,
} from '../js/ledger.js';

const log = (id, timestamp, type, data, title = '') => ({ id, timestamp, data, details: { id: type, title } });
const types = { purchaseIds: new Set([1]), findIds: new Set([2]), saleIds: new Set([3]), useIds: new Set([4]) };

test('sell and use log titles', () => {
  assert.ok(isDefaultSellLog('Item market sell'));
  assert.ok(isDefaultSellLog('Bazaar sell'));
  assert.ok(!isSellLogTitle('Item market buy'));
  assert.ok(!isSellLogTitle('Stock market sell shares'));
  assert.ok(!isSellLogTitle('Item market list'));
  // Real Torn titles (GET /torn/logtypes).
  for (const t of ['Item use xanax', 'Item use xanax overdose', 'Item use ecstasy', 'Item use erotic dvd',
    'Item use feathery hotel coupon', 'Item use candy', 'Item use energy drink', 'Item use LSD']) assert.ok(isDefaultUseLog(t), t);
  for (const t of ['Item use six pack of energy drink', 'Item use drug pack', 'Item use book', 'Item use box of grenades']) assert.ok(!isDefaultUseLog(t), t);
  for (const t of ['Item market sell', 'Bazaar sell', 'Item shop sell', 'Auction house item sold']) assert.ok(isDefaultSellLog(t), t);
  assert.ok(!isSellLogTitle('Auction house property sold'));
  assert.ok(!isSellLogTitle('Item shop sell points'));
  assert.ok(isUseLogTitle('Item use'));
  assert.ok(!isUseLogTitle('Crime use item'));
  assert.ok(!isUseLogTitle('Points refill use'));
});

test('parseSale reads the fee, or estimates it for the item market', () => {
  const [stated] = parseSale(log('a', 1, 3, { items: [{ id: 9, qty: 2 }], cost_each: 1000, fee: 100 }, 'Item market sell'));
  assert.equal(stated.unitGross, 1000);
  assert.equal(stated.unitNet, 950);
  assert.equal(stated.feeEstimated, false);
  const [est] = parseSale(log('b', 1, 3, { item: 9, quantity: 4, cost_total: 4000 }, 'Item market sell'), { marketFee: 0.05 });
  assert.equal(est.unitNet, 950);
  assert.equal(est.feeEstimated, true);
  const [bazaar] = parseSale(log('c', 1, 3, { item: 9, quantity: 1, cost_each: 800 }, 'Bazaar sell'));
  assert.equal(bazaar.unitNet, 800);
});

test('buildLedger matches sales and uses first-in-first-out', () => {
  const ledger = buildLedger([
    log('p1', 100, 1, { item: 9, quantity: 3, cost_each: 100 }),
    log('f1', 150, 2, { item: 9, quantity: 1 }),
    log('p2', 200, 1, { item: 9, quantity: 2, cost_each: 400 }),
    log('s1', 300, 3, { item: 9, quantity: 4, cost_each: 500 }, 'Bazaar sell'),
    log('u1', 400, 4, { item: 9 }),
    log('u2', 500, 4, { item: 9, quantity: 3 }),
  ], types);
  const [sale] = ledger.sales;
  assert.equal(sale.matchedQty, 4);
  assert.equal(sale.cost, 300); // 3 × 100 + 1 found at $0
  assert.equal(sale.realised, 4 * 500 - 300);
  const [later, first] = ledger.uses;
  assert.equal(first.cost, 400);
  assert.equal(later.matchedQty, 1); // only one bought unit left
  assert.equal(later.unknownQty, 2);
  assert.equal(later.cost, 400);
});

test('buildLedger counts a purchase in the same second before a sale', () => {
  const ledger = buildLedger([
    log('s', 100, 3, { item: 9, quantity: 1, cost_each: 500 }, 'Bazaar sell'),
    log('p', 100, 1, { item: 9, quantity: 1, cost_each: 200 }),
  ], types);
  assert.equal(ledger.sales[0].realised, 300);
});

test('tradeSummary totals per item within a date range', () => {
  const ledger = buildLedger([
    log('p1', 100, 1, { item: 9, quantity: 2, cost_each: 100 }),
    log('p2', 100, 1, { item: 8, quantity: 1, cost_each: 50 }),
    log('s1', 300, 3, { item: 9, quantity: 1, cost_each: 300 }, 'Bazaar sell'),
    log('s2', 900, 3, { item: 9, quantity: 1, cost_each: 150 }, 'Bazaar sell'),
    log('u1', 950, 4, { item: 8 }),
  ], types);
  const all = tradeSummary(ledger);
  const nine = all.find((r) => r.itemId === 9);
  assert.equal(nine.boughtQty, 2);
  assert.equal(nine.soldQty, 2);
  assert.equal(nine.realised, 200 + 50);
  assert.equal(all.find((r) => r.itemId === 8).usedCost, 50);
  const recent = tradeSummary(ledger, { from: 500, include: (id) => id === 9 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].boughtQty, 0);
  assert.equal(recent[0].realised, 50);
});

test('realisedByDay is a running total', () => {
  const day = 86400;
  const pts = realisedByDay([{ timestamp: day + 5, realised: 10 }, { timestamp: 5, realised: 5 }, { timestamp: day + 9, realised: -3 }]);
  assert.deepEqual(pts.map((p) => p.total), [5, 12]);
});
