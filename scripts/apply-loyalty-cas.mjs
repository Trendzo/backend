#!/usr/bin/env node
// Additive, idempotent migration for loyalty concurrency control (TODO-1):
//   - consumer_loyalty balance-projection table (points analogue of consumer_wallets)
//   - loyalty_transactions.balance_version_after column + backfill (per-consumer sequence)
//   - unique (consumer_id, balance_version_after) CAS guard
//   - backfill consumer_loyalty rows from the existing ledger
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
  // 1) Balance projection table.
  `CREATE TABLE IF NOT EXISTS consumer_loyalty (
     id text PRIMARY KEY,
     consumer_id text NOT NULL REFERENCES consumers(id),
     balance_points integer NOT NULL DEFAULT 0,
     version integer NOT NULL DEFAULT 0,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT consumer_loyalty_balance_non_negative CHECK (balance_points >= 0)
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS consumer_loyalty_consumer_idx ON consumer_loyalty (consumer_id);`,

  // 2) Version column on the ledger (nullable first so the backfill can populate it).
  `ALTER TABLE loyalty_transactions ADD COLUMN IF NOT EXISTS balance_version_after integer;`,

  // 3) Backfill the version as a per-consumer running sequence ordered by time then id.
  `WITH seq AS (
     SELECT id,
            row_number() OVER (PARTITION BY consumer_id ORDER BY at ASC, id ASC) AS rn
       FROM loyalty_transactions
   )
   UPDATE loyalty_transactions lt
      SET balance_version_after = seq.rn
     FROM seq
    WHERE lt.id = seq.id
      AND lt.balance_version_after IS NULL;`,

  // 4) Lock the column down + add the CAS-guard unique index.
  `ALTER TABLE loyalty_transactions ALTER COLUMN balance_version_after SET NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS loyalty_transactions_consumer_version_idx
     ON loyalty_transactions (consumer_id, balance_version_after);`,

  // 5) Seed consumer_loyalty from the ledger: balance = latest row's balance_after_points,
  //    version = count of ledger rows (so the next applyLoyaltyDelta picks up at count+1,
  //    matching the backfilled sequence above). Idempotent on consumer_id.
  `INSERT INTO consumer_loyalty (id, consumer_id, balance_points, version, updated_at)
   SELECT 'lac_' || replace(gen_random_uuid()::text, '-', ''),
          agg.consumer_id,
          agg.balance_points,
          agg.txn_count,
          now()
     FROM (
       SELECT consumer_id,
              COUNT(*) AS txn_count,
              (ARRAY_AGG(balance_after_points ORDER BY at DESC, id DESC))[1] AS balance_points
         FROM loyalty_transactions
        GROUP BY consumer_id
     ) agg
   ON CONFLICT (consumer_id) DO NOTHING;`,
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  const client = await pool.connect();
  try {
    for (const stmt of stmts) {
      console.log('>', stmt.slice(0, 70).replace(/\s+/g, ' '), '…');
      await client.query(stmt);
    }
    console.log('loyalty-cas schema applied.');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
