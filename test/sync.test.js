import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from '../js/db.js';
import {
  syncLogs, backfillOlder, loadInventory, loadInventoryCategories, savedInventory, loadCatalog, identify, savedSnapshots, saveSnapshotFor,
} from '../js/sync.js';
import { INVENTORY_CATEGORIES } from '../js/api.js';
import { meta } from '../js/db.js';

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
    async inventory({ categories } = {}) {
      calls.push({ fn: 'inventory', categories });
      return { items: categories?.[0] === 'Drug' ? [{ id: 1, amount: 2 }] : [], timestamp: 1 };
    },
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
  assert.equal(client.calls.filter((c) => c.fn === 'inventory').length, 3 * INVENTORY_CATEGORIES.length);
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

test('since: new types read back only to since, then incrementally; earlier since fills the gap', async () => {
  const db = memoryDb();
  const logs = [log('a', 1000, 7), log('b', 3000, 7), log('c', 4000, 7)];
  const client = fakeClient(logs);

  const first = await syncLogs(db, client, 42, [7], { since: 2500, now: 5000 });
  assert.deepEqual(first.logs.map((l) => l.id), ['c', 'b']);
  assert.equal(client.calls[0].from, 2500);

  logs.push(log('d', 6000, 7));
  const second = await syncLogs(db, client, 42, [7], { since: 2500, now: 7000 });
  assert.equal(second.added, 1);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1].from > 4000, 'only newer than the last sync');

  const earlier = await syncLogs(db, client, 42, [7], { since: 500, now: 8000 });
  assert.deepEqual(earlier.logs.map((l) => l.id), ['d', 'c', 'b', 'a']);
  const gap = client.calls.at(-1);
  assert.equal(gap.from, 500);
  assert.equal(gap.to, 2500);

  await syncLogs(db, client, 42, [7], { since: 500, now: 9000 });
  assert.equal(client.calls.length, 5, 'gap is not read twice');
});

test('inventory categories are shared between pages: each is read once per TTL', async () => {
  const db = memoryDb();
  const client = fakeClient([]);
  const reads = () => client.calls.filter((c) => c.fn === 'inventory').map((c) => c.categories[0]);

  await loadInventory(db, client, 42, { now: 1000 });
  const reused = await loadInventoryCategories(db, client, 42, ['Drug', 'Booster'], { now: 1500 });
  assert.equal(reused.fromCache, true);
  assert.deepEqual(reused.value.items, [{ id: 1, amount: 2 }]);
  assert.equal(reads().length, INVENTORY_CATEGORIES.length);

  // A page refreshing its few categories later only reads those, and the full inventory picks them up.
  const fetched = await loadInventoryCategories(db, client, 42, ['Drug'], { now: 1000 + 4000 });
  assert.equal(fetched.fromCache, false);
  assert.deepEqual(reads().slice(INVENTORY_CATEGORIES.length), ['Drug']);
  const full = await loadInventory(db, client, 42, { now: 1000 + 4100 });
  assert.equal(full.at, 5000);
  assert.ok(!reads().slice(INVENTORY_CATEGORIES.length + 1).includes('Drug'), 'Drug is not read again');
});

test('savedInventory reads shared categories without calls, falling back to the old full entry', async () => {
  const db = memoryDb();
  assert.equal(await savedInventory(db, 42, ['Drug']), null);
  await meta.set(db, 'cache:inventory:42', { at: 900, value: { items: [{ id: 1, amount: 27 }, { id: 2, amount: 1 }] } });
  const legacy = await savedInventory(db, 42, ['Drug'], { keep: (it) => it.id === 1 });
  assert.deepEqual(legacy, { value: { items: [{ id: 1, amount: 27 }] }, at: 900 });

  const client = fakeClient([]);
  await loadInventoryCategories(db, client, 42, ['Drug'], { now: 1000 });
  assert.deepEqual(await savedInventory(db, 42, ['Drug']), { value: { items: [{ id: 1, amount: 2 }] }, at: 1000 });
});
