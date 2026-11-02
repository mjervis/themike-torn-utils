import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocReport, newsletterHtml, newsletterText, shareOf } from '../js/oc.js';

const DAY = 86400;
const START = Date.UTC(2026, 9, 26) / 1000; // Mon 26 Oct 2026 00:00 TCT
const END = START + 7 * DAY;
const NOW = END + DAY;

const crime = (id, status, executed, players, rewards = {}) => ({
  id, name: `Crime ${id}`, difficulty: 5, status, executed_at: executed,
  slots: players.map((p) => ({ position: 'X', user: { id: p, joined_at: (executed ?? END) - 2 * DAY } })),
  rewards: status === 'Successful' ? { money: 0, items: [], respect: 0, ...rewards } : null,
});
const member = (id, name, days = 100) => ({ id, name, position: 'Member', level: 50, days_in_faction: days, last_action: { timestamp: NOW } });
const MEMBERS = [member(1, 'Alice'), member(2, 'Bob'), member(3, 'Cara'), member(4, 'Dan'), member(5, 'Eve', 3), member(6, 'Fay', 0)];

test('shareOf clamps to 0–100% and defaults to 90%', () => {
  assert.equal(shareOf(90), 0.9);
  assert.equal(shareOf(150), 1);
  assert.equal(shareOf(-5), 0);
  assert.equal(shareOf('nonsense'), 0.9);
});

test('ocReport splits cash by the players\' share, evenly between each OC\'s players', () => {
  const crimes = [
    crime(10, 'Successful', START + DAY, [1, 2], { money: 1_000_000, respect: 50 }),
    crime(11, 'Successful', START + 2 * DAY, [1, 3, 4], { money: 3_000_000 }),
    crime(12, 'Failure', START + 3 * DAY, [2, 3]),
    crime(13, 'Successful', START - 1, [4], { money: 9_000_000 }), // the week before
    crime(14, 'Successful', END, [4], { money: 9_000_000 }),       // the week after
  ];
  const r = ocReport(crimes, MEMBERS, { start: START, end: END, share: 90, now: NOW });
  assert.equal(r.totals.ocs, 3);
  assert.equal(r.totals.successful, 2);
  assert.equal(r.totals.failed, 1);
  assert.equal(r.totals.money, 4_000_000);
  assert.equal(r.totals.toPlayers, 3_600_000);
  assert.equal(r.totals.toFaction, 400_000);
  assert.equal(r.totals.respect, 50);
  assert.equal(r.totals.slots, 7);
  assert.equal(r.totals.participants, 4);
  assert.equal(r.totals.perPlayer, 7 / 4);

  const by = Object.fromEntries(r.players.map((p) => [p.name, p]));
  assert.equal(by.Alice.money, 450_000 + 900_000);
  assert.equal(by.Alice.ocs, 2);
  assert.equal(by.Bob.money, 450_000);
  assert.equal(by.Bob.ocs, 2);
  assert.equal(by.Bob.failed, 1);
  assert.equal(by.Dan.money, 900_000);
  assert.equal(r.players[0].name, 'Alice'); // highest earner first
});

test('ocReport lists members with no OC, noting open OCs and mid-week joiners', () => {
  const crimes = [
    crime(10, 'Successful', START + DAY, [1, 2], { money: 100 }),
    { ...crime(20, 'Planning', null, [3]), executed_at: null }, // joined in the week, still planning
    crime(21, 'Successful', END + DAY, [4], { money: 100 }),   // joined in the week, finished after it
  ];
  crimes[2].slots[0].user.joined_at = END - DAY;
  const r = ocReport(crimes, MEMBERS, { start: START, end: END, now: NOW });
  const by = Object.fromEntries(r.missing.map((m) => [m.name, m]));
  assert.deepEqual(r.missing.map((m) => m.name), ['Eve', 'Cara', 'Dan']); // nobody-in-an-OC first, Fay joined after the week
  assert.equal(by.Cara.pending.status, 'Planning');
  assert.equal(by.Dan.pending.executed, END + DAY);
  assert.equal(by.Eve.pending, null);
  assert.equal(by.Eve.joinedMidWeek, true);
});

test('ocReport counts players who have left the faction', () => {
  const crimes = [crime(10, 'Successful', START + DAY, [1, 99], { money: 1000 })];
  const r = ocReport(crimes, MEMBERS, { start: START, end: END, share: 50, now: NOW });
  const left = r.players.find((p) => p.id === 99);
  assert.equal(left.member, false);
  assert.equal(left.money, 250);
  assert.equal(r.totals.toFaction, 500);
});

test('ocReport adds item rewards at market value to the take, unless turned off', () => {
  const crimes = [
    crime(10, 'Successful', START + DAY, [1, 2], { money: 1000, items: [{ id: 7, quantity: 2 }, { id: 8, quantity: 1 }] }),
    crime(11, 'Successful', START + 2 * DAY, [1], { money: 0, items: [{ id: 7, quantity: 1 }] }),
  ];
  const prices = { 7: 500 }; // item 8 has no market value
  const opts = { start: START, end: END, share: 50, now: NOW, itemValue: (id) => prices[id] ?? null, itemName: (id) => `Item ${id}` };
  const r = ocReport(crimes, MEMBERS, opts);
  assert.equal(r.totals.cash, 1000);
  assert.equal(r.totals.itemsValue, 1500);
  assert.equal(r.totals.money, 2500);
  assert.equal(r.totals.toPlayers, 1250);
  assert.equal(r.totals.unpriced, 1);
  assert.equal(r.crimes[0].money, 2000);
  assert.equal(r.crimes[0].unpriced, 1);
  assert.equal(r.crimes[1].money, 500); // an items-only OC still pays out
  const by = Object.fromEntries(r.players.map((p) => [p.name, p]));
  assert.equal(by.Alice.money, 500 + 250);
  assert.equal(by.Bob.money, 500);
  assert.deepEqual(r.items.map((i) => [i.id, i.qty, i.value]), [[7, 3, 500], [8, 1, null]]);

  const cashOnly = ocReport(crimes, MEMBERS, { ...opts, items: false });
  assert.equal(cashOnly.totals.money, 1000);
  assert.equal(cashOnly.totals.itemsValue, 1500);
  assert.equal(cashOnly.players.find((p) => p.name === 'Alice').money, 250);
});

