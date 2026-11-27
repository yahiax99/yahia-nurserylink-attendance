'use strict';
// Local development only: runs the same Express app on http://localhost:3003.
const { buildApp } = require('./src/app');

const port = Number(process.env.PORT || 3003);
buildApp().listen(port, () => console.log(`S3 Attendance and Absences listening on http://localhost:${port}`));
