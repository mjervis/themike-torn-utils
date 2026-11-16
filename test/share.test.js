import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryText } from '../js/share.js';

test('summaryText joins lines and skips empty or skipped ones', () => {
  assert.equal(summaryText(['Trading', null, false, '', '  ', 0 && 'never', 0, 'Realised +$5']), 'Trading\nRealised +$5');
});

test('chatMoney shortens millions and billions, and keeps smaller amounts in full', async () => {
  const { chatMoney, chatSigned } = await import('../js/share.js');
  assert.equal(chatMoney(39459300), '$39.46m');
  assert.equal(chatMoney(12000000), '$12m');
  assert.equal(chatMoney(2.5e9), '$2.5b');
  assert.equal(chatMoney(973161), '$973,161');
  assert.equal(chatMoney(-40000), '-$40,000');
  assert.equal(chatSigned(3787628), '+$3.79m');
  assert.equal(chatMoney(null), '—');
});
