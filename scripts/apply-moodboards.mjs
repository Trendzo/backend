#!/usr/bin/env node
// Additive, idempotent migration for moodboards (enum + 2 tables + indexes).
// Hand-applied via pg in autocommit — the migration journal is behind the live DB
// and `drizzle-kit migrate` hangs against Neon. Safe to run repeatedly.
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const stmts = [
  `DO $$ BEGIN
     CREATE TYPE moodboard_status AS ENUM ('active', 'taken_down');
   EXCEPTION WHEN duplicate_object THEN null; END $$;`,

  `CREATE TABLE IF NOT EXISTS moodboards (
     id text PRIMARY KEY,
     consumer_id text NOT NULL REFERENCES consumers(id) ON DELETE CASCADE,
     name text NOT NULL,
     note text,
     is_public boolean NOT NULL DEFAULT false,
     status moodboard_status NOT NULL DEFAULT 'active',
     takedown_reason text,
     takedown_by_admin_id text REFERENCES admin_accounts(id),
     takedown_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT moodboards_takedown_guard CHECK (
       (status <> 'taken_down' AND takedown_reason IS NULL AND takedown_by_admin_id IS NULL AND takedown_at IS NULL)
       OR (status = 'taken_down' AND takedown_reason IS NOT NULL AND takedown_by_admin_id IS NOT NULL AND takedown_at IS NOT NULL)
     )
   );`,

  `CREATE TABLE IF NOT EXISTS moodboard_items (
     id text PRIMARY KEY,
     moodboard_id text NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
     listing_id text NOT NULL REFERENCES product_listings(id),
     sort_order integer NOT NULL DEFAULT 0,
     added_at timestamptz NOT NULL DEFAULT now()
   );`,

  `CREATE INDEX IF NOT EXISTS moodboards_consumer_created_idx ON moodboards (consumer_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS moodboards_status_idx ON moodboards (status);`,
  `CREATE INDEX IF NOT EXISTS moodboards_public_idx ON moodboards (is_public);`,
  `CREATE INDEX IF NOT EXISTS moodboard_items_moodboard_idx ON moodboard_items (moodboard_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS moodboard_items_board_listing_idx ON moodboard_items (moodboard_id, listing_id);`,
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  const client = await pool.connect();
  try {
    for (const stmt of stmts) {
      console.log('>', stmt.slice(0, 70).replace(/\s+/g, ' '), '…');
      await client.query(stmt);
    }
    console.log('moodboards schema applied.');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
