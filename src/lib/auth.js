'use strict';
// Authentication and authorization used by every service.
//  * The token is an Amazon Cognito ACCESS token (RS256). It is checked here
//    against the user pool's public keys (JWKS), even though API Gateway's Lambda
//    authorizer already checked it, because calls between services arrive through
//    the internal load balancers, which have no authorizer.
//  * The user's role (parent or teacher) is read from the users table in Neon,
//    which is the single source of truth, never from the request.
//  * Ownership helpers make sure a parent only reaches their own children and a
//    teacher only reaches their own class. Breaking these rules returns 403.
const crypto = require('crypto');
const db = require('./db');
const cache = require('./cache');
const logger = require('./logger');
const { env, internalKey } = require('./config');
const { unauthenticated, forbidden, notFound } = require('./errors');

let jose;
let jwks;

async function verifyAccessToken(token) {
  jose = jose || (await import('jose'));
  const poolId = env('USER_POOL_ID');
  if (!jwks) jwks = jose.createRemoteJWKSet(new URL(`${env('AWS_ENDPOINT_URL')}/${poolId}/.well-known/jwks.json`));
  const { payload } = await jose.jwtVerify(token, jwks, { algorithms: ['RS256'] });
  if (payload.token_use !== 'access') throw new Error('not an access token');
  if (payload.client_id !== env('USER_POOL_CLIENT_ID')) throw new Error('wrong app client');
  if (!String(payload.iss || '').endsWith(`/${poolId}`)) throw new Error('wrong issuer');
  return payload;
}

async function loadUser(userId) {
  return cache.remember(`user:${userId}`, 60, async () => {
    const u = await db.one('SELECT id, name, role FROM users WHERE id = $1', [userId]);
    if (!u) return { missing: true };
    if (u.role === 'teacher') {
      const c = await db.one('SELECT id FROM classes WHERE teacher_id = $1 LIMIT 1', [userId]);
      u.classId = c ? c.id : null;
    }
    return u;
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Requires a valid user token. Sets req.user = { id, name, role, classId }.
function requireAuth() {
  return async (req, _res, next) => {
    try {
      const token = bearer(req);
      if (!token) throw unauthenticated();
      let payload;
      try { payload = await verifyAccessToken(token); } catch (e) {
        await logger.security('TOKEN_REJECTED', req, { reason: e.message });
        throw unauthenticated('Your session is invalid or has expired. Please log in again.');
      }
      const user = await loadUser(payload.sub);
      if (!user || user.missing) throw unauthenticated('Account not found.');
      req.user = user;
      req.token = token;
      next();
    } catch (e) { next(e); }
  };
}

// Allows either a user token or the internal key (machine calls with no user).
function requireAuthOrInternal() {
  const userAuth = requireAuth();
  return async (req, res, next) => {
    const key = req.headers['x-internal-key'];
    if (key) {
      try {
        const expected = await internalKey();
        const a = Buffer.from(String(key));
        const b = Buffer.from(String(expected || ''));
        if (a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b)) { req.internal = true; return next(); }
        await logger.security('INTERNAL_KEY_REJECTED', req, {});
        return next(unauthenticated());
      } catch (e) { return next(e); }
    }
    return userAuth(req, res, next);
  };
}

function requireInternal() {
  return async (req, _res, next) => {
    try {
      const key = String(req.headers['x-internal-key'] || '');
      const expected = String((await internalKey()) || '');
      const a = Buffer.from(key);
      const b = Buffer.from(expected);
      if (!(a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b))) {
        await logger.security('INTERNAL_KEY_REJECTED', req, {});
        throw unauthenticated();
      }
      req.internal = true;
      next();
    } catch (e) { next(e); }
  };
}

function requireRole(...roles) {
  return async (req, _res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    await logger.security('AUTHZ_DENIED', req, { reason: `role ${req.user ? req.user.role : 'none'} not allowed` });
    return next(forbidden('FORBIDDEN_ROLE', 'Your role is not allowed to do this.'));
  };
}

// ---- ownership helpers ----
async function parentChildIds(parentId) {
  const rows = await db.many('SELECT child_id FROM parent_child WHERE parent_id = $1', [parentId]);
  return rows.map((r) => r.child_id);
}
async function childClassId(childId) {
  const r = await db.one('SELECT class_id FROM children WHERE id = $1', [childId]);
  return r ? r.class_id : null;
}

// Throws 404 if the child does not exist, 403 if this user may not reach it.
async function assertChildAccess(req, childId) {
  const classId = await childClassId(childId);
  if (!classId) throw notFound('Child not found.');
  if (req.user.role === 'teacher') {
    if (req.user.classId !== classId) {
      await logger.security('AUTHZ_DENIED', req, { reason: 'child not in teacher class', childId });
      throw forbidden('NOT_YOUR_CLASS', 'This child is not in your class.');
    }
  } else {
    const mine = await parentChildIds(req.user.id);
    if (!mine.includes(childId)) {
      await logger.security('AUTHZ_DENIED', req, { reason: 'child not linked to parent', childId });
      throw forbidden('NOT_YOUR_CHILD', 'This is not your child.');
    }
  }
  return classId;
}

// Teacher of the class, or parent of a child in the class.
async function assertClassAccess(req, classId, { teacherOnly = false } = {}) {
  const exists = await db.one('SELECT id FROM classes WHERE id = $1', [classId]);
  if (!exists) throw notFound('Class not found.');
  if (req.user.role === 'teacher') {
    if (req.user.classId === classId) return;
    await logger.security('AUTHZ_DENIED', req, { reason: 'not teacher of class', classId });
    throw forbidden('NOT_YOUR_CLASS', 'This is not your class.');
  }
  if (teacherOnly) {
    await logger.security('AUTHZ_DENIED', req, { reason: 'teacher only', classId });
    throw forbidden('FORBIDDEN_ROLE', 'Only the class teacher can do this.');
  }
  const linked = await db.one(
    'SELECT 1 FROM parent_child pc JOIN children c ON c.id = pc.child_id WHERE pc.parent_id = $1 AND c.class_id = $2 LIMIT 1',
    [req.user.id, classId],
  );
  if (!linked) {
    await logger.security('AUTHZ_DENIED', req, { reason: 'parent not linked to class', classId });
    throw forbidden('NOT_YOUR_CHILD', 'None of your children is in this class.');
  }
}

module.exports = {
  verifyAccessToken, requireAuth, requireAuthOrInternal, requireInternal, requireRole,
  assertChildAccess, assertClassAccess, parentChildIds, childClassId, bearer,
};
