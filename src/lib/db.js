'use strict';
// Neon PostgreSQL connection. The connection string (pooled Neon URL for THIS
// service's own database role) is read from Secrets Manager. TLS is required.
// Only parameterised queries are used: values are never joined into SQL text.
const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings (no time zone shifting).
types.setTypeParser(1082, (v) => v);
const { secret } = require('./config');

let pool;

async function getPool() {
  if (pool) return pool;
  const s = await secret();
  if (!s.databaseUrl) throw new Error('databaseUrl missing from the service secret');
  pool = new Pool({
    connectionString: s.databaseUrl,
    ssl: { rejectUnauthorized: true },
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
  return pool;
}

async function query(text, params = []) {
  const p = await getPool();
  return p.query(text, params);
}

async function one(text, params) { const r = await query(text, params); return r.rows[0] || null; }
async function many(text, params) { const r = await query(text, params); return r.rows; }

// Runs fn inside one transaction (BEGIN ... COMMIT, ROLLBACK on error).
async function tx(fn) {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { query, one, many, tx };
