import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../js/api.js';

test('logs are requested in small batches with literal commas', { timeout: 20000 }, async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const ids = new URL(url).searchParams.get('log').split(',').map(Number);
    return new Response(JSON.stringify({ log: ids.map((id) => ({ id: `l${id}`, timestamp: id, details: { id } })) }));
  };
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  const logs = await createClient('k').logs(ids);
  assert.equal(urls.length, 3);
  assert.ok(urls[0].includes('log=1,2,3,4,5&'), urls[0]);
  assert.ok(!urls.some((u) => /%2C/i.test(u)));
  assert.equal(logs.length, 12);
  assert.equal(logs[0].timestamp, 12);
});

test('bazaar reads the v1 listing fields v2 falls back to', async () => {
  let asked;
  globalThis.fetch = async (url) => {
    asked = new URL(url);
    return new Response(JSON.stringify({ bazaar: [
      { ID: 206, UID: 1, name: 'Xanax', type: 'Drug', quantity: 3, price: 830000, market_price: 840000 },
      { ID: 180, name: 'Bottle of Beer', quantity: 0, price: 500 },
    ] }));
  };
  const listed = await createClient('k').bazaar();
  assert.equal(asked.pathname, '/v2/user');
  assert.equal(asked.searchParams.get('selections'), 'bazaar');
  assert.deepEqual(listed, [{ id: 206, name: 'Xanax', qty: 3, price: 830000 }]);
});
