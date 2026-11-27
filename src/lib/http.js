'use strict';
// Calls between services. A call always goes to the CALLED service's internal
// Application Load Balancer, never through the public API Gateway. It carries:
//   * the original user's token (the called service checks it again), or the
//     internal key when there is no user (scheduled jobs, SQS forwarder)
//   * the same request id, so one request can be followed across services
//   * a 3 second time limit; on failure the caller uses its fallback and logs
//     DEPENDENCY_FAILED (counted by a CloudWatch metric filter and alarm).
const logger = require('./logger');

class DependencyError extends Error {
  constructor(target, reason, status) { super(`${target}: ${reason}`); this.target = target; this.status = status; }
}

async function call(baseUrl, path, { method = 'GET', token, internalKey, requestId, body, timeoutMs = 3000, target } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (internalKey) headers['x-internal-key'] = internalKey;
  if (requestId) headers['x-request-id'] = requestId;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new DependencyError(target || baseUrl, e.name === 'TimeoutError' ? 'timed out after 3 s' : e.message);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  if (res.status >= 500) throw new DependencyError(target || baseUrl, `returned ${res.status}`, res.status);
  return { status: res.status, body: json };
}

// Logs the failure in the agreed way (log line + EventBridge + security_events).
async function reportFailure(req, err, fallbackUsed) {
  await logger.security('DEPENDENCY_FAILED', req, { target: err.target, reason: err.message, fallback: fallbackUsed });
}

module.exports = { call, reportFailure, DependencyError };
