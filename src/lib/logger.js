'use strict';
// Logging and monitoring (Application layer -> Monitoring and Audit).
//  * Every request, error, security event and audit event is written as one JSON
//    line to stdout. Lambda sends it to this function's Amazon CloudWatch log group
//    automatically. CloudWatch metric filters count fields such as "status" and
//    "event" (LOGIN_FAILED, DEPENDENCY_FAILED, 401/403/429...) and drive the alarms.
//  * Audit events (who did what to which record) are the same JSON lines marked
//    "audit": true, so they can be filtered in CloudWatch. AWS CloudTrail records the
//    AWS actions the app causes on its own (report downloads, secret changes).
//  * Security events are also saved in the security_events table in Neon.
// Passwords, tokens, notes and secrets are never logged.

const SERVICE = process.env.SERVICE_NAME || 'unknown';
const BLOCKED = /pass(word)?|token|secret|authorization|note|cookie|key/i;

function clean(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (BLOCKED.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function write(level, event, fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: SERVICE, event, ...clean(fields) }));
}

const info = (event, fields) => write('info', event, fields);
const warn = (event, fields) => write('warn', event, fields);
const error = (event, fields) => write('error', event, fields);

// Security event: CloudWatch log line + row in security_events (Neon).
async function security(event, req, extra = {}) {
  const fields = {
    security: true,
    requestId: req && req.requestId,
    userId: req && req.user ? req.user.id : extra.userId,
    ip: req && req.clientIp,
    path: req && req.originalUrl ? req.originalUrl.split('?')[0] : undefined,
    ...extra,
  };
  write('warn', event, fields);
  try {
    const db = require('./db');
    await db.query(
      'INSERT INTO security_events (service, event_type, user_id, ip, request_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [SERVICE, event, fields.userId || null, fields.ip || null, fields.requestId || null, JSON.stringify(clean(extra))],
    );
  } catch (e) {
    write('warn', 'SECURITY_EVENT_SAVE_FAILED', { reason: e.message });
  }
}

// Audit event (who did what to which record): CloudWatch log line marked audit.
async function audit(event, req, extra = {}) {
  write('info', event, { audit: true, requestId: req && req.requestId, userId: req && req.user ? req.user.id : undefined, ...extra });
}

module.exports = { info, warn, error, security, audit, SERVICE };
