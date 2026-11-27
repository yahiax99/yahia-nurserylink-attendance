'use strict';
// S3 Attendance and Absences (owner: Yahia Hesham). The same Express app runs
// locally (server.js) and in AWS Lambda (lambda.js), behind API Gateway and behind
// S3's internal load balancer (calls from S1).
const express = require('express');
const { base, notFound, errorHandler } = require('./lib/web');

function buildApp() {
  const app = express();
  base(app);
  app.use(require('./routes/absences'));
  app.use(require('./routes/attendance'));
  app.use(require('./routes/followups'));
  app.use(require('./routes/reports'));
  app.use(require('./routes/notifications'));
  app.use(notFound());
  app.use(errorHandler());
  return app;
}

module.exports = { buildApp };
