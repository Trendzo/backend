#!/usr/bin/env node
// One-shot, idempotent normalization for gift-card codes (TODO-4):
//   uppercase any legacy mixed-case codes so case-insensitive redemption is exact.
// Collision-guarded: only uppercases a code when no *other* card already holds the
// uppercased form (the unique gift_cards_code_idx would otherwise reject the update).
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const stmts = [
  `UPDATE gift_cards g
      SET code = upper(code)
    WHERE code <> upper(code)
      AND NOT EXISTS (
        SELECT 1 FROM gift_cards o
         WHERE o.id <> g.id AND o.code = upper(g.code)
      );`,
];

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  const client = await pool.connect();
  try {
    for (const stmt of stmts) {
      const res = await client.query(stmt);
      console.log('> normalized gift-card codes, rows affected:', res.rowCount);
    }
    console.log('gift-card code normalization applied.');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
