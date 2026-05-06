#!/usr/bin/env node
/**
 * Boot a portable Postgres on localhost:5433 for local dev/testing only.
 * Data lives in `.dev-pg-data/`. Idempotent — re-running re-uses the data dir.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('.dev-pg-data');
const PORT = 5433;
const USER = 'closetx';
const PASSWORD = 'closetx';
const DB = 'closetx_dev';

await mkdir(DATA_DIR, { recursive: true });

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

const isInitialized = existsSync(path.join(DATA_DIR, 'PG_VERSION'));
if (!isInitialized) {
  console.log('Initialising Postgres data dir...');
  await pg.initialise();
}

console.log('Starting Postgres on port', PORT);
await pg.start();

try {
  await pg.createDatabase(DB);
  console.log(`Created database '${DB}'`);
} catch (e) {
  console.log(`Database '${DB}' already exists`);
}

console.log(`Postgres ready: postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB}`);

// Keep alive — graceful shutdown on SIGTERM/SIGINT
process.on('SIGTERM', async () => { await pg.stop(); process.exit(0); });
process.on('SIGINT',  async () => { await pg.stop(); process.exit(0); });
// Block forever
await new Promise(() => {});
