import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSnapshot, contributorMap, leaderboard, leaderboardText, weekSnapshots } from '../js/energylb.js';

const H = 3600;
const D = 24 * H;
const START = 1_763_337_600; // Mon 17 Nov 2025 00:00 TCT
const week = { start: START, end: START + 7 * D };

test('contributorMap keys running totals by member id', () => {
  assert.deepEqual(contributorMap([{ id: 1, username: 'a', value: 500 }, { id: 2, value: '30' }, { id: 3 }]), { 1: 500, 2: 30 });
});

test('addSnapshot keeps one read per hour, the latest', () => {
  let snaps = addSnapshot([], { at: START + 10, energy: { 1: 1 } });
  snaps = addSnapshot(snaps, { at: START + 600, energy: { 1: 2 } });
  snaps = addSnapshot(snaps, { at: START + H + 5, energy: { 1: 3 } });
  assert.deepEqual(snaps.map((s) => s.energy[1]), [2, 3]);
});

test('addSnapshot thins reads over 14 days old to one a day and drops those over 180 days', () => {
  const now = START + 200 * D;
  const old = [
    { at: now - 190 * D }, { at: now - 30 * D + H }, { at: now - 30 * D + 5 * H }, { at: now - 2 * D }, { at: now - 2 * D + 2 * H },
  ];
  const snaps = addSnapshot(old, { at: now });
  assert.deepEqual(snaps.map((s) => s.at), [now - 30 * D + H, now - 2 * D, now - 2 * D + 2 * H, now]);
});

test('weekSnapshots picks the reads nearest the week start and the latest while the week runs', () => {
  const snaps = [{ at: START - 3 * D }, { at: START + 20 * 60 }, { at: START + 2 * D }, { at: START + 3 * D }];
  const p = weekSnapshots(snaps, { ...week, now: START + 3 * D + 5 });
  assert.equal(p.from.at, START + 20 * 60);
  assert.equal(p.to.at, START + 3 * D);
  assert.equal(p.late, false);
  assert.equal(p.early, false);
});

test('weekSnapshots for a past week ends at the read nearest its end and flags gaps', () => {
  const snaps = [{ at: START + 5 * H }, { at: START + 6 * D }, { at: START + 7 * D + 30 * 60 }, { at: START + 9 * D }];
  const p = weekSnapshots(snaps, { ...week, now: START + 10 * D });
  assert.equal(p.from.at, START + 5 * H);
  assert.equal(p.to.at, START + 7 * D + 30 * 60);
  assert.equal(p.late, true);
  assert.equal(p.over, false);
});

test('weekSnapshots is null with only one read, or none before the week ended', () => {
  assert.equal(weekSnapshots([{ at: START + H }], { ...week, now: START + 2 * H }), null);
  assert.equal(weekSnapshots([{ at: START + 8 * D }, { at: START + 9 * D }], { ...week, now: START + 10 * D }), null);
});

test('leaderboard splits by 1.2m stats, ranks by energy and flags overdoses', () => {
  const from = { at: START, energy: { 1: 1000, 2: 5000, 3: 200, 4: 0 }, od: { 1: 2, 2: 0, 3: 1, 4: 0 } };
  const to = { at: START + 7 * D, energy: { 1: 4000, 2: 6000, 3: 3700, 4: 0, 5: 900 }, od: { 1: 3, 2: 0, 3: 1, 4: 0, 5: 0 } };
  const members = [
    { id: 1, name: 'Alpha', days_in_faction: 300 }, { id: 2, name: 'Bravo', days_in_faction: 300 },
    { id: 3, name: 'Charlie', days_in_faction: 300 }, { id: 4, name: 'Delta', days_in_faction: 300 },
    { id: 5, name: 'Echo', days_in_faction: 2 },
  ];
  const b = leaderboard({ from, to, members, membersAt: to.at, big: { 1: true, 2: true }, target: 3000 });
  assert.deepEqual(b.high.map((r) => [r.rank, r.name, r.energy, r.overdoses]), [[1, 'Alpha', 3000, 1], [2, 'Bravo', 1000, 0]]);
  assert.deepEqual(b.low.map((r) => [r.rank, r.name, r.energy]), [[1, 'Charlie', 3500], [2, 'Echo', 900], [3, 'Delta', 0]]);
  assert.equal(b.low.find((r) => r.name === 'Echo').joined, true);
  assert.equal(b.low.find((r) => r.name === 'Charlie').joined, false);
  assert.equal(b.totals.all.energy, 8400);
  assert.equal(b.totals.all.overdosed, 1);
  assert.equal(b.totals.high.metTarget, 1);
  assert.equal(b.totals.low.metTarget, 1);
  assert.equal(b.totals.all.zero, 1);
});

test('leaderboard leaves out members who have left', () => {
  const from = { at: START, energy: { 1: 0, 9: 0 }, od: {} };
  const to = { at: START + D, energy: { 1: 50, 9: 80 }, od: {} };
  const b = leaderboard({ from, to, members: [{ id: 1, name: 'A' }] });
  assert.deepEqual(b.low.map((r) => r.id), [1]);
});

test('leaderboardText lists the top of each board and who overdosed', () => {
  const from = { at: START, energy: { 1: 0, 2: 0 }, od: { 1: 0, 2: 0 } };
  const to = { at: START + D, energy: { 1: 1500, 2: 250 }, od: { 1: 0, 2: 2 } };
  const b = leaderboard({ from, to, members: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], big: { 1: true } });
  assert.equal(leaderboardText(b, { label: '17–23 Nov' }), [
    'Faction gym energy — 17–23 Nov: 1,750e from 2 members',
    '1.2m+ stats:\n1. A 1,500e',
    'Under 1.2m stats:\n1. B 250e (OD)',
    'Overdosed: B ×2',
  ].join('\n'));
});

test('members missing from the first read are counted from the first read that has them', () => {
  const snaps = [
    { at: START, energy: { 1: 100 }, od: { 1: 0 } },
    { at: START + D, energy: { 1: 200, 2: 900_000 }, od: { 1: 0, 2: 7 } },
    { at: START + 2 * D, energy: { 1: 300, 2: 901_000 }, od: { 1: 0, 2: 8 } },
  ];
  const p = weekSnapshots(snaps, { ...week, now: START + 2 * D + 5 });
  const b = leaderboard({ from: p.from, to: p.to, members: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] });
  const bRow = b.low.find((r) => r.id === 2);
  assert.equal(bRow.energy, 1000);
  assert.equal(bRow.overdoses, 1);
  assert.equal(bRow.firstSeen, true);
  assert.equal(b.low.find((r) => r.id === 1).firstSeen, false);
});
