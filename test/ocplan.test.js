import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cprHistory, lookupCpr, openSlots, hungarian, ocPlan, slotLabel, roleOf, planningPerSlot, crimeValues, estimateReady } from '../js/ocplan.js';

const DAY = 86400;
const NOW = Date.UTC(2026, 10, 16) / 1000;

// A slot: [label, user id or null, cpr]
const slot = ([label, id, cpr, joined = NOW - 10 * DAY]) => ({
  position: roleOf(label), position_info: { id: 'P1', label }, checkpoint_pass_rate: cpr, item_requirement: null,
  user: id == null ? null : { id, joined_at: joined },
});
const crime = (id, name, difficulty, status, slots, extra = {}) => ({
  id, name, difficulty, status, created_at: NOW - 20 * DAY, executed_at: status === 'Successful' ? NOW - 5 * DAY : null,
  expired_at: NOW + 2 * DAY, slots: slots.map(slot), ...extra,
});
const member = (id, name, extra = {}) => ({ id, name, level: 50, position: 'Member', is_in_oc: false, last_action: { timestamp: NOW - 3600 }, status: { state: 'Okay' }, ...extra });

test('slot labels and roles', () => {
  assert.equal(slotLabel({ position: 'Muscle', position_info: { label: 'Muscle #2' } }), 'Muscle #2');
  assert.equal(slotLabel({ position: 'Muscle', position_number: 2 }), 'Muscle #2');
  assert.equal(slotLabel({ position: 'Hacker' }), 'Hacker');
  assert.equal(roleOf('Muscle #2'), 'Muscle');
});

test('cprHistory keeps each member\'s most recent CPR per crime and slot, skipping expired OCs', () => {
  const crimes = [
    crime(1, 'Mob Mentality', 3, 'Successful', [['Looter #1', 10, 60, NOW - 30 * DAY]]),
    crime(2, 'Mob Mentality', 3, 'Successful', [['Looter #1', 10, 72, NOW - 8 * DAY]]),
    crime(3, 'Mob Mentality', 3, 'Expired', [['Looter #1', 10, 0, NOW - 2 * DAY]]),
    crime(4, 'Pet Project', 2, 'Recruiting', [['Kidnapper', null, 81]]),
  ];
  const h = cprHistory(crimes, { self: 99, now: NOW });
  assert.equal(h.get(10).get('Mob Mentality|Looter #1').cpr, 72);
  assert.equal(h.get(99).get('Pet Project|Kidnapper').cpr, 81); // the key owner's own CPR for an empty slot
  // Another numbered slot of the same role falls back to the role.
  const r = lookupCpr(h, 10, 'Mob Mentality', 'Looter #3');
  assert.equal(r.cpr, 72);
  assert.equal(r.exact, false);
  assert.equal(lookupCpr(h, 10, 'Pet Project', 'Kidnapper'), null);
});

test('openSlots lists empty slots of recruiting and planning OCs', () => {
  const s = openSlots([
    crime(1, 'A', 2, 'Recruiting', [['X', null, 0], ['Y', 5, 70]]),
    crime(2, 'B', 4, 'Planning', [['X', 6, 70], ['Y', null, 0], ['Z', null, 0]]),
    crime(3, 'C', 4, 'Successful', [['X', 7, 70]]),
  ]);
  assert.deepEqual(s.map((x) => `${x.crime}:${x.label}:${x.filled}/${x.total}`), ['A:X:1/2', 'B:Y:1/3', 'B:Z:1/3']);
});

test('hungarian finds the minimum-cost assignment', () => {
  assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);
  assert.deepEqual(hungarian([[1, 9, 9], [9, 9, 1]]), [0, 2]); // fewer rows than columns
  assert.deepEqual(hungarian([]), []);
});

test('ocPlan fills as many slots as it can, preferring higher-level OCs', () => {
  const history = [
    // Alice passes both crimes; Bob only the level 3 one.
    crime(1, 'Big', 7, 'Successful', [['Robber', 1, 80]]),
    crime(2, 'Small', 3, 'Successful', [['Lookout', 1, 90], ['Lookout', 2, 75]]),
  ];
  const open = [
    crime(10, 'Small', 3, 'Recruiting', [['Lookout', null, 0]]),
    crime(11, 'Big', 7, 'Recruiting', [['Robber', null, 0]]),
  ];
  const members = [member(1, 'Alice'), member(2, 'Bob')];
  const p = ocPlan([...history, ...open], members, { now: NOW });
  const by = Object.fromEntries(p.assignments.map((a) => [a.crime, a.member.name]));
  // Alice would score higher on Small, but putting her there leaves Big empty.
  assert.deepEqual(by, { Big: 'Alice', Small: 'Bob' });
  assert.equal(p.unfilled.length, 0);
  assert.equal(p.assignments[0].crime, 'Big'); // higher level first
});

