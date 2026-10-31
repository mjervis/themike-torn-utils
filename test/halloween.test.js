import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventWindow, isTreatLogTitle, parseTreat, treatStats } from '../js/halloween.js';

const ME = 1;
const attack = (id, started, defender, result = 'Attacked') => ({
  id, started, ended: started + 30, result, attacker: { id: ME }, defender: { id: defender, name: `P${defender}` },
});
const treatLog = (id, timestamp, data = {}) => ({ id: `l${id}`, timestamp, details: { id: 9000, title: 'Halloween treat' }, data });

test('eventWindow runs a week from the start time on 25 Oct TCT', () => {
  const { start, end } = eventWindow('11:30', 2026);
  assert.equal(new Date(start * 1000).toISOString(), '2026-10-25T11:30:00.000Z');
  assert.equal(new Date(end * 1000).toISOString(), '2026-11-01T11:30:00.000Z');
  assert.equal(eventWindow('nonsense', 2026).start, start);
});

test('isTreatLogTitle picks treat logs but not basket purchases', () => {
  assert.ok(isTreatLogTitle('Halloween treat'));
  assert.ok(isTreatLogTitle('Trick or treat attack treats'));
  assert.ok(!isTreatLogTitle('Halloween basket upgrade'));
  assert.ok(!isTreatLogTitle('Item market buy'));
});

test('parseTreat reads the count from several shapes, defaulting to one', () => {
  assert.equal(parseTreat(treatLog(1, 0, { treats: 3 })).treats, 3);
  assert.equal(parseTreat(treatLog(1, 0, { amount: '2' })).treats, 2);
  assert.equal(parseTreat(treatLog(1, 0, { items: [{ id: 5, qty: 4 }] })).treats, 4);
  assert.equal(parseTreat(treatLog(1, 0, {})).treats, 1);
  assert.equal(parseTreat(treatLog(1, 0, { defender: { id: 77 } })).victim, 77);
});

test('treatStats matches treats to attacks and counts how many got 1, 2, 3…', () => {
  const { start, end } = eventWindow('11:30', 2026);
  const attacks = [
    attack(1, start + 100, 10),
    attack(2, start + 1000, 11),
    attack(3, start + 2000, 12),
    attack(4, start + 3000, 13, 'Lost'),
    attack(5, start - 600, 14),                       // before the event
    { ...attack(6, start + 4000, ME), attacker: { id: 99 } }, // someone attacking me
  ];
  const logs = [
    treatLog(1, start + 131),                          // one treat, attack 1
    treatLog(2, start + 1030, { treats: 2 }),          // doubler, attack 2
    treatLog(3, start + 2030, { defender: 12 }),       // two logs on attack 3 add up
    treatLog(4, start + 2031, { defender: 12, treats: 2 }),
    treatLog(5, start + 9000),                         // no attack near it
  ];
  const st = treatStats(attacks, logs, ME, { start, end });
  assert.equal(st.total, 4);
  assert.equal(st.withTreat, 3);
  assert.equal(st.multiplied, 2);
  assert.equal(st.treats, 6);
  assert.deepEqual([...st.dist], [[0, 1], [1, 1], [2, 1], [3, 1]]);
  assert.deepEqual(st.unmatched, { logs: 1, treats: 1 });
  assert.equal(st.byDay.length, 1);
  assert.equal(st.byDay[0].attacks, 4);

  const wins = treatStats([...attacks, attack(7, start + 5000, 15, 'Lost')], [...logs, treatLog(6, start + 5030)], ME,
    { start, end, include: (a) => a.result !== 'Lost' });
  assert.equal(wins.total, 3);
  assert.deepEqual(wins.unmatched, { logs: 1, treats: 1 }); // the loss's treat isn't reported as unmatched
});
