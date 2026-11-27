'use strict';
// Sick follow up flags (teacher only). Children with 3 or more nursery days in a
// row with reason Sick are flagged by the nightly scheduled job; the teacher calls
// the parent and presses "Followed up".
const express = require('express');
const db = require('../lib/db');
const logger = require('../lib/logger');
const v = require('../lib/validate');
const { wrap } = require('../lib/web');
const { requireAuth, requireRole, assertClassAccess } = require('../lib/auth');
const { conflict, notFound, forbidden } = require('../lib/errors');

const router = express.Router();
const teacherOnly = [requireAuth(), requireRole('teacher')];

router.get('/api/classes/:classId/followups', ...teacherOnly,
  v.params({ classId: { type: 'uuid', required: true } }), v.query({ status: { type: 'enum', values: ['open', 'done'] } }),
  wrap(async (req, res) => {
    await assertClassAccess(req, req.params.classId, { teacherOnly: true });
    const status = req.query.status === 'done' ? 'Done' : 'Open';
    const items = await db.many(
      `SELECT f.id, f.child_id AS "childId", c.name, f.from_date AS "fromDate", f.sick_days AS "sickDays", f.status,
              f.created_at AS "createdAt", f.done_at AS "doneAt"
         FROM follow_ups f JOIN children c ON c.id = f.child_id WHERE f.class_id = $1 AND f.status = $2 ORDER BY f.from_date DESC`,
      [req.params.classId, status],
    );
    res.json({ items });
  }));

router.post('/api/followups/:id/done', ...teacherOnly, v.params({ id: { type: 'uuid', required: true } }), wrap(async (req, res) => {
  const f = await db.one('SELECT id, class_id, status FROM follow_ups WHERE id = $1', [req.params.id]);
  if (!f) throw notFound('Follow up not found.');
  if (f.class_id !== req.user.classId) {
    await logger.security('AUTHZ_DENIED', req, { reason: 'follow up of another class', followUpId: f.id });
    throw forbidden('NOT_YOUR_CLASS', 'This follow up belongs to another class.');
  }
  if (f.status === 'Done') throw conflict('ALREADY_DONE', 'This follow up is already done.');
  const r = await db.one(
    `UPDATE follow_ups SET status='Done', done_by=$2, done_at=now() WHERE id=$1 AND status='Open'
     RETURNING id, status, done_at AS "doneAt"`, [f.id, req.user.id],
  );
  if (!r) throw conflict('ALREADY_DONE', 'This follow up is already done.');
  await logger.audit('FOLLOW_UP_DONE', req, { followUpId: f.id });
  res.json({ followUp: r });
}));

module.exports = router;
