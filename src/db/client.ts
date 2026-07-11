import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env.js';
import * as schema from './schema/index.js';

const { Pool } = pg;

/**
 * Single shared pg pool for the app. Sized for a monolithic deploy on a moderate-sized box.
 * For very small deploys, lower max; for larger, raise.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Neon (and other serverless PG) drops idle connections. Without this handler
// the unhandled 'error' event crashes the process.
pool.on('error', (err) => {
  console.error('[pg pool] idle client error — connection will be recycled:', err.message);
});

// Drizzle dumps every SQL statement + params when logging is on. That's noisy,
// so gate it on log level: silent by default, and only when you explicitly set
// LOG_LEVEL=debug (or trace) do the raw queries come back for DB debugging.
const logSql = env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace';
export const db = drizzle(pool, { schema, logger: logSql });

export type Database = typeof db;
