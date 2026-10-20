import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSellLogTitle, isDefaultSellLog, isUseLogTitle, isDefaultUseLog,
  parseSale, buildLedger, tradeSummary, realisedByDay, isTradeLogTitle, isDefaultTradeLog, parseTrades,
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

// Shapes from real Torn trade logs (trade 13597838: two items out for $2,992,000).
const trade = (id, ts, type, title, data) => log(id, ts, type, { user: 4041133, parsed_trade_id: 13597838, ...data }, title);

test('trade log titles', () => {
  for (const t of ['Trade items outgoing', 'Trade items incoming', 'Trade money incoming', 'Trade money outgoing']) assert.ok(isDefaultTradeLog(t), t);
  for (const t of ['Trade completed', 'Trade items add', 'Trade money add other user', 'Trade initiate outgoing']) {
    assert.ok(isTradeLogTitle(t), t);
    assert.ok(!isDefaultTradeLog(t), t);
  }
  assert.ok(!isTradeLogTitle('Item market sell'));
});

test('parseTrades sells the items you gave for the money you got, split by market value', () => {
  const { sales, purchases } = parseTrades([
    trade('a', 100, 4441, 'Trade money incoming', { money: 3000 }),
    trade('b', 100, 4445, 'Trade items outgoing', { items: [{ id: 1484, uid: null, qty: 2 }, { id: 1494, uid: null, qty: 1 }] }),
    trade('c', 90, 4480, 'Trade money add other user', { money: 3000, total: 3000 }),
  ], (id) => ({ 1484: 1000, 1494: 2000 })[id]);
  assert.equal(purchases.length, 0);
  assert.deepEqual(sales.map((x) => [x.itemId, x.qty, x.unitNet]), [[1484, 2, 750], [1494, 1, 1500]]);
  assert.equal(sales[0].timestamp, 100);
});

test('parseTrades buys items paid for with money, and costs a swap at market value', () => {
  const bought = parseTrades([
    log('a', 100, 4440, { parsed_trade_id: 7, money: 500 }, 'Trade money outgoing'),
    log('b', 100, 4446, { parsed_trade_id: 7, items: [{ id: 5, qty: 5 }] }, 'Trade items incoming'),
  ]);
  assert.deepEqual(bought.purchases.map((x) => [x.itemId, x.qty, x.unitCost]), [[5, 5, 100]]);
  const swap = parseTrades([
    log('a', 100, 4445, { parsed_trade_id: 8, items: [{ id: 1, qty: 1 }] }, 'Trade items outgoing'),
    log('b', 100, 4446, { parsed_trade_id: 8, items: [{ id: 2, qty: 2 }] }, 'Trade items incoming'),
    log('c', 100, 4441, { parsed_trade_id: 8, money: 100 }, 'Trade money incoming'),
  ], (id) => ({ 1: 900, 2: 400 })[id]);
  assert.equal(swap.sales[0].unitNet, 900); // 2 × 400 received + $100
  assert.equal(swap.purchases[0].unitCost, 400);
});

test('buildLedger counts trades as sales against earlier purchases', () => {
  const ledger = buildLedger([
    log('p', 50, 1, { item: 1484, quantity: 2, cost_each: 600 }),
    trade('a', 100, 4441, 'Trade money incoming', { money: 2000 }),
    trade('b', 100, 4445, 'Trade items outgoing', { items: [{ id: 1484, qty: 2 }] }),
  ], { ...types, tradeIds: new Set([4441, 4445]) });
  assert.equal(ledger.sales.length, 1);
  assert.equal(ledger.sales[0].realised, 2000 - 1200);
});
