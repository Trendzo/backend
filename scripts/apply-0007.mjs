#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const sql = readFileSync('./src/db/migrations/0007_powerful_overlord.sql', 'utf8');
const stmts = sql
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
try {
  const client = await pool.connect();
  try {
    for (const stmt of stmts) {
      console.log('>', stmt.slice(0, 100), '…');
      await client.query(stmt);
    }
    console.log('Applied 0007_powerful_overlord.sql');
  } finally {
    client.release();
  }
} catch (err) {
  console.error('Apply failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
