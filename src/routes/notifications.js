'use strict';
// Teacher notifications, created by the Notify Lambda for each new absence
// (SNS absence topic -> Notify Lambda). The teacher lists them and marks them read.
const express = require('express');
const db = require('../lib/db');
const v = require('../lib/validate');
const { wrap } = require('../lib/web');
const { requireAuth, requireRole, assertClassAccess } = require('../lib/auth');
const { notFound, forbidden } = require('../lib/errors');
const logger = require('../lib/logger');

const router = express.Router();
const teacherOnly = [requireAuth(), requireRole('teacher')];

router.get('/api/classes/:classId/notifications', ...teacherOnly,
  v.params({ classId: { type: 'uuid', required: true } }), v.query({ unread: { type: 'enum', values: ['true', 'false'] } }),
  wrap(async (req, res) => {
    await assertClassAccess(req, req.params.classId, { teacherOnly: true });
    const onlyUnread = req.query.unread === 'true';
    const items = await db.many(
      `SELECT id, child_id AS "childId", absence_id AS "absenceId", message, created_at AS "createdAt", read_at AS "readAt"
         FROM teacher_notifications WHERE class_id = $1 ${onlyUnread ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 50`,
      [req.params.classId],
    );
    res.json({ items });
  }));

router.patch('/api/notifications/:id/read', ...teacherOnly, v.params({ id: { type: 'uuid', required: true } }), wrap(async (req, res) => {
  const n = await db.one('SELECT id, class_id FROM teacher_notifications WHERE id = $1', [req.params.id]);
  if (!n) throw notFound('Notification not found.');
  if (n.class_id !== req.user.classId) {
    await logger.security('AUTHZ_DENIED', req, { reason: 'notification of another class', notificationId: n.id });
    throw forbidden('NOT_YOUR_CLASS', 'This notification belongs to another class.');
  }
  const r = await db.one('UPDATE teacher_notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 RETURNING id, read_at AS "readAt"', [n.id]);
  res.json({ notification: r });
}));

module.exports = router;
