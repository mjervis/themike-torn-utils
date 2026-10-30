import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, meta } from '../js/db.js';
import { createClient } from '../js/api.js';
import {
  syncAttacks, beatenTargets, targetStatus, compareTargets, trimAttack, isMugLogTitle, parseMug, mugTotals, baseRespect,
} from '../js/targets.js';

const ME = 1;
const attack = (id, started, defender, result, extra = {}) => ({
  id, code: `c${id}`, started, ended: started + 30, result,
  attacker: { id: ME, name: 'Me', level: 20, faction: null },
  defender: { id: defender, name: `P${defender}`, level: 10, faction: { id: 5, name: 'Fac' } },
  respect_gain: 2, respect_loss: 0, modifiers: { fair_fight: 2.5 }, ...extra,
});

test('beatenTargets groups wins per defender and ignores incoming and assists', () => {
  const attacks = [
    attack(1, 100, 7, 'Hospitalized'),
    attack(2, 200, 7, 'Lost'),
    attack(3, 300, 7, 'Mugged', { defender: { id: 7, name: 'Renamed', level: 12, faction: null }, modifiers: { fair_fight: 3 } }),
    attack(4, 400, 8, 'Lost'),                 // never beaten: left out
    attack(5, 500, 9, 'Assist'),               // not a win or a loss
    { ...attack(6, 600, ME, 'Attacked'), attacker: { id: 9 } }, // someone attacking me
  ].map(trimAttack);
  const rows = beatenTargets(attacks, ME);
  assert.equal(rows.length, 1);
  const [r] = rows;
  assert.equal(r.id, 7);
  assert.equal(r.name, 'Renamed');
  assert.equal(r.level, 12);
  assert.equal(r.faction, null);
  assert.equal(r.wins, 2);
  assert.equal(r.losses, 1);
  assert.equal(r.lastWin, 300);
  assert.equal(r.lastResult, 'Mugged');
  assert.equal(r.ff, 3);
  assert.equal(r.mugs, 1);
});

test('targetStatus reads hospital, travel and abroad descriptions', () => {
  const now = 1000;
  assert.deepEqual(targetStatus({ state: 'Okay', description: 'Okay' }, now),
    { kind: 'okay', label: 'Okay', location: 'Torn', until: null, ready: true });

  const hosp = targetStatus({ state: 'Hospital', description: 'In hospital for 20 mins', details: 'Hospitalized by X', until: 2200 }, now);
  assert.equal(hosp.kind, 'hospital');
  assert.equal(hosp.location, 'Torn');
  assert.equal(hosp.until, 2200);
  assert.equal(hosp.ready, false);

  assert.equal(targetStatus({ state: 'Hospital', description: 'In a Swiss hospital for 3 mins', until: 1100 }, now).location, 'Switzerland');
  assert.equal(targetStatus({ state: 'Hospital', description: 'In a South African hospital for 3 mins', until: 1100 }, now).location, 'South Africa');

  const out = targetStatus({ state: 'Hospital', description: 'In hospital for 1 min', until: 900 }, now);
  assert.equal(out.kind, 'okay');
  assert.equal(out.ready, true);
  assert.equal(targetStatus({ state: 'Hospital', description: 'In an Emirati hospital for 1 min', until: 900 }, now).ready, false);

  assert.equal(targetStatus({ state: 'Abroad', description: 'In Mexico' }, now).location, 'Mexico');
  const flying = targetStatus({ state: 'Traveling', description: 'Returning to Torn from Japan', until: 0 }, now);
  assert.equal(flying.location, 'Japan → Torn');
  assert.equal(flying.until, null);
  assert.equal(targetStatus({ state: 'Traveling', description: 'Traveling to Hawaii' }, now).location, 'Torn → Hawaii');
  assert.equal(targetStatus({ state: 'Fallen', description: 'Fallen' }, now).kind, 'gone');
  assert.equal(targetStatus(null, now), null);
});

test('compareTargets puts hittable first, then soonest out of hospital, then unchecked', () => {
  const t = (id, where, lastWin = 0) => ({ id, where, lastWin });
  const rows = [
    t('unchecked', null, 999),
    t('abroad', { kind: 'abroad', ready: false }),
    t('hosp-late', { kind: 'hospital', ready: false, until: 500 }),
    t('ready-old', { kind: 'okay', ready: true }, 1),
    t('hosp-soon', { kind: 'hospital', ready: false, until: 200 }),
    t('ready-new', { kind: 'okay', ready: true }, 5),
  ].sort(compareTargets);
  assert.deepEqual(rows.map((r) => r.id), ['ready-new', 'ready-old', 'hosp-soon', 'hosp-late', 'abroad', 'unchecked']);
});

test('syncAttacks backfills once, then only asks for newer attacks', async () => {
  const db = memoryDb();
  const calls = [];
  let all = [attack(1, 1000, 7, 'Hospitalized'), attack(2, 2000, 8, 'Mugged')];
  const client = {
    async attacks(opts) {
      calls.push(opts);
      return all.filter((a) => opts.from == null || a.started >= opts.from).sort((a, b) => b.started - a.started);
    },
  };
  const first = await syncAttacks(db, client, ME, { maxPages: 3, now: 5000 });
  assert.equal(first.attacks.length, 2);
  assert.equal(first.complete, true);
  assert.equal(calls[0].from, undefined);
  assert.equal(calls[0].maxPages, 3);

  all = [...all, attack(3, 4000, 9, 'Attacked')];
  const second = await syncAttacks(db, client, ME, { now: 6000 });
  assert.equal(calls[1].from, 2000 - 300);
  assert.equal(second.added, 1);
  assert.deepEqual(second.attacks.map((a) => a.id), [3, 2, 1]);
  assert.equal(second.complete, true);
});

