'use strict';
// Express building blocks shared by every service: request id, client address,
// security headers, CORS (only the website's own origin), request logging,
// 404 and the error handler that produces the agreed error format.
const crypto = require('crypto');
const express = require('express');
const logger = require('./logger');
const { AppError } = require('./errors');

function requestId() {
  return (req, res, next) => {
    const ev = req.lambdaEvent || {};
    const fromHeader = req.headers['x-request-id'];
    const id = (typeof fromHeader === 'string' && /^[\w-]{8,64}$/.test(fromHeader) ? fromHeader : null)
      || (ev.requestContext && ev.requestContext.requestId) || crypto.randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    const xff = req.headers['x-forwarded-for'];
    req.clientIp = (ev.requestContext && ev.requestContext.identity && ev.requestContext.identity.sourceIp)
      || (typeof xff === 'string' ? xff.split(',')[0].trim() : null) || req.socket?.remoteAddress || null;
    next();
  };
}

function securityHeaders() {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

function cors() {
  const allowed = (process.env.WEB_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'x-request-id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

function requestLog() {
  return (req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        requestId: req.requestId, method: req.method, path: req.originalUrl.split('?')[0],
        status: res.statusCode, ms: Date.now() - started, userId: req.user ? req.user.id : undefined,
      });
    });
    next();
  };
}

function base(app) {
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(requestId());
  app.use(securityHeaders());
  app.use(cors());
  app.use(express.json({ limit: '20kb' }));
  app.use(requestLog());
}

function notFound() {
  return (req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'This route does not exist.'));
}

function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    let code = err.code || 'INTERNAL_ERROR';
    let message = err.message || 'Something went wrong.';
    if (err.type === 'entity.parse.failed') { status = 400; code = 'VALIDATION_FAILED'; message = 'The request body is not valid JSON.'; }
    if (err.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'The request body is too large.'; }
    // PostgreSQL constraint violations turned into the agreed codes.
    if (err.code === '23P01') { status = 409; code = 'ABSENCE_OVERLAP'; message = 'This child already has an active absence on these dates.'; }
    if (err.code === '23505' && !(err instanceof AppError)) { status = 409; code = 'ALREADY_EXISTS'; message = 'This record already exists.'; }
    if (status >= 500 && !(err instanceof AppError)) {
      logger.error('UNHANDLED_ERROR', { requestId: req.requestId, reason: err.message });
      code = 'INTERNAL_ERROR';
      message = 'Something went wrong. Please try again.';
    }
    const body = { error: { code, message, requestId: req.requestId } };
    if (err.details) body.error.details = err.details;
    res.status(status).json(body);
  };
}

// Wraps async route handlers so rejected promises reach the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { base, notFound, errorHandler, wrap };
