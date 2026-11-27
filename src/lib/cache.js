'use strict';
// Amazon ElastiCache for Valkey, used with the cache aside pattern:
//   1. read the cache first
//   2. on a miss, the SERVICE reads Neon itself and saves the answer with a time limit
//   3. after a change, the service deletes the related keys
// The cache never talks to Neon. If the cache is down, every function returns
// "no value" and the service simply reads Neon directly (slower, never wrong).
//
// Least privilege: this service signs in as its own Valkey user, which can only
// touch keys that start with its own prefix (s1:, s2: or s3:).
const Redis = require('ioredis');
const { ElastiCacheClient, DescribeReplicationGroupsCommand } = require('@aws-sdk/client-elasticache');
const { awsOptions, secret, env } = require('./config');
const logger = require('./logger');

const PREFIX = () => env('CACHE_PREFIX');
let client = null;
let retryAfter = 0;

async function discoverPort() {
  if (process.env.CACHE_PORT) return Number(process.env.CACHE_PORT);
  const ec = new ElastiCacheClient(awsOptions());
  const out = await ec.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: env('CACHE_RG_ID') }));
  const group = out.ReplicationGroups && out.ReplicationGroups[0];
  const ep = group && (group.NodeGroups?.[0]?.PrimaryEndpoint || group.ConfigurationEndpoint);
  if (!ep || !ep.Port) throw new Error('cache endpoint not found');
  return ep.Port;
}

async function flociCa() {
  // Floci signs cache TLS certificates with its own local CA.
  const res = await fetch(`${env('AWS_ENDPOINT_URL')}/_floci/ca.pem`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`could not load cache CA (${res.status})`);
  return res.text();
}

async function getClient() {
  if (client) return client;
  if (Date.now() < retryAfter) return null;
  try {
    const s = await secret();
    const port = await discoverPort();
    const useTls = process.env.CACHE_TLS !== 'false';
    const c = new Redis({
      host: env('CACHE_HOST'),
      port,
      username: env('CACHE_USERNAME'),
      password: s.cachePassword,
      tls: useTls ? { ca: await flociCa(), servername: process.env.CACHE_TLS_SERVERNAME || undefined } : undefined,
      lazyConnect: true,
      connectTimeout: 1500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // The service's Valkey user may only run key commands on its own prefix,
      // so skip the INFO ready check (INFO is not allowed for it).
      enableReadyCheck: false,
    });
    c.on('error', () => {});
    await c.connect();
    client = c;
    return client;
  } catch (e) {
    logger.warn('CACHE_UNAVAILABLE', { reason: e.message });
    retryAfter = Date.now() + 30000;
    client = null;
    return null;
  }
}

function k(key) { return `${PREFIX()}${key}`; }

async function safe(fn, fallback) {
  const c = await getClient();
  if (!c) return fallback;
  try { return await fn(c); } catch (e) {
    logger.warn('CACHE_UNAVAILABLE', { reason: e.message });
    try { c.disconnect(); } catch (_) { /* ignore */ }
    client = null;
    retryAfter = Date.now() + 30000;
    return fallback;
  }
}

async function get(key) {
  const raw = await safe((c) => c.get(k(key)), null);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
async function set(key, value, ttlSeconds) { return safe((c) => c.set(k(key), JSON.stringify(value), 'EX', ttlSeconds), null); }
async function del(...keys) { if (!keys.length) return 0; return safe((c) => c.del(...keys.map(k)), 0); }
// Atomic counter with a time window. Returns null when the cache is down.
async function incr(key, ttlSeconds) {
  return safe(async (c) => {
    const n = await c.incr(k(key));
    if (n === 1) await c.expire(k(key), ttlSeconds);
    return n;
  }, null);
}

// Cache aside helper: return the cached value, or load it, store it and return it.
async function remember(key, ttlSeconds, loader) {
  const hit = await get(key);
  if (hit !== null) return hit;
  const value = await loader();
  await set(key, value, ttlSeconds);
  return value;
}

module.exports = { get, set, del, incr, remember };
