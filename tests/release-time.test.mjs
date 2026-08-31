import test from 'node:test';
import assert from 'node:assert/strict';
import { countdownParts, formatReleaseDate } from '../public/release-time.js';

test('countdown uses accumulated hours and rounds a remaining fraction upward', () => {
  const target = Date.parse('2026-08-31T15:00:00.000Z');
  assert.deepEqual(countdownParts(target, target - (76 * 3600 + 2 * 60 + 3) * 1000),
    { remaining: 273723, hours: 76, minutes: 2, seconds: 3 });
  assert.deepEqual(countdownParts(target, target - 1), { remaining: 1, hours: 0, minutes: 0, seconds: 1 });
});

test('elapsed or invalid targets never create a negative countdown', () => {
  const zero = { remaining: 0, hours: 0, minutes: 0, seconds: 0 };
  assert.deepEqual(countdownParts(1000, 1000), zero);
  assert.deepEqual(countdownParts(1000, 2000), zero);
  assert.deepEqual(countdownParts('invalid', 2000), zero);
});

test('the same first release appears on the correct calendar day in Washington and Seoul', () => {
  const target = '2026-09-01T00:00:00+09:00';
  assert.equal(formatReleaseDate(target, 'en'), 'Aug 31, 2026 / 11:00 AM EDT');
  assert.equal(formatReleaseDate(target, 'ko'), '2026.09.01 / 00:00 KST');
});

test('Washington winter release time uses standard time without shifting the target', () => {
  const target = '2027-01-01T00:00:00+09:00';
  assert.equal(formatReleaseDate(target, 'en'), 'Dec 31, 2026 / 10:00 AM EST');
  assert.equal(formatReleaseDate(target, 'ko'), '2027.01.01 / 00:00 KST');
});

test('Washington spring and autumn transitions follow America/New_York rules', () => {
  assert.equal(formatReleaseDate('2026-03-08T06:59:00Z', 'en'), 'Mar 8, 2026 / 1:59 AM EST');
  assert.equal(formatReleaseDate('2026-03-08T07:00:00Z', 'en'), 'Mar 8, 2026 / 3:00 AM EDT');
  assert.equal(formatReleaseDate('2026-11-01T05:59:00Z', 'en'), 'Nov 1, 2026 / 1:59 AM EDT');
  assert.equal(formatReleaseDate('2026-11-01T06:00:00Z', 'en'), 'Nov 1, 2026 / 1:00 AM EST');
});

test('invalid release display input does not throw or show an invented date', () => {
  assert.equal(formatReleaseDate('invalid', 'en'), '');
  assert.equal(formatReleaseDate('invalid', 'ko'), '');
});
