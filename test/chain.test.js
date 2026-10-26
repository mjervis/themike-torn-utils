import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../js/db.js';
import {
  COMPETITION, matchTeams, reportTotals, chainState, memberTotals, standings, syncChain,
  syncFactionAttacks, weekHits, trimFactionAttack,
} from '../js/chain.js';

const START = COMPETITION.start;
const attacker = (id, { leave = 0, mug = 0, hosp = 0, respect = 0, losses = 0, assists = 0 } = {}) => ({
  id, respect: { total: respect, average: 0, best: 0 },
  attacks: { total: leave + mug + hosp + losses + assists, leave, mug, hospitalize: hosp, assists, retaliations: 0, overseas: 0, draws: 0, escapes: 0, losses, war: 0, bonuses: 0 },
});
const report = (id, start, end, chain, attackers, bonuses = []) => ({ id, faction_id: 9, start, end, details: { chain, respect: 0 }, attackers, bonuses, non_attackers: [] });

test('matchTeams matches exact names first, then a unique prefix or substring', () => {
  const members = [
    { id: 1, name: 'NR94' }, { id: 2, name: 'Lil_Dixie' }, { id: 3, name: 'Mike_T' }, { id: 4, name: 'MikeyB' },
    { id: 5, name: 'Wolfie' }, { id: 6, name: 'gabe' },
  ];
  const teams = [
    { id: 'a', members: ['NR94', 'Lil Dixie', 'Gabe'] },
    { id: 'b', members: ['Mike', 'Wolf', 'Nobody'] },
  ];
  const { assigned, unmatched } = matchTeams(members, teams);
  assert.equal(assigned.get(1), 'a');
  assert.equal(assigned.get(2), 'a'); // spaces and underscores ignored
  assert.equal(assigned.get(6), 'a'); // case ignored
  assert.equal(assigned.get(5), 'b'); // only member starting with "wolf"
  assert.equal(assigned.has(3), false); // two members start with "mike": left for a person to pick
  assert.deepEqual(unmatched.map((u) => u.name).sort(), ['Mike', 'Nobody']);
});

test('reportTotals counts leaves, mugs and hospitalisations as hits and splits off bonus respect', () => {
  const r = report(1, START, 0, 30, [attacker(10, { leave: 5, mug: 3, hosp: 2, respect: 40, losses: 1, assists: 2 })],
    [{ attacker_id: 10, defender_id: 99, chain: 10, respect: 10 }, { attacker_id: 10, defender_id: 98, chain: 25, respect: 20 }]);
  const t = reportTotals(r).get(10);
  assert.equal(t.hits, 10);
  assert.equal(t.respect, 40);
  assert.equal(t.bonusRespect, 30);
  assert.equal(t.bonusHits, 2);
  assert.equal(t.losses, 1);
  assert.equal(t.assists, 2);
});

test('chainState counts chains since the start and halves prizes only if one broke short of the goal', () => {
  const old = report(1, START - 7200, START - 3600, 400, []);
  const live = { id: 2, current: 812, max: 1000, timeout: 200, start: START + 60 };
  let s = chainState([old, report(2, START + 60, 0, 800, [])], live);
  assert.deepEqual(s.chains.map((c) => c.id), [2]);
  assert.equal(s.length, 812); // the live count is ahead of the report
  assert.equal(s.broken, false);
  assert.equal(s.reached, false);

  // Broke at 900, a new chain started.
  s = chainState([report(2, START + 60, START + 9000, 900, []), report(3, START + 9100, 0, 50, [])], { id: 3, current: 55, start: START + 9100 });
  assert.equal(s.broken, true);
  assert.equal(s.chains.length, 2);

  // Reached the goal, then ended: not broken.
  s = chainState([report(2, START + 60, START + 90000, 2600, [])], { id: 0, current: 0 });
  assert.equal(s.reached, true);
  assert.equal(s.broken, false);

  // A chain running from before the start is counted and flagged.
  s = chainState([report(4, START - 600, 0, 120, [])], { id: 4, current: 120, start: START - 600 });
  assert.equal(s.early, true);
});

