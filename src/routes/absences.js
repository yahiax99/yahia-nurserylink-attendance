'use strict';
// S3 functions 1 and 2:
//  F1 Report an absence: own child only, starting today or later, no overlap with
//     another active absence, at most 10 nursery days (asks S2 for closed days and
//     counts only real nursery days). A report for today made after 08:00 is Late.
//  F2 Status workflow: Reported -> Acknowledged (teacher) or Cancelled (parent,
//     only before it starts). Any other change is rejected with 409.
const express = require('express');
const db = require('../lib/db');
const kms = require('../lib/kms');
const logger = require('../lib/logger');
const v = require('../lib/validate');
const dates = require('../lib/dates');
const { wrap } = require('../lib/web');
const { requireAuth, requireRole, assertChildAccess, parentChildIds } = require('../lib/auth');
const { AppError, badRequest, conflict, notFound, forbidden } = require('../lib/errors');
const rules = require('../services/rules');
const peers = require('../services/peers');
const events = require('../services/events');
const attendance = require('../services/attendance');

const router = express.Router();
const auth = requireAuth();
const COLS = `id, child_id, class_id, start_date, end_date, reason, note_ciphertext, nursery_days, late, status,
  closed_days_source, reported_by, reported_at, acknowledged_by, acknowledged_at, cancelled_at`;

async function toApi(r) {
  return {
    id: r.id, childId: r.child_id, classId: r.class_id, startDate: r.start_date, endDate: r.end_date,
    reason: r.reason, note: await kms.decrypt(r.note_ciphertext), nurseryDays: r.nursery_days, late: r.late,
    status: r.status, closedDaysSource: r.closed_days_source, reportedBy: r.reported_by, reportedAt: r.reported_at,
    acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at, cancelledAt: r.cancelled_at,
  };
}

async function loadVisible(req, id) {
  const r = await db.one(`SELECT ${COLS} FROM absences WHERE id = $1`, [id]);
  if (!r) throw notFound('Absence not found.');
  await assertChildAccess(req, r.child_id);
  return r;
}

// ---------- F1: report an absence ----------
router.post('/api/absences', auth, requireRole('parent'), v.body({
  childId: { type: 'uuid', required: true },
  startDate: { type: 'date', required: true },
  endDate: { type: 'date', required: true },
  reason: { type: 'enum', values: rules.REASONS, required: true },
  note: { type: 'string', max: 500 },
}), wrap(async (req, res) => {
  const { childId, startDate, endDate, reason, note } = req.body;
  if (endDate < startDate) throw badRequest('VALIDATION_FAILED', 'endDate must be on or after startDate.', [{ field: 'endDate', issue: 'must be on or after startDate' }]);
  if (dates.diffDays(startDate, endDate) > rules.MAX_RANGE_DAYS) throw badRequest('RANGE_TOO_LONG', 'An absence report can cover at most 31 calendar days.');
  const classId = await assertChildAccess(req, childId);
  const now = dates.cairoParts();
  if (startDate < now.date) throw badRequest('START_IN_PAST', 'An absence must start today or later.');

  const closed = await peers.closedBetween(req, classId, startDate, endDate);
  const days = rules.nurseryDays(startDate, endDate, closed.closed);
  if (days.length === 0) throw badRequest('NO_NURSERY_DAYS', 'The nursery is closed on all of these dates.');
  if (days.length > rules.MAX_NURSERY_DAYS) throw badRequest('TOO_MANY_NURSERY_DAYS', `An absence can cover at most ${rules.MAX_NURSERY_DAYS} nursery days.`);

  const overlap = await db.one(
    `SELECT 1 FROM absences WHERE child_id = $1 AND ${attendance.ACTIVE} AND start_date <= $3 AND end_date >= $2`, [childId, startDate, endDate],
  );
  if (overlap) throw conflict('ABSENCE_OVERLAP', 'This child already has an active absence on these dates.');

  const late = rules.isLate(startDate, now);
  const row = await db.one(
    `INSERT INTO absences (child_id, class_id, start_date, end_date, reason, note_ciphertext, nursery_days, late, status, closed_days_source, reported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Reported',$9,$10) RETURNING ${COLS}`,
    [childId, classId, startDate, endDate, reason, await kms.encrypt(note), days.length, late, closed.source, req.user.id],
  );
  const absence = await toApi(row);
  await attendance.invalidate(classId, childId, startDate, endDate);
  await events.publishAbsence(req, 'AbsenceReported', absence);
  await logger.audit('ABSENCE_REPORTED', req, { absenceId: absence.id, childId, nurseryDays: days.length, late });
  res.status(201).json({ absence });
}));

