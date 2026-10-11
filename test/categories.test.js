import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_TRADE_TYPES, ITEM_TYPES } from '../js/categories.js';

test('defaults put typical trade goods in trade and consumables in personal', () => {
  for (const t of ['Plushie', 'Flower', 'Drug', 'Artifact']) assert.equal(classify(t, 1).group, 'trade', t);
  for (const t of ['Booster', 'Candy', 'Energy Drink', 'Alcohol', 'Medical', 'Weapon', 'Armor']) {
    assert.equal(classify(t, 1).group, 'personal', t);
  }
  assert.equal(classify(undefined, 1).group, 'personal');
});

test('every default trade type is a real Torn item type', () => {
  for (const t of DEFAULT_TRADE_TYPES) assert.ok(ITEM_TYPES.includes(t), t);
});

test('custom type list and per-item overrides', () => {
  assert.equal(classify('Booster', 1, { tradeTypes: ['Booster'] }).group, 'trade');
  assert.equal(classify('Drug', 1, { tradeTypes: [] }).group, 'personal');
  const r = classify('Drug', 206, { itemOverrides: { 206: 'personal' } });
  assert.deepEqual(r, { group: 'personal', source: 'item' });
  assert.equal(classify('Booster', 5, { itemOverrides: { 5: 'trade' } }).group, 'trade');
  assert.equal(classify('Booster', 5, { itemOverrides: { 5: 'nonsense' } }).source, 'type');
});