test('syncAttacks reads history again when saved before chain positions were kept', async () => {
  const db = memoryDb();
  const old = { ...trimAttack(attack(1, 1000, 7, 'Hospitalized')) };
  delete old.chain;
  await meta.set(db, `targets:attacks:${ME}`, { attacks: [old], complete: true, at: 1 });
  const calls = [];
  const client = { async attacks(opts) { calls.push(opts); return [attack(1, 1000, 7, 'Hospitalized', { chain: 10 })]; } };
  const synced = await syncAttacks(db, client, ME, { maxPages: 3, now: 5000 });
  assert.equal(calls[0].from, undefined);
  assert.equal(synced.attacks[0].chain, 10);
  assert.equal(synced.complete, true);
  await syncAttacks(db, client, ME, { now: 6000 });
  assert.equal(calls[1].from, 1000 - 300);
});

test('client.attacks asks for outgoing attacks and pages back by start time', { timeout: 20000 }, async () => {
  const urls = [];
  const page = (start) => Array.from({ length: 100 }, (_, i) => attack(start - i, start - i, 7, 'Attacked'));
  globalThis.fetch = async (url) => {
    urls.push(new URL(url));
    const to = urls.at(-1).searchParams.get('to');
    return new Response(JSON.stringify({ attacks: to ? page(Number(to)).slice(0, 30) : page(1000) }));
  };
  const attacks = await createClient('k').attacks({ maxPages: 5 });
  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, '/v2/user/attacks');
  assert.equal(urls[0].searchParams.get('filters'), 'outgoing');
  assert.equal(urls[1].searchParams.get('to'), '901');
  assert.equal(attacks.length, 129); // 100 + 30, one shared at the page boundary
  assert.equal(attacks[0].started, 1000);
});

test('isMugLogTitle picks mugs you made, not ones made on you', () => {
  assert.equal(isMugLogTitle('Attack mug'), true);
  assert.equal(isMugLogTitle('Attack mugged'), true);
  assert.equal(isMugLogTitle('Attack mug receive'), false);
  assert.equal(isMugLogTitle('Attack mugged by'), false);
  assert.equal(isMugLogTitle('Attack hospitalize'), false);
  assert.equal(isMugLogTitle('Smuggling'), false);
});

test('parseMug reads money and victim from several field names', () => {
  assert.deepEqual(parseMug({ id: 'a', timestamp: 5, data: { money_mugged: 12345, defender: 7 } }), { id: 'a', timestamp: 5, amount: 12345, victim: 7 });
  assert.deepEqual(parseMug({ id: 'b', timestamp: 6, data: { money: '$1,000', target: { id: 8 } } }), { id: 'b', timestamp: 6, amount: 1000, victim: 8 });
  assert.deepEqual(parseMug({ id: 'c', timestamp: 7, data: {} }), { id: 'c', timestamp: 7, amount: null, victim: null });
});

test('mugTotals adds up per target, matching logs with no victim to the attack by time', () => {
  const attacks = [
    attack(1, 1000, 7, 'Mugged'), // ends 1030
    attack(2, 5000, 8, 'Mugged'), // ends 5030
    attack(3, 9000, 9, 'Hospitalized'),
  ].map(trimAttack);
  const logs = [
    { id: 'l1', timestamp: 1031, data: { money_mugged: 500 } },          // matched to attack 1 → 7
    { id: 'l2', timestamp: 5032, data: { money_mugged: 2000 } },         // matched to attack 2 → 8
    { id: 'l3', timestamp: 6000, data: { money_mugged: 300, defender: 7 } }, // says who
    { id: 'l4', timestamp: 9001, data: { money_mugged: 50 } },           // no Mugged attack near it
    { id: 'l5', timestamp: 9500, data: {} },                             // no amount: ignored
  ];
  const all = mugTotals(logs, attacks, ME);
  assert.equal(all.total, 2850);
  assert.equal(all.count, 4);
  assert.equal(all.unmatched, 1);
  assert.deepEqual(all.byTarget.get(7), { mugs: 2, money: 800, biggest: 500, lastMug: 6000, lastAmount: 300 });
  assert.deepEqual(all.byTarget.get(8), { mugs: 1, money: 2000, biggest: 2000, lastMug: 5032, lastAmount: 2000 });

  const recent = mugTotals(logs, attacks, ME, 5000);
  assert.equal(recent.total, 2350);
  assert.equal(recent.byTarget.get(7).money, 300);
});

test('respect leaves out chain bonus hits and the chain multiplier', () => {
  const attacks = [
    attack(1, 100, 7, 'Hospitalized', { respect_gain: 3, chain: 9, modifiers: { fair_fight: 2, chain: 1.5 } }),
    attack(2, 200, 7, 'Attacked', { respect_gain: 40, chain: 10, modifiers: { fair_fight: 2, chain: 1.5 } }), // bonus hit
    attack(3, 300, 8, 'Mugged', { respect_gain: 4, chain: 0 }),
  ].map(trimAttack);
  assert.equal(baseRespect(attacks[0]), 2);
  assert.equal(baseRespect(attacks[1]), null);
  assert.equal(baseRespect(attacks[2]), 4);
  const rows = new Map(beatenTargets(attacks, ME).map((r) => [r.id, r]));
  assert.equal(rows.get(7).respect, 2);
  assert.equal(rows.get(7).lastWin, 200);
  assert.equal(rows.get(8).respect, 4);
});
