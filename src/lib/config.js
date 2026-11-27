'use strict';
// Configuration. Non secret values come from Lambda environment variables (set by
// the CloudFormation template). Secret values come ONLY from AWS Secrets Manager,
// read once per cold start. Nothing secret is ever written in the code or the repo.
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const awsOptions = () => ({
  region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
  ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL } : {}),
});

let secretsClient;
const cache = new Map();

async function readSecret(secretId) {
  if (!secretId) return {};
  if (cache.has(secretId)) return cache.get(secretId);
  secretsClient = secretsClient || new SecretsManagerClient(awsOptions());
  const out = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  const value = JSON.parse(out.SecretString || '{}');
  cache.set(secretId, value);
  return value;
}

// The service's own secret (database URL, cache password, ...).
async function secret() { return readSecret(process.env.SECRET_ID); }
// The shared internal key used only for machine to machine calls that have no user
// (the SQS forwarder and the scheduled jobs). Never accepted from the browser.
async function internalKey() { const s = await readSecret(process.env.INTERNAL_SECRET_ID); return s.internalKey; }

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing environment variable ${name}`);
  }
  return v;
};

module.exports = { awsOptions, secret, internalKey, readSecret, env };
