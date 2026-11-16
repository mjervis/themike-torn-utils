import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryText } from '../js/share.js';

test('summaryText joins lines and skips empty or skipped ones', () => {
  assert.equal(summaryText(['Trading', null, false, '', '  ', 0 && 'never', 0, 'Realised +$5']), 'Trading\nRealised +$5');
});
