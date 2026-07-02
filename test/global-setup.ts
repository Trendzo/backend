/**
 * Vitest global setup: boot a throwaway embedded Postgres on :5434, create the test DB,
 * and apply the schema with `drizzle-kit push` (non-interactive on an empty DB). Torn down
 * after the run. Keep the URL here in sync with `test.env.DATABASE_URL` in vitest.config.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 5434;
const DB = 'closetx_test';
const URL = `postgresql://test:test@localhost:${PORT}/${DB}`;

export default async function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'closetx-test-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'test',
    password: 'test',
    port: PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB);

  // Empty DB → push is a pure CREATE run, no interactive prompts. --force skips the
  // data-loss guard. drizzle.config.ts reads DATABASE_URL from env.
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: URL },
    stdio: 'inherit',
  });

  return async () => {
    await pg.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