test('standings ranks teams by hits per member and pays qualified members by place', () => {
  const r = report(2, START, 0, 0, [
    attacker(1, { leave: 40, respect: 100 }), attacker(2, { leave: 10, respect: 20 }), // team a: 50 hits / 2 = 25
    attacker(3, { leave: 60, respect: 300 }), attacker(4, { leave: 31, respect: 90 }), attacker(5, { leave: 2 }), // b: 93 / 3 = 31
    attacker(7, { leave: 5 }), // not on a team
  ], [{ attacker_id: 3, chain: 50, respect: 250 }]);
  const teams = [{ id: 'a', name: 'A', members: [] }, { id: 'b', name: 'B', members: [] }];
  const assignment = new Map([[1, 'a'], [2, 'a'], [3, 'b'], [4, 'b'], [5, 'b']]);
  const names = new Map([[1, 'One'], [2, 'Two'], [3, 'Three'], [4, 'Four'], [5, 'Five'], [7, 'Seven']]);
  const comp = { ...COMPETITION, placePrizes: [25e6, 15e6] };
  const s = standings({ teams, assignment, names, totals: memberTotals([r]), comp });
  assert.deepEqual(s.teams.map((t) => [t.id, t.place, t.score]), [['b', 1, 31], ['a', 2, 25]]);
  const b = s.teams[0];
  assert.equal(b.qualified, 2);
  assert.equal(b.payout, 50e6);
  assert.deepEqual(b.members.map((m) => m.payout), [25e6, 25e6, 0]);
  assert.deepEqual(s.others.map((m) => m.id), [7]);
  // Three's 250 bonus respect doesn't count: One leads on regular respect.
  assert.deepEqual(s.soulCollector.leaders.map((m) => [m.id, m.regularRespect]), [[1, 100], [4, 90], [3, 50], [2, 20]]);
  assert.deepEqual(s.raffles.find((x) => x.min === 50).entrants.map((m) => m.id), [3]);

  const halved = standings({ teams, assignment, names, totals: memberTotals([r]), comp, broken: true });
  assert.equal(halved.teams[0].prizeEach, 12.5e6);
  assert.equal(halved.soulCollector.prize, 50e6);
});

test('standings shares a place between teams level on score', () => {
  const r = report(2, START, 0, 0, [attacker(1, { leave: 30 }), attacker(2, { leave: 30 }), attacker(3, { leave: 1 })]);
  const teams = [{ id: 'a', name: 'A', members: [] }, { id: 'b', name: 'B', members: [] }, { id: 'c', name: 'C', members: [] }];
  const s = standings({ teams, assignment: new Map([[1, 'a'], [2, 'b'], [3, 'c']]), names: new Map(), totals: memberTotals([r]) });
  assert.deepEqual(s.teams.map((t) => t.place), [1, 1, 3]);
});

test('syncChain fetches finished chain reports once and the latest report every time', async () => {
  const db = memoryDb();
  const calls = [];
  let live = { id: 2, current: 100, max: 100, timeout: 250, start: START + 60, end: 0 };
  const client = {
    async factionMembers() { calls.push('members'); return [{ id: 1, name: 'One', position: 'Member', level: 50 }]; },
    async chain() { calls.push('chain'); return live; },
    async chains() { calls.push('chains'); return live.id === 3 ? [{ id: 2, chain: 900, start: START + 60, end: START + 9000 }] : []; },
    async chainReport(id) { calls.push(`report:${id ?? 'latest'}`); return report(id ?? live.id, START + 60, id ? START + 9000 : 0, id ? 900 : live.current, [attacker(1, { leave: 3 })]); },
  };
  await syncChain(db, client, 7, { members: true, listChains: true, now: START + 100 });
  assert.deepEqual(calls, ['members', 'chain', 'report:latest', 'chains']);

  calls.length = 0;
  await syncChain(db, client, 7, { now: START + 160 });
  assert.deepEqual(calls, ['chain', 'report:latest']);

  // The chain broke and a new one started: the finished list is re-read and its report fetched once.
  calls.length = 0;
  live = { id: 3, current: 4, max: 4, timeout: 290, start: START + 9100, end: 0 };
  const saved = await syncChain(db, client, 7, { now: START + 9200 });
  assert.deepEqual(calls, ['chain', 'report:latest', 'chains', 'report:2']);
  assert.deepEqual(Object.keys(saved.reports).sort(), ['2', '3']);
  assert.equal(saved.reports[2].end, START + 9000);

  calls.length = 0;
  await syncChain(db, client, 7, { now: START + 9260 });
  assert.deepEqual(calls, ['chain', 'report:latest']);
});

