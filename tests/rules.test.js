'use strict';
// Unit tests for S3 business rules. Run with: npm test (no AWS or database needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/services/rules');

test('nursery days skip closed days (Thursday to Sunday counts 2)', () => {
  const closed = rules.fallbackClosed('2026-12-03', '2026-12-06'); // Fri 4, Sat 5
  assert.deepEqual(rules.nurseryDays('2026-12-03', '2026-12-06', closed), ['2026-12-03', '2026-12-06']);
});

test('public holiday from S2 is not counted', () => {
  const closed = new Set(['2026-12-04', '2026-12-05', '2026-12-07']);
  assert.equal(rules.nurseryDays('2026-12-06', '2026-12-08', closed).length, 2);
});

test('Late only for a report for today made after 08:00 Cairo time', () => {
  assert.equal(rules.isLate('2026-12-01', { date: '2026-12-01', hour: 8, minute: 1 }), true);
  assert.equal(rules.isLate('2026-12-01', { date: '2026-12-01', hour: 8, minute: 0 }), false);
  assert.equal(rules.isLate('2026-12-01', { date: '2026-12-01', hour: 7, minute: 59 }), false);
  assert.equal(rules.isLate('2026-12-02', { date: '2026-12-01', hour: 10, minute: 0 }), false);
});

test('status workflow: only the two allowed moves', () => {
  const base = { startDate: '2026-12-10', today: '2026-12-01' };
  assert.equal(rules.checkTransition({ ...base, from: 'Reported', to: 'Acknowledged', role: 'teacher' }), null);
  assert.equal(rules.checkTransition({ ...base, from: 'Reported', to: 'Cancelled', role: 'parent' }), null);
  assert.equal(rules.checkTransition({ ...base, from: 'Reported', to: 'Acknowledged', role: 'parent' }).status, 403);
  assert.equal(rules.checkTransition({ ...base, from: 'Reported', to: 'Cancelled', role: 'teacher' }).status, 403);
  assert.equal(rules.checkTransition({ ...base, from: 'Acknowledged', to: 'Acknowledged', role: 'teacher' }).code, 'INVALID_TRANSITION');
  assert.equal(rules.checkTransition({ ...base, from: 'Cancelled', to: 'Cancelled', role: 'parent' }).code, 'INVALID_TRANSITION');
  assert.equal(rules.checkTransition({ from: 'Reported', to: 'Cancelled', role: 'parent', startDate: '2026-12-01', today: '2026-12-01' }).code, 'ABSENCE_STARTED');
});

test('expected attendance = enrolled minus active absences', () => {
  const r = rules.expectedAttendance(
    [{ childId: 'a', name: 'A' }, { childId: 'b', name: 'B' }, { childId: 'c', name: 'C' }],
    [{ id: 'x', childId: 'b', status: 'Reported' }],
  );
  assert.equal(r.enrolled, 3);
  assert.deepEqual(r.expected.map((c) => c.childId), ['a', 'c']);
  assert.equal(r.absent[0].absenceId, 'x');
});

test('monthly rate = attended open days / open days', () => {
  const r = rules.monthlyRate(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-06'], new Set(['2026-12-02', '2026-12-04']));
  assert.deepEqual(r, { openDays: 4, absentDays: 1, attendedDays: 3, rate: 75 });
});

test('sick streak: 3 nursery days in a row, weekend does not break it', () => {
  const open = ['2026-12-02', '2026-12-03', '2026-12-06', '2026-12-07', '2026-12-08'];
  const sick = new Set(['2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06', '2026-12-07']);
  assert.deepEqual(rules.sickStreaks(open, sick), [{ fromDate: '2026-12-03', toDate: '2026-12-07', sickDays: 3 }]);
  assert.deepEqual(rules.sickStreaks(open, new Set(['2026-12-02', '2026-12-03'])), []);
});

test('CSV escapes quotes and blocks formulas', () => {
  assert.equal(rules.toCsv([['=SUM(A1)', 'a,b', 'say "hi"']]), "'=SUM(A1),\"a,b\",\"say \"\"hi\"\"\"");
});
