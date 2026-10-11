// Small promise wrapper around IndexedDB for data that outgrows localStorage:
// the log history, cached API responses and daily snapshots. Everything stays in this browser.
// Falls back to an in-memory store (nothing persists) if IndexedDB is unavailable, e.g. some private windows.

const DB_NAME = 'torn-inventory-profit';
const VERSION = 1;
export const STORES = {
  logs: 'logs',           // raw logs, keyed by log id: { id, player, timestamp, details, data }
  meta: 'meta',           // { key, value }: per-log-type sync state and cached API responses
  snapshots: 'snapshots', // keyed by '<playerId>:<UTC date YYYY-MM-DD>'
};

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function memoryDb() {
  const data = Object.fromEntries(Object.values(STORES).map((s) => [s, new Map()]));
  const keyOf = (store, v) => (store === STORES.logs ? v.id : v.key);
  return {
    persistent: false,
    async get(store, key) { return data[store].get(key); },
    async getAll(store) { return [...data[store].values()]; },
    async putMany(store, values) { for (const v of values) data[store].set(keyOf(store, v), v); },
    async clear() { for (const m of Object.values(data)) m.clear(); },
  };
}

export async function openDb() {
  let idb;
  try {
    idb = await new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORES.logs)) db.createObjectStore(STORES.logs, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORES.snapshots)) db.createObjectStore(STORES.snapshots, { keyPath: 'key' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  } catch (err) {
    console.warn('IndexedDB unavailable, history will not be saved:', err);
    return memoryDb();
  }

  const tx = (store, mode) => idb.transaction(store, mode).objectStore(store);
  return {
    persistent: true,
    get: (store, key) => req(tx(store, 'readonly').get(key)),
    getAll: (store) => req(tx(store, 'readonly').getAll()),
    putMany(store, values) {
      if (!values.length) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = idb.transaction(store, 'readwrite');
        const os = t.objectStore(store);
        for (const v of values) os.put(v);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
    clear() {
      return new Promise((resolve, reject) => {
        const names = Object.values(STORES);
        const t = idb.transaction(names, 'readwrite');
        for (const n of names) t.objectStore(n).clear();
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    },
  };
}

/** Meta helpers: a key/value view over the meta store. */
export const meta = {
  async get(db, key) { return (await db.get(STORES.meta, key))?.value; },
  async set(db, key, value) { await db.putMany(STORES.meta, [{ key, value }]); },
};
