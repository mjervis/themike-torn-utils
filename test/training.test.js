import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainingEffect, trainingBursts, costUses, detectJumps, usesByItem, trainingTotals, weeklyTraining } from '../js/training.js';
import { statGain } from '../js/energy.js';

const H = 3600;

test('trainingEffect spots energy and happy items', () => {
  assert.equal(trainingEffect({ name: 'Xanax', type: 'Drug' }).energy, 250);
  assert.ok(trainingEffect({ name: 'Ecstasy', type: 'Drug' }).jump);
  const dvd = trainingEffect({ name: 'Erotic DVD', type: 'Booster', effect: 'Increases happiness by 2,500 and booster cooldown by 6 hours.' });
  assert.equal(dvd.happy, 2500);
  assert.ok(dvd.jump);
  const candy = trainingEffect({ name: 'Lollipop', type: 'Candy', effect: 'Increases happiness by 25 and booster cooldown by 30 minutes.' });
  assert.equal(candy.happy, 25);
  assert.ok(!candy.jump);
  assert.equal(trainingEffect({ name: 'Can of Red Cow', type: 'Energy Drink', effect: 'Increases energy by 25 and booster cooldown by 2 hours.' }).energy, 25);
});

test('statGain reads increased or before/after fields', () => {
  assert.equal(statGain({ strength_increased: '1,234.5' }), 1234.5);
  assert.equal(statGain({ speed_before: 100, speed_after: 160 }), 60);
  assert.equal(statGain({ trains: 3 }), null);
});

test('trainingBursts groups close gym logs', () => {
  const b = trainingBursts([
    { id: 1, timestamp: 0, energy: 50, gain: 10 },
    { id: 2, timestamp: 10 * 60, energy: 50, gain: 20 },
    { id: 3, timestamp: 5 * H, energy: 25, gain: null },
  ]);
  assert.equal(b.length, 2);
  assert.equal(b[0].energy, 100);
  assert.equal(b[0].gain, 30);
  assert.equal(b[1].gain, null);
});

test('costUses values at cost paid, or market for unknown units', () => {
  const [paid] = costUses([{ itemId: 1, qty: 3, cost: 200, unknownQty: 1 }], () => 500);
  assert.equal(paid.value, 700);
  assert.equal(paid.estimatedQty, 1);
  const [market] = costUses([{ itemId: 1, qty: 3, cost: 200, unknownQty: 1 }], () => 500, 'market');
  assert.equal(market.value, 1500);
});

test('detectJumps counts the stack since the previous burst', () => {
  const effects = { 1: { jump: false }, 2: { jump: true } }; // 1 = Xanax, 2 = Ecstasy
  const uses = costUses([
    { itemId: 1, qty: 1, timestamp: 1 * H, cost: 800, unknownQty: 0 },   // before the earlier burst: not counted
    { itemId: 1, qty: 1, timestamp: 10 * H, cost: 800, unknownQty: 0 },
    { itemId: 1, qty: 1, timestamp: 18 * H, cost: 800, unknownQty: 0 },
    { itemId: 2, qty: 1, timestamp: 26 * H - 600, cost: 50, unknownQty: 0 },
  ], () => 0);
  const bursts = trainingBursts([
    { id: 'a', timestamp: 2 * H, energy: 150, gain: 100 },
    { id: 'b', timestamp: 26 * H, energy: 750, gain: 2000 },
  ]);
  const jumps = detectJumps(uses, bursts, (id) => effects[id]);
  assert.equal(jumps.length, 1);
  assert.equal(jumps[0].cost, 1650);
  assert.equal(jumps[0].uses.length, 3);
  assert.deepEqual(jumps[0].sessionIds, ['b']);

  const totals = trainingTotals({ uses, sessions: bursts.flatMap((b) => b.sessions), jumps });
  assert.equal(totals.jumps, 1);
  assert.equal(totals.jumpGainPerEnergy, 2000 / 750);
  assert.equal(totals.otherGainPerEnergy, 100 / 150);
  assert.equal(usesByItem(uses)[0].qty, 3);
});

test('weeklyTraining buckets by week', () => {
  const week = 7 * 24 * H;
  const rows = weeklyTraining({
    uses: [{ timestamp: 5, value: 100, estimatedQty: 0 }, { timestamp: week + 5, value: 50, estimatedQty: 1 }],
    sessions: [{ timestamp: 10, energy: 30, gain: 5 }],
    jumps: [],
  }, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].spend, 50);
  assert.equal(rows[1].energy, 30);
});
