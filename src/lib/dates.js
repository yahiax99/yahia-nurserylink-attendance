'use strict';
// Date helpers. Every business date in NurseryLink is an Egypt local date (Africa/Cairo).
// Pure functions only, so they can be unit tested without AWS or a database.

const TZ = 'Africa/Cairo';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Weekly days off agreed by the team: Friday (5) and Saturday (6).
const WEEKLY_OFF = [5, 6];

function cairoParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

function cairoToday(now = new Date()) { return cairoParts(now).date; }

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function isValidMonth(s) { return typeof s === 'string' && MONTH_RE.test(s); }
function isValidTime(s) { return typeof s === 'string' && TIME_RE.test(s); }
function isValidWeek(s) { return typeof s === 'string' && WEEK_RE.test(s); }

function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000); }
function eachDate(from, to) { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
function weekday(s) { return new Date(`${s}T00:00:00Z`).getUTCDay(); }
function isWeeklyOff(s) { return WEEKLY_OFF.includes(weekday(s)); }

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}
function previousMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}

// ISO week "2026-W49" -> Monday..Sunday.
function isoWeekRange(week) {
  const [y, w] = week.split('-W').map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - day + 1 + (w - 1) * 7);
  const from = monday.toISOString().slice(0, 10);
  return { from, to: addDays(from, 6) };
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

module.exports = {
  TZ, WEEKLY_OFF, cairoParts, cairoToday, isValidDate, isValidMonth, isValidTime, isValidWeek,
  addDays, diffDays, eachDate, weekday, isWeeklyOff, monthRange, previousMonth, isoWeekRange, timeToMinutes,
};
