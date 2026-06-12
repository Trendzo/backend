#!/usr/bin/env node
// Additive, idempotent migration for referrals:
//   - consumers.referral_code column + backfill (derived from id) + unique index
//   - referrals table
// Hand-applied via pg (journal is behind the live DB; drizzle-kit migrate hangs on Neon).
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const stmts = [
  `ALTER TABLE consumers ADD COLUMN IF NOT EXISTS referral_code text;`,

  // Backfill existing consumers with the same deterministic code the app generates
  // ('CX' + 8 hex chars after the 'cns_' prefix).
  `UPDATE consumers
     SET referral_code = 'CX' || upper(substring(id from 5 for 8))
   WHERE referral_code IS NULL;`,

  `CREATE UNIQUE INDEX IF NOT EXISTS consumers_referral_code_idx ON consumers (referral_code);`,

  `CREATE TABLE IF NOT EXISTS referrals (
     id text PRIMARY KEY,
     referrer_consumer_id text NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
     referee_consumer_id text NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
     referrer_points integer NOT NULL,
     referee_points integer NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   );`,

  `CREATE UNIQUE INDEX IF NOT EXISTS referrals_referee_idx ON referrals (referee_consumer_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS referrals_referrer_referee_idx ON referrals (referrer_consumer_id, referee_consumer_id);`,
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  const client = await pool.connect();
  try {
    for (const stmt of stmts) {
      console.log('>', stmt.slice(0, 70).replace(/\s+/g, ' '), '…');
      await client.query(stmt);
    }
    console.log('referrals schema applied.');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
