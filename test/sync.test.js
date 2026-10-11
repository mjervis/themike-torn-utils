import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../js/db.js';
import { syncLogs, backfillOlder, loadInventory, loadCatalog, identify, savedSnapshots, saveSnapshotFor } from '../js/sync.js';

/** Fake Torn client over a fixed set of logs, recording each call. */
function fakeClient(allLogs) {
  const calls = [];
  return {
    calls,
    async logs(ids, { from, to, maxPages = 20 } = {}) {
      calls.push({ fn: 'logs', ids, from, to, maxPages });
      return allLogs
        .filter((l) => ids.includes(l.details.id) && (from == null || l.timestamp >= from) && (to == null || l.timestamp <= to))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxPages * 100);
    },
    async inventory() { calls.push({ fn: 'inventory' }); return { items: [{ id: 1, amount: 2 }], timestamp: 1 }; },
    async items() { calls.push({ fn: 'items' }); return [{ id: 1 }]; },
    async me() { calls.push({ fn: 'me' }); return { id: 42, name: 'Tester' }; },
  };
}

const log = (id, timestamp, type) => ({ id, timestamp, details: { id: type, title: 't' }, data: {} });

test('first sync backfills, later syncs only ask for newer logs', async () => {
  const db = memoryDb();
  const logs = [log('a', 1000, 1), log('b', 2000, 1), log('c', 3000, 2)];
  const client = fakeClient(logs);

  const first = await syncLogs(db, client, 42, [1, 2], { now: 5000 });
  assert.equal(first.added, 3);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].from, undefined);

  logs.push(log('d', 6000, 1));
  const second = await syncLogs(db, client, 42, [1, 2], { now: 7000 });
  assert.equal(second.added, 1);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1].from > 4000 && client.calls[1].from < 5000, 'incremental from last sync minus overlap');
  assert.deepEqual(second.logs.map((l) => l.id), ['d', 'c', 'b', 'a']);
});

test('a newly selected log type is backfilled separately', async () => {
  const db = memoryDb();
  const client = fakeClient([log('a', 1000, 1), log('x', 1500, 9)]);
  await syncLogs(db, client, 42, [1], { now: 2000 });
  const r = await syncLogs(db, client, 42, [1, 9], { now: 3000 });
  assert.deepEqual(client.calls.slice(1).map((c) => c.ids), [[1], [9]]);
  assert.equal(r.added, 1);
});

test('logs are kept per player', async () => {
  const db = memoryDb();
  await syncLogs(db, fakeClient([log('a', 1000, 1)]), 42, [1], { now: 2000 });
  const other = await syncLogs(db, fakeClient([log('z', 1000, 1)]), 7, [1], { now: 2000 });
  assert.deepEqual(other.logs.map((l) => l.id), ['z']);
});

test('backfillOlder continues from the oldest saved log until complete', async () => {
  const db = memoryDb();
  const logs = Array.from({ length: 250 }, (_, i) => log(`l${i}`, 1000 + i, 1));
  const client = fakeClient(logs);
  const first = await syncLogs(db, client, 42, [1], { maxPages: 1, now: 5000 });
  assert.equal(first.logs.length, 100);
  const more = await backfillOlder(db, client, 42, [1], { maxPages: 1 });
  assert.equal(more.complete, false);
  const rest = await backfillOlder(db, client, 42, [1], { maxPages: 5 });
  assert.equal(rest.complete, true);
  assert.equal(rest.logs.length, 250);
});

test('inventory and catalog are reused within their TTL', async () => {
  const db = memoryDb();
  const client = fakeClient([]);
  await loadInventory(db, client, 42, { now: 1000 });
  const again = await loadInventory(db, client, 42, { now: 1000 + 600 });
  assert.equal(again.fromCache, true);
  const stale = await loadInventory(db, client, 42, { now: 1000 + 4000 });
  assert.equal(stale.fromCache, false);
  const forced = await loadInventory(db, client, 42, { now: 1000 + 4001, force: true });
  assert.equal(forced.fromCache, false);
  await loadCatalog(db, client, { now: 1000 });
  assert.equal((await loadCatalog(db, client, { now: 1100 })).fromCache, true);
  assert.equal(client.calls.filter((c) => c.fn === 'inventory').length, 3);
});

test('player is looked up once per key fingerprint', async () => {
  const db = memoryDb();
  const client = fakeClient([]);
  assert.equal((await identify(db, client, 'abc')).id, 42);
  assert.equal((await identify(db, client, 'abc')).fromCache, true);
  assert.equal(client.calls.filter((c) => c.fn === 'me').length, 1);
});

test('snapshots are stored per player and replaced within a day', async () => {
  const db = memoryDb();
  await saveSnapshotFor(db, 42, { date: '2026-10-01', items: [] });
  await saveSnapshotFor(db, 42, { date: '2026-10-01', items: [{ id: 1 }] });
  await saveSnapshotFor(db, 7, { date: '2026-10-01', items: [] });
  const mine = await savedSnapshots(db, 42);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].items.length, 1);
});