test('ocPlan leaves out members below the minimum CPR, in an OC, or inactive', () => {
  const crimes = [
    crime(1, 'Small', 3, 'Successful', [['Lookout', 1, 60], ['Lookout', 2, 95], ['Lookout', 3, 95]]),
    crime(2, 'Small', 3, 'Planning', [['Lookout', 4, 80], ['Lookout', null, 0]]),
  ];
  const members = [
    member(1, 'Low'),
    member(2, 'Busy', { is_in_oc: true }),
    member(3, 'Idle', { last_action: { timestamp: NOW - 10 * DAY } }),
    member(4, 'InOpen'),
    member(5, 'New'),
  ];
  const p = ocPlan(crimes, members, { now: NOW, minCpr: 70 });
  assert.equal(p.assignments.length, 0);
  assert.equal(p.unfilled.length, 1);
  assert.deepEqual(p.unfilled[0].candidates.map((c) => [c.member.name, c.cpr]), [['Low', 60]]);
  assert.deepEqual(p.free.map((m) => m.name), ['Low', 'New']);
  assert.deepEqual(p.skipped.map((m) => m.name), ['Idle']);
  const un = Object.fromEntries(p.unplaced.map((m) => [m.name, m]));
  assert.equal(un.New.anyCpr, false);
  assert.equal(un.Low.known.length, 0); // 60% is under the minimum
});

test('ocPlan in pass-rate mode prefers the better CPR over the higher level', () => {
  const crimes = [
    crime(1, 'Big', 7, 'Successful', [['Robber', 1, 71]]),
    crime(2, 'Small', 3, 'Successful', [['Lookout', 1, 99]]),
    crime(10, 'Small', 3, 'Recruiting', [['Lookout', null, 0]]),
    crime(11, 'Big', 7, 'Recruiting', [['Robber', null, 0]]),
  ];
  const level = ocPlan(crimes, [member(1, 'Alice')], { now: NOW });
  assert.equal(level.assignments[0].crime, 'Big');
  const cpr = ocPlan(crimes, [member(1, 'Alice')], { now: NOW, prioritise: 'cpr' });
  assert.equal(cpr.assignments[0].crime, 'Small');
  assert.equal(cpr.unfilled[0].crime, 'Big');
  assert.deepEqual(cpr.unfilled[0].candidates.map((c) => [c.member.name, c.placed]), [['Alice', true]]);
});

test('ocPlan suggests OCs to spawn for members left without a slot', () => {
  const crimes = [
    crime(1, 'Big', 7, 'Successful', [['Robber', 1, 80], ['Driver', 1, 75]]),
    crime(2, 'Small', 3, 'Successful', [['Lookout', 1, 90]]),
  ];
  const p = ocPlan(crimes, [member(1, 'Alice')], { now: NOW });
  assert.deepEqual(p.unplaced[0].known.map((k) => `${k.crime}:${k.role}`), ['Big:Robber', 'Big:Driver', 'Small:Lookout']);
});

test('planningPerSlot learns planning time per slot from past OCs', () => {
  const past = (id, name, hours, n) => ({ ...crime(id, name, 3, 'Successful', Array.from({ length: n }, () => ['X', 1, 80])), planning_at: NOW - 10 * DAY, ready_at: NOW - 10 * DAY + hours * 3600 });
  const per = planningPerSlot([past(1, 'A', 48, 4), past(2, 'A', 32, 4), past(3, 'B', 72, 3)]);
  assert.equal(per('A'), 10 * 3600); // median of 12h and 8h a slot
  assert.equal(per('B'), 24 * 3600);
  assert.equal(per('Unknown'), 12 * 3600); // median over everything
  assert.equal(planningPerSlot([])('A'), DAY);
});

test('crimeValues is average respect of successes times the success rate', () => {
  const done = (id, name, level, status, respect) => ({ ...crime(id, name, level, status, [['X', 1, 80]]), rewards: status === 'Successful' ? { respect } : null });
  const v = crimeValues([done(1, 'A', 3, 'Successful', 100), done(2, 'A', 3, 'Successful', 200), done(3, 'A', 3, 'Failure'), done(4, 'A', 3, 'Successful', 300)]);
  assert.equal(v('A', 3).respect, 200 * 0.75);
  assert.equal(v('A', 3).estimated, false);
  assert.equal(v('New', 3).respect, 150); // the level's average
  assert.equal(v('New', 3).estimated, true);
  assert.equal(v('New', 8).respect, 8);   // nothing at that level: the level itself
});

