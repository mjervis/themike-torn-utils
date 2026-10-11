// Decides what actually needs fetching from Torn, using what's already saved in the browser.
// Keeps repeat loads down to a handful of calls instead of ~50.
// Player-specific data (inventory, logs, sync state) is saved per player id, so two people
// sharing a browser never see each other's data.

import { STORES, meta } from './db.js';

export const TTL = {
  catalog: 15 * 60,          // market values move, but not minute to minute
  logTypes: 7 * 24 * 3600,   // practically static
  inventory: 60 * 60,        // Torn caches inventory for an hour per category anyway
};

// Re-read a little before the last sync point so logs written late aren't missed; ids de-duplicate.
const OVERLAP = 5 * 60;
const INCREMENTAL_MAX_PAGES = 50;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Return a cached value if younger than ttl seconds, otherwise fetch and cache it. */
async function cached(db, key, ttl, fetcher, { force = false, now = nowSec() } = {}) {
  const hit = await meta.get(db, key);
  if (!force && hit && now - hit.at < ttl) return { value: hit.value, at: hit.at, fromCache: true };
  const value = await fetcher();
  await meta.set(db, key, { at: now, value });
  return { value, at: now, fromCache: false };
}

/** SHA-256 of the key, so we can remember which player a key belongs to without storing the key. */
export async function keyFingerprint(key) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The player a key belongs to; looked up once per key, then remembered. */
export async function identify(db, client, fingerprint) {
  const known = await meta.get(db, `player:${fingerprint}`);
  if (known) return { ...known, fromCache: true };
  const me = await client.me();
  await meta.set(db, `player:${fingerprint}`, me);
  return { ...me, fromCache: false };
}

export function loadCatalog(db, client, opts) {
  return cached(db, 'cache:catalog', TTL.catalog, () => client.items(), opts);
}

export function loadLogTypes(db, client, opts) {
  return cached(db, 'cache:logtypes', TTL.logTypes, () => client.logTypes(), opts);
}

export function loadGyms(db, client, opts) {
  return cached(db, 'cache:gyms', TTL.logTypes, () => client.gyms(), opts);
}

export function loadInventory(db, client, player, { force, onCategory, now } = {}) {
  return cached(db, `cache:inventory:${player}`, TTL.inventory,
    () => client.inventory({ bypassCache: force, onCategory }), { force, now });
}

/**
 * Inventory for a few categories. Reuses the full saved inventory (filtered by `keep`) while it's
 * fresh; otherwise fetches just those categories and saves them under their own key.
 */
export async function loadInventoryCategories(db, client, player, categories, { keep, onCategory, now = nowSec() } = {}) {
  const full = await meta.get(db, `cache:inventory:${player}`);
  if (full && now - full.at < TTL.inventory) {
    return { value: { ...full.value, items: full.value.items.filter(keep) }, at: full.at, fromCache: true };
  }
  return cached(db, `cache:inventory:${player}:${categories.join(',')}`, TTL.inventory,
    () => client.inventory({ categories, onCategory }), { now });
}

// v2: the first release asked for every log type in one request, got nothing back from Torn and
// recorded that as a complete (empty) history. A new key version makes those types rescan.
const syncKey = (player, typeId) => `logsync:v2:${player}:${typeId}`;

async function syncStates(db, player, ids) {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await meta.get(db, syncKey(player, id))])));
}

/**
 * Bring the saved log history up to date for the given log type ids and return every saved
 * log of those types for this player.
 *  - Types seen before: one combined incremental fetch of anything newer than the last sync.
 *  - New types: a backfill of up to `maxPages` pages (100 logs each), newest first.
 * With `since` (unix seconds), only logs from then on are needed: new types are read back to
 * `since` rather than as far as possible, types saved from a later point have the gap filled,
 * and only logs from `since` on are returned.
 */
