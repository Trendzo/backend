#!/usr/bin/env node
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const { Pool } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 });
const db = drizzle(pool);

try {
  console.log('Running migrations from src/db/migrations …');
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.log('Migrations applied.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
