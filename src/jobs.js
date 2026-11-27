'use strict';
// Jobs started by Amazon EventBridge Scheduler (Africa/Cairo time, no user):
//  * sick-check (every night): flags children with 3 or more nursery days in a row
//    with reason Sick, so the flag appears even if nobody opens the page.
//  * monthly-report (1st of each month): saves each class's attendance report for
//    the previous month as a CSV in the private Amazon S3 reports bucket (SSE-KMS).
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const db = require('./lib/db');
const logger = require('./lib/logger');
const dates = require('./lib/dates');
const { awsOptions, env } = require('./lib/config');
const rules = require('./services/rules');
const peers = require('./services/peers');
const attendance = require('./services/attendance');

async function sickCheck() {
  const today = dates.cairoToday();
  const to = dates.addDays(today, -1);
  const from = dates.addDays(to, -30);
  const classes = await db.many('SELECT id FROM classes');
  let flagged = 0;
  for (const cls of classes) {
    const closed = await peers.closedBetween(null, cls.id, from, to);
    const openDates = dates.eachDate(from, to).filter((d) => !closed.closed.has(d));
    const rows = await db.many(
      `SELECT child_id, start_date, end_date FROM absences
        WHERE class_id = $1 AND reason = 'sick' AND ${attendance.ACTIVE} AND start_date <= $3 AND end_date >= $2`, [cls.id, from, to],
    );
    const byChild = new Map();
    for (const r of rows) {
      const set = byChild.get(r.child_id) || new Set();
      for (const d of dates.eachDate(r.start_date > from ? r.start_date : from, r.end_date < to ? r.end_date : to)) set.add(d);
      byChild.set(r.child_id, set);
    }
    for (const [childId, sickSet] of byChild) {
      for (const s of rules.sickStreaks(openDates, sickSet)) {
        const r = await db.query(
          `INSERT INTO follow_ups (child_id, class_id, from_date, sick_days, status) VALUES ($1,$2,$3,$4,'Open')
           ON CONFLICT (child_id, from_date) DO UPDATE SET sick_days = GREATEST(follow_ups.sick_days, EXCLUDED.sick_days)
           RETURNING (xmax = 0) AS inserted`, [childId, cls.id, s.fromDate, s.sickDays],
        );
        if (r.rows[0] && r.rows[0].inserted) flagged += 1;
      }
    }
  }
  logger.info('SICK_CHECK_DONE', { flagged });
  return { ok: true, flagged };
}

async function monthlyReport() {
  const ym = dates.previousMonth(dates.cairoToday().slice(0, 7));
  const s3 = new S3Client({ ...awsOptions(), forcePathStyle: true });
  const classes = await db.many('SELECT id, name FROM classes ORDER BY name');
  for (const cls of classes) {
    const report = await attendance.monthlyForClass(null, cls.id, ym);
    const csv = rules.toCsv([
      ['Class', 'Month', 'Child', 'Open days', 'Attended days', 'Absent days', 'Attendance rate %'],
      ...report.items.map((i) => [cls.name, ym, i.name, i.openDays, i.attendedDays, i.absentDays, i.rate]),
    ]);
    await s3.send(new PutObjectCommand({
      Bucket: env('REPORTS_BUCKET'),
      Key: `reports/${cls.id}/${ym}.csv`,
      Body: csv,
      ContentType: 'text/csv',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: env('KMS_KEY_ID'),
    }));
    await logger.audit('MONTHLY_REPORT_SAVED', null, { classId: cls.id, month: ym, children: report.items.length });
  }
  return { ok: true, month: ym, classes: classes.length };
}

async function run(event) {
  logger.info('JOB_STARTED', { job: event.job });
  if (event.job === 'sick-check') return sickCheck();
  if (event.job === 'monthly-report') return monthlyReport();
  logger.warn('JOB_UNKNOWN', { job: event.job });
  return { ok: false };
}

module.exports = { run, sickCheck, monthlyReport };
