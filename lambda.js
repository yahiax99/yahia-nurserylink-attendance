'use strict';
// AWS Lambda entry point for S3.
//  * EventBridge Scheduler events carry { job: ... } and run a scheduled job.
//  * API Gateway and load balancer events go to the Express app (serverless-http).
const serverless = require('serverless-http');
const { buildApp } = require('./src/app');
const jobs = require('./src/jobs');

let handler;

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  if (event && typeof event.job === 'string') return jobs.run(event);
  if (!handler) {
    handler = serverless(buildApp(), { request(req, ev) { req.lambdaEvent = ev; } });
  }
  return handler(event, context);
};
