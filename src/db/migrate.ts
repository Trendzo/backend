/** Apply checked-in SQL migrations with the same driver used by the app. */
import 'dotenv/config';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const targetUrl = process.env['MIGRATION_DATABASE_URL'] || process.env['DATABASE_URL'];
if (!targetUrl) throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL before migrating');
const pool = new pg.Pool({ connectionString: targetUrl, max: 1 });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder: resolve(process.cwd(), 'src/db/migrations') });
  // eslint-disable-next-line no-console -- CLI progress belongs on stdout.
  console.log('Database migrations applied.');
} catch (error) {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
