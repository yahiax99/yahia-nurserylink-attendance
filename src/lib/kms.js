'use strict';
// Field level encryption with this service's OWN AWS KMS key. Used for free text
// that can hold sensitive details (S1 daily update notes, S3 absence notes).
// The database only ever stores the ciphertext; the key policy lets only this
// service's role decrypt it, so database access alone reveals nothing.
const { KMSClient, EncryptCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const { awsOptions, env } = require('./config');

let kms;
const client = () => (kms = kms || new KMSClient(awsOptions()));
const context = () => ({ app: 'nurserylink', service: process.env.SERVICE_NAME || 'unknown' });

async function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return null;
  const out = await client().send(new EncryptCommand({
    KeyId: env('KMS_KEY_ID'), Plaintext: Buffer.from(String(plaintext), 'utf8'), EncryptionContext: context(),
  }));
  return Buffer.from(out.CiphertextBlob).toString('base64');
}

async function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const out = await client().send(new DecryptCommand({
    CiphertextBlob: Buffer.from(ciphertext, 'base64'), EncryptionContext: context(),
  }));
  return Buffer.from(out.Plaintext).toString('utf8');
}

module.exports = { encrypt, decrypt };
