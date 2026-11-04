import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  weekWindow, gymSessions, dailyTotals, statDeltas, attackEnergy, pace,
  energyEffect, midnightsBetween, plan, isGymLogTitle, XANAX_ENERGY, stackMode, totalStats,
} from '../js/energy.js';

const ts = (iso) => Date.parse(iso) / 1000;
const H = 3600;

test('week window starts on the chosen TCT day and hour', () => {
  // Saturday 11 Oct 2025 15:00 TCT → week from Monday 6 Oct 00:00
  const w = weekWindow(ts('2025-10-11T15:00:00Z'), 1, 0);
  assert.equal(w.start, ts('2025-10-06T00:00:00Z'));
  assert.equal(w.end, ts('2025-10-13T00:00:00Z'));
  // Before the rollover hour on the start day, still the previous week
  const early = weekWindow(ts('2025-10-13T05:00:00Z'), 1, 12);
  assert.equal(early.start, ts('2025-10-06T12:00:00Z'));
  // Exactly at rollover belongs to the new week
  assert.equal(weekWindow(ts('2025-10-13T00:00:00Z'), 1, 0).start, ts('2025-10-13T00:00:00Z'));
});

test('gym logs are recognised and their energy read', () => {
  assert.ok(isGymLogTitle('Gym train strength'));
  assert.ok(!isGymLogTitle('Item market buy'));
  const s = gymSessions([
    { id: 'a', timestamp: 1, details: { title: 'Gym train speed' }, data: { trains: 10, energy_used: 50 } },
    { id: 'b', timestamp: 2, details: { title: 'Gym train defense' }, data: { trains: 4, gym: 9 } },
    { id: 'c', timestamp: 3, details: { title: 'Gym train dexterity' }, data: {} },
  ], { 9: 10 });
  assert.deepEqual(s.map((x) => x.energy), [50, 40, null]);
  assert.deepEqual(s.map((x) => x.stat), ['speed', 'defense', 'dexterity']);
});

test('daily totals bucket sessions by TCT day', () => {
  const start = ts('2025-10-06T00:00:00Z');
  const days = dailyTotals([
    { timestamp: start + 5, energy: 100 },
    { timestamp: start + 25 * H, energy: 50 },
    { timestamp: start + 26 * H, energy: 25 },
    { timestamp: start - 1, energy: 999 },
  ], start);
  assert.deepEqual(days.map((d) => d.energy), [100, 75, 0, 0, 0, 0, 0]);
});

test('attack energy is 25 per attack started', () => {
  const d = statDeltas(
    { attackswon: 10, attackslost: 2, attacksdraw: 0, yourunaway: 1, xantaken: 5 },
    { attackswon: 14, attackslost: 3, attacksdraw: 0, yourunaway: 1, xantaken: 8 },
  );
  assert.equal(d.xantaken, 3);
  assert.equal(attackEnergy(d), 125);
  assert.equal(attackEnergy(statDeltas({}, {})), null);
});

test('pace compares spend with an even split of the week', () => {
  const p = pace({ target: 3000, spent: 1000, start: 0, end: 7 * 24 * H, now: 3.5 * 24 * H });
  assert.equal(p.expected, 1500);
  assert.equal(p.ahead, -500);
  assert.equal(p.remaining, 2000);
});

test('energy effects are parsed from item text', () => {
  assert.deepEqual(energyEffect({ name: 'Xanax', type: 'Drug' }), { kind: 'drug', energy: XANAX_ENERGY, toMax: false, cooldownHours: 0 });
  assert.equal(energyEffect({ name: 'Vicodin', type: 'Drug', effect: 'Increases energy by 5' }), null);
  const can = energyEffect({ name: 'Can of Red Cow', type: 'Energy Drink', effect: 'Increases energy by 25 and booster cooldown by 2 hours.' });
  assert.deepEqual(can, { kind: 'booster', energy: 25, toMax: false, cooldownHours: 2 });
  const fhc = energyEffect({ name: 'Feathery Hotel Coupon', type: 'Booster', effect: 'Replenishes energy and nerve. Increases booster cooldown by 6 hours.' });
  assert.equal(fhc.toMax, true);
  assert.equal(energyEffect({ name: 'Lollipop', type: 'Candy', effect: 'Increases happiness by 25' }), null);
});

