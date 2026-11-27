'use strict';
// Shared S3 queries: active absences, expected attendance, monthly rates.
// Expected attendance and monthly rates are cached in ElastiCache (cache aside)
// and cleared whenever an absence changes, so the answer is never out of date.
const db = require('../lib/db');
const cache = require('../lib/cache');
const dates = require('../lib/dates');
const rules = require('./rules');
const peers = require('./peers');

const ACTIVE = "status IN ('Reported','Acknowledged')";

async function expectedFor(req, classId, date) {
  return cache.remember(`expected:${classId}:${date}`, 60, async () => {
    const closed = await peers.closedBetween(req, classId, date, date);
    if (closed.closed.has(date)) {
      const d = closed.details && closed.details.find((c) => c.date === date);
      return { date, open: false, reason: d ? d.reason : 'weekly_day_off', closedDaysSource: closed.source };
    }
    const enrolled = await db.many('SELECT id AS "childId", name FROM children WHERE class_id = $1 ORDER BY name', [classId]);
    const active = await db.many(
      `SELECT id, child_id AS "childId", status FROM absences WHERE class_id = $1 AND ${ACTIVE} AND $2::date BETWEEN start_date AND end_date`,
      [classId, date],
    );
    return { date, open: true, ...rules.expectedAttendance(enrolled, active), closedDaysSource: closed.source };
  });
}

// Open days of a month (up to today for the current month).
async function openDaysOfMonth(req, classId, ym) {
  const { from, to: monthEnd } = dates.monthRange(ym);
  const today = dates.cairoToday();
  const to = monthEnd > today && from <= today ? today : monthEnd;
  if (from > today) return { open: [], source: 'S2' };
  const closed = await peers.closedBetween(req, classId, from, to);
  return { open: dates.eachDate(from, to).filter((d) => !closed.closed.has(d)), source: closed.source };
}

async function absentDatesFor(childIds, from, to) {
  const rows = await db.many(
    `SELECT child_id, start_date, end_date FROM absences WHERE child_id = ANY($1::uuid[]) AND ${ACTIVE}
      AND start_date <= $3 AND end_date >= $2`, [childIds, from, to],
  );
  const map = new Map(childIds.map((id) => [id, new Set()]));
  for (const r of rows) {
    for (const d of dates.eachDate(r.start_date > from ? r.start_date : from, r.end_date < to ? r.end_date : to)) map.get(r.child_id).add(d);
  }
  return map;
}

async function monthlyForClass(req, classId, ym) {
  return cache.remember(`monthly:class:${classId}:${ym}`, 300, async () => {
    const { open, source } = await openDaysOfMonth(req, classId, ym);
    const kids = await db.many('SELECT id, name FROM children WHERE class_id = $1 ORDER BY name', [classId]);
    const { from, to } = dates.monthRange(ym);
    const absent = await absentDatesFor(kids.map((k) => k.id), from, to);
    return {
      month: ym,
      closedDaysSource: source,
      items: kids.map((k) => ({ childId: k.id, name: k.name, ...rules.monthlyRate(open, absent.get(k.id) || new Set()) })),
    };
  });
}

async function monthlyForChild(req, childId, classId, ym) {
  return cache.remember(`monthly:child:${childId}:${ym}`, 300, async () => {
    const { open, source } = await openDaysOfMonth(req, classId, ym);
    const { from, to } = dates.monthRange(ym);
    const absent = await absentDatesFor([childId], from, to);
    return { month: ym, childId, closedDaysSource: source, ...rules.monthlyRate(open, absent.get(childId)) };
  });
}

// Clears every cached answer an absence change can affect.
async function invalidate(classId, childId, startDate, endDate) {
  const keys = dates.eachDate(startDate, endDate).map((d) => `expected:${classId}:${d}`);
  const months = new Set(dates.eachDate(startDate, endDate).map((d) => d.slice(0, 7)));
  for (const m of months) keys.push(`monthly:class:${classId}:${m}`, `monthly:child:${childId}:${m}`);
  await cache.del(...keys);
}

module.exports = { expectedFor, monthlyForClass, monthlyForChild, openDaysOfMonth, invalidate, ACTIVE };
