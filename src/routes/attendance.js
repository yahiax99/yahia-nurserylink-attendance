'use strict';
// S3 function 3 and the monthly rate:
//  F3 Expected attendance: for a class and date, the enrolled children minus the
//     absent ones. S1 uses it for its checklist; the teacher dashboard shows it.
//  Absence check: is this child absent on this date? (S1 asks before saving an update)
//  Monthly attendance rate per child (nursery days attended / nursery days open).
const express = require('express');
const db = require('../lib/db');
const v = require('../lib/validate');
const dates = require('../lib/dates');
const { wrap } = require('../lib/web');
const { requireAuth, requireRole, assertChildAccess, assertClassAccess } = require('../lib/auth');
const attendance = require('../services/attendance');

const router = express.Router();
const auth = requireAuth();

router.get('/api/classes/:classId/attendance', auth, requireRole('teacher'),
  v.params({ classId: { type: 'uuid', required: true } }), v.query({ date: { type: 'date' } }),
  wrap(async (req, res) => {
    await assertClassAccess(req, req.params.classId, { teacherOnly: true });
    res.json(await attendance.expectedFor(req, req.params.classId, req.query.date || dates.cairoToday()));
  }));

router.get('/api/children/:childId/absence', auth,
  v.params({ childId: { type: 'uuid', required: true } }), v.query({ date: { type: 'date', required: true } }),
  wrap(async (req, res) => {
    await assertChildAccess(req, req.params.childId);
    const a = await db.one(
      `SELECT id, status FROM absences WHERE child_id = $1 AND ${attendance.ACTIVE} AND $2::date BETWEEN start_date AND end_date LIMIT 1`,
      [req.params.childId, req.query.date],
    );
    res.json(a ? { absent: true, absenceId: a.id, status: a.status } : { absent: false });
  }));

router.get('/api/children/:childId/attendance/monthly', auth,
  v.params({ childId: { type: 'uuid', required: true } }), v.query({ month: { type: 'month' } }),
  wrap(async (req, res) => {
    const classId = await assertChildAccess(req, req.params.childId);
    res.json(await attendance.monthlyForChild(req, req.params.childId, classId, req.query.month || dates.cairoToday().slice(0, 7)));
  }));

router.get('/api/classes/:classId/attendance/monthly', auth, requireRole('teacher'),
  v.params({ classId: { type: 'uuid', required: true } }), v.query({ month: { type: 'month' } }),
  wrap(async (req, res) => {
    await assertClassAccess(req, req.params.classId, { teacherOnly: true });
    res.json(await attendance.monthlyForClass(req, req.params.classId, req.query.month || dates.cairoToday().slice(0, 7)));
  }));

module.exports = router;
