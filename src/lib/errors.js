'use strict';
// One error type for the whole service. The error handler turns it into the
// agreed JSON error format: { error: { code, message, requestId, details } }.

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthenticated = (message = 'Please log in.') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (code = 'FORBIDDEN_ROLE', message = 'You are not allowed to do this.') => new AppError(403, code, message);
const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);
const conflict = (code, message) => new AppError(409, code, message);
const tooMany = (code, message) => new AppError(429, code, message);
const dependencyFailed = (message = 'A required service is not available. Please try again.') => new AppError(503, 'DEPENDENCY_FAILED', message);

module.exports = { AppError, badRequest, unauthenticated, forbidden, notFound, conflict, tooMany, dependencyFailed };