test('ocReport costs items used up or lost, and can pay the faction back for armoury items', () => {
  const slot = (user, req, outcome, owner = 'user') => ({
    position: 'X', item_requirement: req,
    user: { id: user, joined_at: START, item_outcome: outcome ? { owned_by: owner, item_id: req.id, item_uid: 1, outcome } : null },
  });
  const crimes = [
    { id: 30, name: 'Heist', difficulty: 7, status: 'Successful', executed_at: START + DAY, rewards: { money: 10_000, items: [], respect: 0 },
      slots: [
        slot(1, { id: 50, is_reusable: false }, 'used'),            // single-use, used up: costs 1,000
        slot(2, { id: 60, is_reusable: true }, 'used'),             // reusable, came back: kit worth 5,000
        slot(3, { id: 60, is_reusable: true }, 'lost', 'faction'),  // reusable from the armoury, lost: costs 5,000
      ] },
    { id: 31, name: 'Flop', difficulty: 2, status: 'Failure', executed_at: START + 2 * DAY, rewards: null,
      slots: [slot(1, { id: 50, is_reusable: false }, 'used'), slot(2, { id: 60, is_reusable: true }, null)] },
  ];
  const prices = { 50: 1000, 60: 5000 };
  const opts = { start: START, end: END, share: 50, now: NOW, itemValue: (id) => prices[id] ?? null, itemName: (id) => `Item ${id}` };

  const r = ocReport(crimes, MEMBERS, opts);
  assert.equal(r.totals.cost, 7000);
  assert.equal(r.totals.used, 2);
  assert.equal(r.totals.lost, 1);
  assert.equal(r.totals.net, 3000);
  assert.equal(r.totals.kit, 1);          // Bob's item 60, counted once across both OCs
  assert.equal(r.totals.kitValue, 5000);
  assert.equal(r.totals.toPlayers, 5000); // without refunds the split is unchanged
  assert.equal(r.crimes[0].cost, 6000);
  assert.equal(r.crimes[1].net, -1000);

  const refunded = ocReport(crimes, MEMBERS, { ...opts, refund: true });
  const by = Object.fromEntries(refunded.players.map((p) => [p.name, p]));
  // Heist: the faction's lost 5,000 item is paid back; Alice's 1,000 item isn't. 5,000 split 50/50 three ways.
  assert.equal(refunded.totals.refunded, 5000);
  assert.equal(by.Alice.supplied, 2000);
  assert.equal(by.Alice.money, 2500 / 3);
  assert.equal(by.Cara.money, 2500 / 3);
  assert.equal(refunded.crimes[0].toFaction, 2500 + 5000);
  assert.equal(refunded.totals.toPlayers + refunded.totals.toFaction, 10_000);

  const html = newsletterHtml(refunded, opts);
  assert.match(html, /Items used in the OCs: <b>\$7,000<\/b> \(2 used up, 1 lost/);
  assert.match(html, /\$5,000 of it paid back to the faction for armoury items/);
  assert.match(html, /Paid to players \(50%\): <b>\$2,500<\/b>/);
  assert.match(html, /Take after items: <b>\$3,000<\/b>/);
  assert.match(html, /Reusable items needed: \$5,000 \(1 item/);
});

test('newsletterHtml shows the cash and item split of the take', () => {
  const crimes = [crime(10, 'Successful', START + DAY, [1], { money: 1000, items: [{ id: 7, quantity: 2 }] })];
  const opts = { start: START, end: END, now: NOW, itemValue: () => 500, itemName: () => 'Thing' };
  assert.match(newsletterHtml(ocReport(crimes, MEMBERS, opts), opts), /\$2,000<\/b> \(\$1,000 cash \+ \$1,000 in items at market value\)/);
  assert.match(newsletterHtml(ocReport(crimes, MEMBERS, { ...opts, items: false }), opts), /not included above/);
});

test('newsletterHtml escapes names and can leave out the no-OC list', () => {
  const members = [member(1, '<b>Al</b>'), member(2, 'Bob')];
  const r = ocReport([crime(10, 'Successful', START + DAY, [1], { money: 1_000_000 })], members, { start: START, end: END, now: NOW });
  const html = newsletterHtml(r, { start: START, end: END });
  assert.match(html, /&lt;b&gt;Al&lt;\/b&gt;/);
  assert.match(html, /\$900,000/);
  assert.match(html, /No OC this week/);
  assert.match(html, /XID=2/);
  assert.match(html, /Mon,? 26 Oct 2026 – Sun,? 1 Nov 2026/);
  assert.doesNotMatch(newsletterHtml(r, { start: START, end: END, includeMissing: false }), /No OC this week/);
  const text = newsletterText(r, { start: START, end: END });
  assert.doesNotMatch(text, /<(a|p|td|h\d)\b/);
  assert.match(text, /<b>Al<\/b>\t1\t1\t\$900,000/);
  assert.match(text, /No OC this week\n+Bob/);
});