export async function syncLogs(db, client, player, typeIds, { maxPages = 20, since, onProgress, now = nowSec() } = {}) {
  const ids = [...new Set(typeIds)];
  const states = await syncStates(db, player, ids);
  const known = ids.filter((id) => states[id]);
  const fresh = ids.filter((id) => !states[id]);
  let added = 0;

  if (known.length) {
    const from = Math.min(...known.map((id) => states[id].newest)) - OVERLAP;
    const logs = await client.logs(known, {
      from, maxPages: INCREMENTAL_MAX_PAGES,
      onPage: (n) => onProgress?.(`Checking for new logs… ${n}`),
    });
    added += await saveNew(db, player, logs);
    for (const id of known) states[id] = { ...states[id], newest: now };
  }

  // Saved only from after `since` (e.g. the week start moved earlier): read the missing stretch.
  const gap = since == null ? [] : known.filter((id) => !states[id].complete && states[id].oldest > since);
  if (gap.length) {
    const logs = await client.logs(gap, {
      from: since, to: Math.max(...gap.map((id) => states[id].oldest)), maxPages: INCREMENTAL_MAX_PAGES,
      onPage: (n) => onProgress?.(`Reading earlier logs… ${n}`),
    });
    added += await saveNew(db, player, logs);
    for (const id of gap) states[id] = { ...states[id], oldest: since };
  }

  if (fresh.length) {
    const logs = await client.logs(fresh, {
      from: since, maxPages,
      onPage: (n, p) => onProgress?.(`Reading log history… ${n} found (request ${p})`),
    });
    added += await saveNew(db, player, logs);
    const capped = logs.length >= maxPages * 100;
    const oldest = since != null && !capped ? since : logs.length ? Math.min(...logs.map((l) => l.timestamp)) : now;
    const complete = since == null && !capped;
    for (const id of fresh) states[id] = { newest: now, oldest, complete };
  }

  await db.putMany(STORES.meta, ids.map((id) => ({ key: syncKey(player, id), value: states[id] })));
  const saved = await savedLogs(db, player, ids);
  return { logs: since == null ? saved : saved.filter((l) => l.timestamp >= since), added };
}

/** Fetch further back in time for types whose history isn't complete yet. */
export async function backfillOlder(db, client, player, typeIds, { maxPages = 20, onProgress } = {}) {
  const ids = [...new Set(typeIds)];
  const states = await syncStates(db, player, ids);
  const todo = ids.filter((id) => states[id] && !states[id].complete);
  if (!todo.length) return { added: 0, complete: true, logs: await savedLogs(db, player, ids) };

  const to = Math.min(...todo.map((id) => states[id].oldest));
  const logs = await client.logs(todo, {
    to, maxPages,
    onPage: (n, p) => onProgress?.(`Reading older logs… ${n} found (request ${p})`),
  });
  const added = await saveNew(db, player, logs);
  const oldest = logs.length ? Math.min(...logs.map((l) => l.timestamp)) : to;
  const complete = logs.length < maxPages * 100;
  await db.putMany(STORES.meta, todo.map((id) => ({
    key: syncKey(player, id), value: { ...states[id], oldest: Math.min(oldest, states[id].oldest), complete },
  })));
  return { added, complete, logs: await savedLogs(db, player, ids) };
}

async function saveNew(db, player, logs) {
  if (!logs.length) return 0;
  const existing = new Set((await db.getAll(STORES.logs)).map((l) => l.id));
  const fresh = logs.filter((l) => !existing.has(l.id))
    .map((l) => ({ id: l.id, player, timestamp: l.timestamp, details: l.details, data: l.data }));
  await db.putMany(STORES.logs, fresh);
  return fresh.length;
}

export async function savedLogs(db, player, typeIds) {
  const wanted = new Set(typeIds);
  return (await db.getAll(STORES.logs))
    .filter((l) => l.player === player && wanted.has(l.details?.id))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/** Oldest log date saved for the given types, and whether every type's history is complete. */
export async function historyCoverage(db, player, typeIds) {
  const states = Object.values(await syncStates(db, player, typeIds));
  const present = states.filter(Boolean);
  return {
    oldest: present.length ? Math.min(...present.map((s) => s.oldest)) : null,
    complete: present.length > 0 && present.length === typeIds.length && present.every((s) => s.complete),
  };
}

// ---------- snapshots ----------

export async function savedSnapshots(db, player) {
  return (await db.getAll(STORES.snapshots)).filter((s) => s.player === player);
}

export async function saveSnapshotFor(db, player, snap) {
  const row = { ...snap, player, key: `${player}:${snap.date}` };
  await db.putMany(STORES.snapshots, [row]);
  return row;
}