test('refills come back at every TCT midnight before the week ends', () => {
  const m = midnightsBetween(ts('2025-10-11T15:00:00Z'), ts('2025-10-13T00:00:00Z'));
  assert.deepEqual(m, [ts('2025-10-12T00:00:00Z')]);
});

const bar = { current: 50, maximum: 150, increment: 5, interval: 600, full_time: 6000 }; // 30/hour
const xanax = { id: 206, name: 'Xanax', effect: energyEffect({ name: 'Xanax', type: 'Drug' }), price: 800000, owned: 2 };
const redCow = { id: 1, name: 'Can of Red Cow', effect: { kind: 'booster', energy: 25, toMax: false, cooldownHours: 2 }, price: 2_000_000, owned: 3 };
const base = { cooldowns: { drug: 0, booster: 0 }, refillUsed: false, items: [xanax, redCow], options: { offlineHours: 0 } };

test('natural regen alone can cover the target', () => {
  const now = 0;
  const r = plan({ ...base, now, end: 24 * H, needed: 500, bar });
  assert.equal(Math.round(r.natural), 50 + 720);
  assert.equal(r.allocations.length, 0);
  assert.ok(r.spare > 0);
  assert.equal(r.steps[0].kind, 'train');
});

test('shortfall is filled with refills, then the cheapest energy per dollar', () => {
  const r = plan({ ...base, now: 0, end: 24 * H, needed: 50 + 720 + 150 + 300, bar });
  const kinds = r.allocations.map((a) => a.kind);
  assert.deepEqual(kinds, ['refill', 'xanax']);
  assert.equal(r.allocations[1].count, 2); // 300 more → two Xanax (3,200/E beats Red Cow's 80,000/E)
  assert.equal(r.shortfall, 0);
  const xanSteps = r.steps.filter((s) => s.kind === 'xanax');
  assert.deepEqual(xanSteps.map((s) => s.at), [0, 8 * H]);
});

test('drug cooldown and the end of the week limit Xanax', () => {
  const r = plan({
    ...base, now: 0, end: 10 * H, needed: 5000, bar,
    cooldowns: { drug: 4 * H, booster: 0 }, options: { offlineHours: 0, useRefills: false, useCans: false },
  });
  const xan = r.allocations.find((a) => a.kind === 'xanax');
  assert.equal(xan.count, 1); // only the 4h slot fits; the next would be at 12h
  assert.ok(r.shortfall > 0);
});

test('booster cooldown caps energy drinks and not buying limits to stock', () => {
  const r = plan({
    ...base, now: 0, end: 2 * H, needed: 5000, bar,
    cooldowns: { drug: 0, booster: 20 * H },
    options: { offlineHours: 0, useRefills: false, useXanax: false, allowBuying: true },
  });
  // 24h cap − 20h used + 2h left in the week = 6h → three 2h cans
  assert.equal(r.allocations[0].count, 3);
  const owned = plan({ ...base, now: 0, end: 48 * H, needed: 5000, bar, options: { offlineHours: 0, useRefills: false, useXanax: false, allowBuying: false } });
  assert.equal(owned.allocations[0].count, 3);
});

test('long offline stretches waste natural regen', () => {
  const r = plan({ ...base, now: 0, end: 24 * H, needed: 100, bar, options: { offlineHours: 8 } });
  // full bar takes 5h, so 3h × 30 = 90 lost per day
  assert.equal(r.wastedPerDay, 90);
  assert.equal(Math.round(r.natural), 50 + 720 - 90);
});

test('items you hold are used before buying anything', () => {
  const r = plan({ ...base, now: 0, end: 24 * H, needed: 50 + 720 + 75 + 250, bar, options: { offlineHours: 0, useRefills: false } });
  // both are owned, so the cheaper-per-energy Xanax covers it
  assert.deepEqual(r.allocations.map((a) => [a.label, a.count, a.buy]), [['Xanax', 2, 0]]);
  // with no Xanax held, the three owned Red Cows (75) go first even though buying Xanax is cheaper per energy
  const more = plan({ ...base, items: [{ ...xanax, owned: 0 }, redCow], now: 0, end: 24 * H, needed: 50 + 720 + 75 + 250, bar, options: { offlineHours: 0, useRefills: false } });
  assert.deepEqual(more.allocations.map((a) => [a.label, a.count, a.buy]), [['Can of Red Cow', 3, 0], ['Xanax', 1, 1]]);
});