router.get('/api/absences', auth, v.query({
  childId: { type: 'uuid' },
  status: { type: 'enum', values: ['Reported', 'Acknowledged', 'Cancelled'] },
  from: { type: 'date' },
  to: { type: 'date' },
  page: { type: 'int', min: 1, max: 1000 },
  limit: { type: 'int', min: 1, max: 50 },
}), wrap(async (req, res) => {
  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 20);
  const params = [];
  const where = [];
  if (req.user.role === 'parent') {
    const mine = await parentChildIds(req.user.id);
    if (req.query.childId && !mine.includes(req.query.childId)) {
      await logger.security('AUTHZ_DENIED', req, { reason: 'child not linked to parent', childId: req.query.childId });
      throw forbidden('NOT_YOUR_CHILD', 'This is not your child.');
    }
    params.push(req.query.childId ? [req.query.childId] : mine);
    where.push(`a.child_id = ANY($${params.length}::uuid[])`);
  } else {
    params.push(req.user.classId);
    where.push(`a.class_id = $${params.length}`);
    if (req.query.childId) { params.push(req.query.childId); where.push(`a.child_id = $${params.length}`); }
  }
  if (req.query.status) { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); where.push(`a.end_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`a.start_date <= $${params.length}`); }
  const total = await db.one(`SELECT COUNT(*)::int AS n FROM absences a WHERE ${where.join(' AND ')}`, params);
  params.push(limit, (page - 1) * limit);
  const rows = await db.many(
    `SELECT a.${COLS.split(',').map((c) => c.trim()).join(', a.')}, c.name AS child_name FROM absences a JOIN children c ON c.id = a.child_id
      WHERE ${where.join(' AND ')} ORDER BY a.start_date DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params,
  );
  const items = await Promise.all(rows.map(async (r) => ({ ...(await toApi(r)), childName: r.child_name })));
  res.json({ items, page, limit, total: total.n });
}));

router.get('/api/absences/:id', auth, v.params({ id: { type: 'uuid', required: true } }), wrap(async (req, res) => {
  res.json({ absence: await toApi(await loadVisible(req, req.params.id)) });
}));

// ---------- F2: status workflow ----------
router.patch('/api/absences/:id/status', auth, v.params({ id: { type: 'uuid', required: true } }),
  v.body({ status: { type: 'enum', values: ['Acknowledged', 'Cancelled'], required: true } }),
  wrap(async (req, res) => {
    const row = await loadVisible(req, req.params.id);
    const to = req.body.status;
    const problem = rules.checkTransition({ from: row.status, to, role: req.user.role, startDate: row.start_date, today: dates.cairoToday() });
    if (problem) {
      if (problem.status === 403) await logger.security('AUTHZ_DENIED', req, { reason: problem.message, absenceId: row.id });
      throw new AppError(problem.status, problem.code, problem.message);
    }
    const updated = to === 'Acknowledged'
      ? await db.one(`UPDATE absences SET status='Acknowledged', acknowledged_by=$2, acknowledged_at=now() WHERE id=$1 AND status='Reported' RETURNING ${COLS}`, [row.id, req.user.id])
      : await db.one(`UPDATE absences SET status='Cancelled', cancelled_at=now() WHERE id=$1 AND status='Reported' RETURNING ${COLS}`, [row.id]);
    if (!updated) throw conflict('INVALID_TRANSITION', 'This absence changed in the meantime. Please refresh.');
    const absence = await toApi(updated);
    if (to === 'Cancelled') {
      await attendance.invalidate(row.class_id, row.child_id, row.start_date, row.end_date);
      await events.publishAbsence(req, 'AbsenceCancelled', absence);
    }
    await logger.audit(to === 'Acknowledged' ? 'ABSENCE_ACKNOWLEDGED' : 'ABSENCE_CANCELLED', req, { absenceId: row.id });
    res.json({ absence });
  }));

module.exports = router;
