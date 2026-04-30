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

export const db = drizzle(pool, { schema, logger: env.NODE_ENV === 'development' });

export type Database = typeof db;
