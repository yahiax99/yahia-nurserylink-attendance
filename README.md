# NurseryLink S3: Attendance and Absences (Team 31)

Owner: Yahia Hesham

Report absences with nursery day rules, the status workflow (Reported, Acknowledged, Cancelled),
expected attendance for S1, monthly rates, sick follow ups, the monthly CSV report and teacher
notifications. Runs on AWS Lambda behind API Gateway on Floci.

- `lambda.js` S3 Lambda entry point (HTTP and scheduled jobs)
- `notify.js` Notify Lambda (SNS subscriber)
- `src/routes` absences, attendance, follow ups, notifications, reports
- `src/services` SNS events, attendance, calls to S2, business rules
- `tests` unit tests (`npm test`)

Deployed together with the other services from the team repository (`infra/floci/deploy.sh`).