test('standings averages hits over each team\'s qualified members only', () => {
  const r = report(2, START, 0, 0, [attacker(1, { leave: 40 }), attacker(2, { leave: 60 }), attacker(3, { leave: 5 })]);
  const teams = [{ id: 'a', name: 'A', members: [] }, { id: 'b', name: 'B', members: [] }];
  const s = standings({ teams, assignment: new Map([[1, 'a'], [2, 'a'], [3, 'a']]), names: new Map(), totals: memberTotals([r]) });
  const a = s.teams.find((t) => t.id === 'a');
  assert.equal(a.qualifiedAvg, 50); // (40 + 60) / 2; the 5-hit member isn't qualified
  assert.equal(s.teams.find((t) => t.id === 'b').qualifiedAvg, null);
});

const fAttack = (id, started, attackerId, result, chain = 0, respect = 2) => ({
  id, code: `c${id}`, started, ended: started + 20, result, chain, respect_gain: respect, respect_loss: 0,
  attacker: { id: attackerId, name: `M${attackerId}`, level: 50, faction: { id: 9, name: 'Us' } },
  defender: { id: 900 + id, name: 'T', level: 10, faction: null }, modifiers: {},
});

test('weekHits counts wins in and out of chains inside the week only', () => {
  const attacks = [
    fAttack(1, START - 10, 1, 'Attacked', 5),          // before the start
    fAttack(2, START + 10, 1, 'Attacked', 6),
    fAttack(3, START + 20, 1, 'Mugged', 0, 1.5),       // outside a chain
    fAttack(4, START + 30, 1, 'Lost'),                 // an attack, not a hit
    fAttack(5, START + 40, 2, 'Hospitalized', 7),
    fAttack(6, COMPETITION.end, 2, 'Attacked', 0),     // after the end
    { ...fAttack(7, START + 50, 3, 'Attacked'), attacker: null }, // stealthed: no attacker to credit
  ].map(trimFactionAttack);
  const w = weekHits(attacks);
  assert.deepEqual({ ...w.get(1), lastHit: undefined }, { id: 1, name: 'M1', hits: 2, chainHits: 1, respect: 3.5, attacks: 3, lastHit: undefined });
  assert.equal(w.get(1).lastHit, START + 20);
  assert.equal(w.get(2).hits, 1);
  assert.equal(w.size, 2);
});

test('syncFactionAttacks reads the week once, then only newer attacks, and nothing past the end', async () => {
  const db = memoryDb();
  const asks = [];
  const client = {
    async factionAttacks(opts) {
      asks.push({ from: opts.from, to: opts.to });
      return [fAttack(1, START + 100, 1, 'Attacked'), fAttack(2, START - 50, 1, 'Attacked')];
    },
  };
  let saved = await syncFactionAttacks(db, client, 7, { now: START + 1000 });
  assert.deepEqual(asks[0], { from: START, to: START + 1000 });
  assert.deepEqual(saved.attacks.map((a) => a.id), [1]); // the one before the start isn't kept

  saved = await syncFactionAttacks(db, client, 7, { now: COMPETITION.end + 5000 });
  assert.deepEqual(asks[1], { from: START + 100 - 300, to: COMPETITION.end });
  assert.equal(saved.attacks.length, 1);
});

test('matchTeams matches members given with a Torn id by id, whatever their name', () => {
  const members = [{ id: 2238049, name: 'DontTrip' }, { id: 4505292, name: 'THEMikeUK' }, { id: 77, name: 'THEMikeUK2' }];
  const teams = [{ id: 'u', members: [{ name: 'Mike', id: 4505292 }, { name: 'DontTrip', id: 2238049 }, { name: 'Gone', id: 1 }] }];
  const { assigned, unmatched } = matchTeams(members, teams);
  assert.deepEqual([...assigned].sort(), [[2238049, 'u'], [4505292, 'u']]);
  assert.deepEqual(unmatched.map((u) => u.name), ['Gone']); // id not in the faction: falls back to the name, which no one has
});
