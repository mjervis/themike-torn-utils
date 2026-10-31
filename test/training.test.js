import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  trainingEffect, trainingBursts, costUses, detectJumps, usesByItem, trainingTotals, weeklyTraining, jumpRole, planJumps, stockLevels,
  trainGain, simulateTraining, gymDots, calibrate, jumpGain,
} from '../js/training.js';
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

test('sources splits used units into bought, free and unknown', async () => {
  const { buildLedger } = await import('../js/ledger.js');
  const { sources } = await import('../js/training.js');
  const L = (id, ts, type, data) => ({ id, timestamp: ts, data, details: { id: type, title: '' } });
  const ledger = buildLedger([
    L('crime', 1, 2, { item: 310, quantity: 2 }),
    L('buy', 2, 1, { item: 310, quantity: 3, cost_each: 100 }),
    L('eat', 3, 4, { item: 310, quantity: 6 }),
  ], { purchaseIds: new Set([1]), findIds: new Set([2]), saleIds: new Set(), useIds: new Set([4]) });
  const [use] = ledger.uses;
  assert.equal(use.cost, 300); // the 2 crime lollipops are free
  assert.deepEqual(sources([use]), { bought: 3, free: 2, unknown: 1 });
});

const jumpItems = (qty = {}) => [
  { id: 206, name: 'Xanax', role: 'xanax', price: 800000, qty: qty.xanax ?? 0 },
  { id: 197, name: 'Ecstasy', role: 'ecstasy', price: 50000, qty: qty.ecstasy ?? 0 },
  { id: 366, name: 'Erotic DVD', role: 'happy', happy: 2500, cooldownHours: 6, price: 4000000, qty: qty.dvd ?? 0 },
];

test('jumpRole picks out Xanax, Ecstasy and big happy items', () => {
  assert.equal(jumpRole({ name: 'Xanax', type: 'Drug' }), 'xanax');
  assert.equal(jumpRole({ name: 'Ecstasy', type: 'Drug' }), 'ecstasy');
  assert.equal(jumpRole({ name: 'Erotic DVD', type: 'Booster', effect: 'Increases happiness by 2,500 and booster cooldown by 6 hours.' }), 'happy');
  assert.equal(jumpRole({ name: 'Lollipop', type: 'Candy', effect: 'Increases happiness by 25.' }), null);
});

test('planJumps uses stock first and buys only what is short', () => {
  const { jumps, more, leftover } = planJumps(jumpItems({ xanax: 6, ecstasy: 1, dvd: 4 }), { boosterCapHours: 24 });
  assert.equal(jumps.length, 2);
  assert.equal(more, 0);
  const [a, b] = jumps;
  // DVDs are spread evenly, not all in the first jump.
  assert.equal(a.happy, 5000);
  assert.equal(b.happy, 5000);
  assert.deepEqual(a.parts.map((p) => [p.item.name, p.stock, p.buy]), [['Xanax', 4, 0], ['Erotic DVD', 2, 0], ['Ecstasy', 1, 0]]);
  assert.deepEqual(b.parts.map((p) => [p.item.name, p.stock, p.buy]), [['Xanax', 2, 2], ['Erotic DVD', 2, 0], ['Ecstasy', 0, 1]]);
  assert.equal(b.buyCost, 2 * 800000 + 50000);
  // A 24h limit fits four 6h DVDs, so each jump has room for two more.
  assert.equal(a.topUp.qty, 2);
  assert.deepEqual(leftover, []);
});

test('planJumps caps the plan and reports leftovers', () => {
  const r = planJumps(jumpItems({ ecstasy: 15, dvd: 1 }), { boosterCapHours: 30, maxJumps: 10 });
  assert.equal(r.jumps.length, 10);
  assert.equal(r.more, 5);
  assert.deepEqual(r.leftover.map((l) => [l.item.name, l.qty]), [['Ecstasy', 5]]);
  assert.equal(r.full.parts.find((p) => p.item.name === 'Erotic DVD').buy, 5); // 30h fits five 6h DVDs
  assert.equal(planJumps(jumpItems(), { boosterCapHours: 24 }).jumps.length, 0);
});