test('estimateReady uses Torn\'s ready time once full, else the planning left', () => {
  const c = crime(1, 'A', 3, 'Planning', [['X', 1, 80], ['Y', 2, 80], ['Z', null, 0]]);
  c.slots[0].user.progress = 100;
  c.slots[1].user.progress = 50;
  assert.equal(estimateReady(c, 3600, NOW), NOW + 1.5 * 3600);
  const full = { ...crime(2, 'A', 3, 'Planning', [['X', 1, 80]]), ready_at: NOW + 500 };
  assert.equal(estimateReady(full, 3600, NOW), NOW + 500);
});

test('ocPlan "completed" fills whole OCs rather than spreading members across them', () => {
  const crimes = [
    crime(1, 'Big', 7, 'Successful', [['A', 1, 90], ['B', 2, 90], ['C', 3, 90]]),
    crime(2, 'Pair', 2, 'Successful', [['A', 1, 80], ['B', 2, 80]]),
    // Big needs three, but only Alice and Bob are free: filling it leaves Pair empty and Big unfinished.
    crime(10, 'Big', 7, 'Recruiting', [['A', null, 0], ['B', null, 0], ['C', null, 0]]),
    crime(11, 'Pair', 2, 'Recruiting', [['A', null, 0], ['B', null, 0]]),
  ];
  const members = [member(1, 'Alice'), member(2, 'Bob')];
  const level = ocPlan(crimes, members, { now: NOW });
  assert.deepEqual(level.assignments.map((a) => a.crime), ['Big', 'Big']);
  const done = ocPlan(crimes, members, { now: NOW, prioritise: 'completed' });
  assert.deepEqual(done.assignments.map((a) => a.crime), ['Pair', 'Pair']);
  assert.equal(done.ocs[0].crime, 'Pair');
  assert.equal(done.ocs[0].complete, true);
  assert.equal(done.ocs[1].empty, 3);
});

test('ocPlan "respect" fills the OCs worth the most respect', () => {
  const won = (id, name, respect, slots) => ({ ...crime(id, name, 3, 'Successful', slots), rewards: { respect } });
  const crimes = [
    won(1, 'Cheap', 10, [['A', 1, 90]]), won(2, 'Cheap2', 10, [['A', 2, 90]]), won(3, 'Rich', 50, [['A', 1, 90], ['B', 2, 90]]),
    crime(10, 'Cheap', 3, 'Recruiting', [['A', null, 0]]),
    crime(11, 'Cheap2', 3, 'Recruiting', [['A', null, 0]]),
    crime(12, 'Rich', 3, 'Recruiting', [['A', null, 0], ['B', null, 0]]),
  ];
  const members = [member(1, 'Alice'), member(2, 'Bob')];
  const count = ocPlan(crimes, members, { now: NOW, prioritise: 'completed' });
  assert.deepEqual(count.ocs.filter((o) => o.complete).map((o) => o.crime).sort(), ['Cheap', 'Cheap2']);
  const respect = ocPlan(crimes, members, { now: NOW, prioritise: 'respect' });
  assert.deepEqual(respect.ocs.filter((o) => o.complete).map((o) => o.crime), ['Rich']);
});

test('ocPlan lists open OCs by earliest possible completion', () => {
  const crimes = [
    crime(1, 'A', 3, 'Successful', [['X', 1, 90], ['X', 2, 90]]),
    { ...crime(10, 'A', 3, 'Planning', [['X', 5, 80], ['X', null, 0]]) },
    crime(11, 'A', 5, 'Recruiting', [['X', null, 0], ['X', null, 0]]),
  ];
  crimes[1].slots[0].user.progress = 100;
  // Higher-level OCs first puts Alice in the level 5 OC, which still needs another member…
  const level = ocPlan(crimes, [member(1, 'Alice')], { now: NOW });
  assert.deepEqual(level.ocs.map((o) => [o.crimeId, o.complete, o.empty]), [[10, false, 1], [11, false, 1]]);
  // …while most OCs completed finishes the one already planning.
  const p = ocPlan(crimes, [member(1, 'Alice')], { now: NOW, prioritise: 'completed' });
  assert.deepEqual(p.ocs.map((o) => [o.crimeId, o.complete]), [[10, true], [11, false]]);
  assert.ok(p.ocs[0].ready < p.ocs[1].ready);
  assert.equal(p.assignments[0].crimeId, 10);
});
