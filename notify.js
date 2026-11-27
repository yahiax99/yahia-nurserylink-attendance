'use strict';
// S3 Notify Lambda: the second subscriber of S3's SNS absence topic.
// For each AbsenceReported event it saves a teacher notification, so the class
// teacher sees the new absence straight away. Runs with its own IAM role and its
// own database role (attendance_notify), which can only add notifications.
const db = require('./src/lib/db');
const logger = require('./src/lib/logger');

function parse(record) {
  const raw = record.Sns ? record.Sns.Message : record.body;
  const event = JSON.parse(raw);
  const a = event && event.absence;
  if (!event || event.version !== 1 || !a || typeof a.id !== 'string' || typeof a.childId !== 'string' || typeof a.classId !== 'string') {
    throw new Error('message does not match the absence event contract');
  }
  return event;
}

exports.handler = async (event) => {
  for (const record of event.Records || []) {
    let msg;
    try { msg = parse(record); } catch (e) {
      logger.warn('NOTIFY_BAD_MESSAGE', { reason: e.message });
      continue;
    }
    if (msg.type !== 'AbsenceReported') continue;
    const a = msg.absence;
    const child = await db.one('SELECT name FROM children WHERE id = $1 AND class_id = $2', [a.childId, a.classId]);
    if (!child) { logger.warn('NOTIFY_UNKNOWN_CHILD', { absenceId: a.id }); continue; }
    const period = a.startDate === a.endDate ? `on ${a.startDate}` : `from ${a.startDate} to ${a.endDate}`;
    await db.query(
      `INSERT INTO teacher_notifications (class_id, child_id, absence_id, message) VALUES ($1,$2,$3,$4)
       ON CONFLICT (absence_id) DO NOTHING`,
      [a.classId, a.childId, a.id, `${child.name} is reported absent ${period}.`],
    );
    logger.info('TEACHER_NOTIFIED', { absenceId: a.id, eventId: msg.eventId });
  }
  return { ok: true };
};
