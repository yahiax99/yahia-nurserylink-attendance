'use strict';
// Absence events published to S3's Amazon SNS topic. The topic has two subscribers:
//  1. S1's SQS queue (then forwarder -> S1 load balancer -> S1 checklist and drafts)
//  2. S3's Notify Lambda (saves a teacher notification)
// The event never contains the reason or the note: those stay private in S3.
const crypto = require('crypto');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { awsOptions, env } = require('../lib/config');
const logger = require('../lib/logger');

let sns;

async function publishAbsence(req, type, absence) {
  const event = {
    type,
    version: 1,
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    absence: {
      id: absence.id, childId: absence.childId, classId: absence.classId,
      startDate: absence.startDate, endDate: absence.endDate, status: absence.status,
    },
  };
  try {
    sns = sns || new SNSClient(awsOptions());
    await sns.send(new PublishCommand({ TopicArn: env('TOPIC_ARN'), Message: JSON.stringify(event) }));
    logger.info('ABSENCE_EVENT_PUBLISHED', { requestId: req && req.requestId, type, eventId: event.eventId });
  } catch (e) {
    await logger.security('DEPENDENCY_FAILED', req, { target: 'SNS absence topic', reason: e.message, fallback: 'S1 still checks absences directly' });
  }
}

module.exports = { publishAbsence };
