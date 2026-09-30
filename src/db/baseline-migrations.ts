/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * Mark every migration in src/db/migrations as applied, without running it.
 *
 * For a database whose schema was created with `npm run db:push -- --force` (the schema
 * files are the source of truth; several tables exist in the schema but in no migration,
 * so `db:migrate` alone cannot build a complete fresh database). A pushed database has no
 * `drizzle.__drizzle_migrations` bookkeeping, so a later `db:migrate` would replay 0000+
 * and fail. This records each journal entry exactly as drizzle's migrator would
 * (sha256 of the SQL file + the journal `when`), so future migrations apply normally.
 *
 * Idempotent: entries already recorded (by hash) are skipped.
 * Refuses to run against a database without the app schema (push first).
 *
 * Usage (from backend/, DATABASE_URL pointing at the target DB):
 *   npm run db:baseline
 */
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, pool } from '@/db/client.js';

async function main(): Promise<void> {
  const [probe] = (
    await db.execute(sql`select to_regclass('public.product_listings') is not null as ready`)
  ).rows as Array<{ ready: boolean }>;
  if (!probe?.ready) {
    throw new Error('App schema not found — run `npm run db:push -- --force` first.');
  }

  const migrations = readMigrationFiles({ migrationsFolder: './src/db/migrations' });
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`);

  const existing = new Set(
    ((await db.execute(sql`select hash from drizzle.__drizzle_migrations`)).rows as Array<{ hash: string }>).map(
      (r) => r.hash,
    ),
  );
  let added = 0;
  for (const m of migrations) {
    if (existing.has(m.hash)) continue;
    await db.execute(
      sql`insert into drizzle.__drizzle_migrations ("hash", "created_at") values (${m.hash}, ${m.folderMillis})`,
    );
    added += 1;
  }
  console.log(`Baselined ${added} migration(s); ${migrations.length - added} were already recorded.`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
