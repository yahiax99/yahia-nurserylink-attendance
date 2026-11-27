'use strict';
// Monthly attendance reports (teacher only). The scheduled job saves each class's
// report as a CSV in the private Amazon S3 reports bucket (encrypted with S3's own
// KMS key). The teacher gets a download link that expires after 5 minutes.
// CloudTrail records each download (S3 data event).
const express = require('express');
const { S3Client, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../lib/logger');
const v = require('../lib/validate');
const dates = require('../lib/dates');
const { wrap } = require('../lib/web');
const { awsOptions, env } = require('../lib/config');
const { requireAuth, requireRole, assertClassAccess } = require('../lib/auth');
const { AppError } = require('../lib/errors');

const router = express.Router();
let s3;
let publicS3;
const reportKey = (classId, ym) => `reports/${classId}/${ym}.csv`;

router.get('/api/classes/:classId/reports/monthly', requireAuth(), requireRole('teacher'),
  v.params({ classId: { type: 'uuid', required: true } }), v.query({ month: { type: 'month' } }),
  wrap(async (req, res) => {
    const { classId } = req.params;
    await assertClassAccess(req, classId, { teacherOnly: true });
    const ym = req.query.month || dates.previousMonth(dates.cairoToday().slice(0, 7));
    s3 = s3 || new S3Client({ ...awsOptions(), forcePathStyle: true });
    const Bucket = env('REPORTS_BUCKET');
    const Key = reportKey(classId, ym);
    try {
      await s3.send(new HeadObjectCommand({ Bucket, Key }));
    } catch (e) {
      if (e.$metadata && e.$metadata.httpStatusCode === 404) throw new AppError(404, 'REPORT_NOT_READY', 'The report for this month is not ready yet.');
      throw e;
    }
    // The link is signed for the address the browser uses to reach Floci.
    publicS3 = publicS3 || new S3Client({ ...awsOptions(), endpoint: env('PUBLIC_S3_ENDPOINT'), forcePathStyle: true });
    const url = await getSignedUrl(publicS3, new GetObjectCommand({ Bucket, Key }), { expiresIn: 300 });
    await logger.audit('REPORT_LINK_CREATED', req, { classId, month: ym });
    res.json({ month: ym, url, expiresIn: 300 });
  }));

module.exports = router;