test('when booster cooldown runs out, denser boosters beat cheaper small cans', () => {
  const goose = { id: 2, name: 'Can of Goose Juice', effect: { kind: 'booster', energy: 5, toMax: false, cooldownHours: 2 }, price: 300_000, owned: 0 };
  const r = plan({
    ...base, items: [goose, { ...redCow, owned: 0 }], now: 0, end: 2 * H, needed: 50 + 60 + 100, bar,
    cooldowns: { drug: 0, booster: 16 * H }, options: { offlineHours: 0, useRefills: false, useXanax: false },
  });
  // 10h of booster room: five Goose Juice (25) would fall short, four Red Cows (100) don't
  assert.deepEqual(r.allocations.map((a) => [a.label, a.count]), [['Can of Red Cow', 4]]);
  assert.equal(r.shortfall, 0);
});

test('energy over max reads as a stack, unless total stats are past 1.2m', () => {
  const over = { ...bar, current: 400 };
  assert.equal(stackMode({ bar: over, stats: 500_000 }).stacking, true);
  assert.equal(stackMode({ bar: over, stats: null }).stacking, true);
  const big = stackMode({ bar: over, stats: 1_200_000 });
  assert.equal(big.stacking, false);
  assert.ok(big.overMax && big.overLimit);
  assert.equal(stackMode({ bar, stats: 500_000 }).stacking, false);
  assert.equal(stackMode({ bar, stats: 2_000_000, mode: 'on' }).stacking, true);
  assert.equal(stackMode({ bar: over, stats: 500_000, mode: 'off' }).stacking, false);
});

test('total battle stats are read from either API shape', () => {
  assert.equal(totalStats({ total: 1_000 }), 1_000);
  assert.equal(totalStats({ strength: { value: 1 }, defense: { value: 2 }, speed: { value: 3 }, dexterity: { value: 4 } }), 10);
  assert.equal(totalStats({ strength: 1 }), null);
  assert.equal(totalStats(null), null);
});

test('a stack is built to 1,000 and trained in one jump instead of now', () => {
  const over = { ...bar, current: 400 };
  const r = plan({
    ...base, now: 0, end: 72 * H, needed: 2000, bar: over, ecstasy: 1,
    cooldowns: { drug: 3 * H, booster: 0 }, stack: stackMode({ bar: over, stats: 300_000 }),
  });
  assert.equal(r.jump.xanax, 2); // 400 → 650 → 900; a third would pass 1,000
  assert.equal(r.jump.energy, 900);
  assert.deepEqual(r.jump.times, [3 * H, 11 * H]);
  assert.equal(r.jump.at, 19 * H); // the drug cooldown clears for Ecstasy
  assert.equal(r.jump.buy, 0);
  assert.ok(!r.steps.some((s) => s.kind === 'train'));
  assert.deepEqual(r.steps.slice(0, 4).map((s) => s.kind), ['stack', 'xanax', 'xanax', 'jump']);
  // the rest of the target comes after the jump, with the Xanax left over after stacking
  assert.equal(r.needed, 2000);
  assert.ok(r.steps.filter((s) => s.kind !== 'stack').every((s) => s.at >= 3 * H));
  assert.ok(!r.allocations.some((a) => a.kind === 'xanax' && a.count > a.buy));
});

test('past 1.2m stats, energy over max is trained now as usual', () => {
  const over = { ...bar, current: 400 };
  const r = plan({ ...base, now: 0, end: 24 * H, needed: 500, bar: over, stack: stackMode({ bar: over, stats: 1_500_000 }) });
  assert.equal(r.jump, undefined);
  assert.equal(r.steps[0].kind, 'train');
  assert.match(r.steps[0].detail, /1\.5m total stats/);
});

test('a jump after the week ends counts towards next week', () => {
  const over = { ...bar, current: 400 };
  const r = plan({ ...base, now: 0, end: 10 * H, needed: 1000, bar: over, stack: stackMode({ bar: over, stats: 0 }) });
  assert.equal(r.jump.inWeek, false);
  assert.equal(r.shortfall, 1000);
  assert.ok(r.steps.every((s) => s.at < 10 * H || s.kind === 'jump'));
});