test('stockLevels shows how long stock lasts at the recent rate', () => {
  const rows = stockLevels(new Map([[206, 6], [1, 3]]), [{ itemId: 206, qty: 7 }, { itemId: 197, qty: 2 }], 14);
  assert.deepEqual(rows.map((r) => r.itemId), [206, 1, 197]);
  assert.equal(rows[0].perWeek, 3.5);
  assert.equal(rows[0].daysLeft, 12);
  assert.equal(rows[1].daysLeft, null);
  assert.equal(rows[2].qty, 0);
});

test('planJumps can pack happy items into fewer jumps instead of spreading them', () => {
  const { jumps } = planJumps(jumpItems({ xanax: 8, ecstasy: 2, dvd: 4 }), { boosterCapHours: 24, spread: 'fill' });
  assert.deepEqual(jumps.map((j) => j.happy), [10000, 0]);
});

test('trainGain follows the gym formula and grows with happy', () => {
  // 10,000 strength at 5,000 happy, 1 dot, 10E: (10000×1.2131 + 8×5000^1.05 + (1−(5000/99999)²)×1600 + 1700) × 10/200000
  const g = trainGain({ stat: 'strength', value: 10000, happy: 5000, energy: 10, dots: 1 });
  assert.ok(Math.abs(g - 3.83) < 0.01, `got ${g}`); // (12,131 + 61,264 + 1,596 + 1,700) × 10 / 200,000
  assert.ok(trainGain({ stat: 'strength', value: 10000, happy: 20000, energy: 10, dots: 1 }) > 3 * g);
  assert.ok(Math.abs(trainGain({ stat: 'strength', value: 10000, happy: 5000, energy: 10, dots: 3.4 }) - 3.4 * g) < 1e-9);
});

test('gymDots reads the API\'s ×10 dots', () => {
  assert.equal(gymDots({ strength: 34 }, 'strength'), 3.4);
  assert.equal(gymDots({ defense: 5 }, 'defense'), 5);
  assert.equal(gymDots({}, 'speed'), null);
});

test('calibrate fits perks so the formula matches your own sessions', () => {
  const gym = { id: 9, energy_cost: 10, defense: 40 };
  const actual = 1.25 * simulateTraining({ stat: 'defense', value: 13000, happy: 5000, energy: 150, energyPerTrain: 10, dots: 4, happyPerEnergy: 0.5 });
  const sessions = [
    { id: 1, timestamp: 100, stat: 'defense', before: 13000, gain: actual, trains: 15, energy: 150, happy: 75, gym: 9 },
    { id: 2, timestamp: 50, stat: 'speed', before: 9000, gain: 50, trains: 15, energy: 150, happy: 75, gym: 9 },
  ];
  const fit = calibrate(sessions, { stat: 'defense', maxHappy: 5000, gymOf: () => gym });
  assert.ok(Math.abs(fit.perks - 1.25) < 1e-9);
  assert.equal(fit.sessions, 1);
  assert.equal(fit.happyPerEnergy, 0.5);
  assert.equal(calibrate([], { stat: 'defense', maxHappy: 5000, gymOf: () => gym }).perks, null);
});

test('jumpGain doubles happy with Ecstasy and beats training normally', () => {
  const [jump] = planJumps(jumpItems({ xanax: 4, ecstasy: 1, dvd: 2 }), { boosterCapHours: 24 }).jumps;
  const est = jumpGain(jump, { stat: 'strength', value: 20000, maxHappy: 5000, energyPerTrain: 10, dots: 4, perks: 1.2, happyPerEnergy: 0.5 });
  assert.equal(est.happy, 20000);
  assert.ok(est.gain > 2 * est.normal);
});
