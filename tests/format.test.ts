import test from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../src/format.ts';

test('timestamps keep local Chinese month/day and 24-hour labels across repeated calls', () => {
  assert.equal(time(new Date(2026, 9, 8, 14, 5).getTime()), '10/08 14:05');
  assert.equal(time(new Date(2026, 0, 2, 3, 4).getTime()), '01/02 03:04');
  for (const value of [undefined, null, 0, NaN, Infinity, Number.MAX_VALUE]) assert.equal(time(value), '—');
});
