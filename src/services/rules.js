'use strict';
// S3 Attendance and Absences: business rules as pure functions (unit tested).
const dates = require('../lib/dates');

const REASONS = ['sick', 'family', 'travel', 'other'];
const MAX_NURSERY_DAYS = 10;
const MAX_RANGE_DAYS = 31;      // calendar days between start and end
const LATE_AFTER_MINUTES = 8 * 60; // a report for today made after 08:00 is Late
const SICK_STREAK = 3;           // 3 or more nursery days in a row with reason Sick

// Nursery days in a range = dates that are not closed (closedSet has 'YYYY-MM-DD').
function nurseryDays(start, end, closedSet) {
  return dates.eachDate(start, end).filter((d) => !closedSet.has(d));
}

// Fallback when S2 cannot answer: only Friday and Saturday are closed.
function fallbackClosed(start, end) {
  return new Set(dates.eachDate(start, end).filter(dates.isWeeklyOff));
}

function isLate(startDate, nowParts) {
  return startDate === nowParts.date && nowParts.hour * 60 + nowParts.minute > LATE_AFTER_MINUTES;
}

// Status workflow: Reported -> Acknowledged (teacher) or Cancelled (parent, before it starts).
// Returns null when allowed, or { status, code, message } when not.
function checkTransition({ from, to, role, startDate, today }) {
  if (to === 'Acknowledged' && role !== 'teacher') return { status: 403, code: 'FORBIDDEN_ROLE', message: 'Only the class teacher can acknowledge an absence.' };
  if (to === 'Cancelled' && role !== 'parent') return { status: 403, code: 'FORBIDDEN_ROLE', message: 'Only the parent can cancel an absence.' };
  if (from !== 'Reported') return { status: 409, code: 'INVALID_TRANSITION', message: `An absence that is ${from} cannot change to ${to}.` };
  if (to === 'Cancelled' && !(today < startDate)) return { status: 409, code: 'ABSENCE_STARTED', message: 'An absence can only be cancelled before it starts.' };
  return null;
}

// Expected attendance: enrolled children minus those with an active absence that day.
function expectedAttendance(enrolled, activeAbsences) {
  const absentIds = new Map(activeAbsences.map((a) => [a.childId, a]));
  return {
    enrolled: enrolled.length,
    expected: enrolled.filter((c) => !absentIds.has(c.childId)).map((c) => ({ childId: c.childId, name: c.name })),
    absent: enrolled.filter((c) => absentIds.has(c.childId)).map((c) => ({
      childId: c.childId, name: c.name, absenceId: absentIds.get(c.childId).id, status: absentIds.get(c.childId).status,
    })),
  };
}

// Monthly attendance rate = nursery days attended / nursery days open.
// Attended days are open days not covered by an active absence.
function monthlyRate(openDates, absentDateSet) {
  const absent = openDates.filter((d) => absentDateSet.has(d)).length;
  const attended = openDates.length - absent;
  return {
    openDays: openDates.length,
    absentDays: absent,
    attendedDays: attended,
    rate: openDates.length ? Math.round((attended / openDates.length) * 100) : 100,
  };
}

// Sick streaks: runs of 3 or more OPEN nursery days in a row that are all Sick.
// Closed days (weekends, holidays, closures) do not break the streak.
function sickStreaks(openDatesSorted, sickDateSet, minLength = SICK_STREAK) {
  const out = [];
  let run = [];
  for (const d of openDatesSorted) {
    if (sickDateSet.has(d)) run.push(d);
    else { if (run.length >= minLength) out.push({ fromDate: run[0], toDate: run[run.length - 1], sickDays: run.length }); run = []; }
  }
  if (run.length >= minLength) out.push({ fromDate: run[0], toDate: run[run.length - 1], sickDays: run.length });
  return out;
}

// CSV cell: quotes, and blocks spreadsheet formula injection.
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows) { return rows.map((r) => r.map(csvCell).join(',')).join('\r\n'); }

module.exports = {
  REASONS, MAX_NURSERY_DAYS, MAX_RANGE_DAYS, SICK_STREAK,
  nurseryDays, fallbackClosed, isLate, checkTransition, expectedAttendance, monthlyRate, sickStreaks, toCsv,
};
