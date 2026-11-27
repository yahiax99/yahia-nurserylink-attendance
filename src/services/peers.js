'use strict';
// S3's call to S2 (the closed days rule for the whole system), through S2's
// internal load balancer. With a user: the user's token. In scheduled jobs (no
// user): the internal key. 3 second limit; fallback = Friday and Saturday only.
const { call, reportFailure, DependencyError } = require('../lib/http');
const { env, internalKey } = require('../lib/config');
const rules = require('./rules');

async function closedBetween(req, classId, from, to) {
  try {
    const opts = { requestId: req && req.requestId, target: 'S2 closed days' };
    if (req && req.token) opts.token = req.token; else opts.internalKey = await internalKey();
    const r = await call(env('S2_URL'), `/api/classes/${classId}/calendar/closed?from=${from}&to=${to}`, opts);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.closed)) throw new DependencyError('S2 closed days', `returned ${r.status}`, r.status);
    return { closed: new Set(r.body.closed.map((c) => c.date)), details: r.body.closed, source: 'S2' };
  } catch (e) {
    await reportFailure(req, e, 'weekly days off only');
    return { closed: rules.fallbackClosed(from, to), details: null, source: 'fallback' };
  }
}

module.exports = { closedBetween };
