#!/usr/bin/env node
/**
 * Quick connectivity smoke for whichever DB DATABASE_URL points at. Reports server version,
 * current database/user, table count, and round-trip latency for a trivial SELECT.
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const safe = url.replace(/:[^:@/]+@/, ':***@');
console.log('→', safe);

const client = new pg.Client({ connectionString: url });
const t0 = Date.now();
await client.connect();
const connectedMs = Date.now() - t0;

const r = async (sql) => (await client.query(sql)).rows;
const [meta] = await r(`SELECT current_database() AS db, current_user AS who, version() AS v`);
const [{ count: tableCount }] = await r(
  `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'`,
);
const tt0 = Date.now();
await client.query(`SELECT 1`);
const pingMs = Date.now() - tt0;

console.log(`✓ connected in ${connectedMs}ms`);
console.log(`  db=${meta.db}  user=${meta.who}`);
console.log(`  ${meta.v.split(' on')[0]}`);
console.log(`  public tables: ${tableCount}`);
console.log(`  SELECT 1 round-trip: ${pingMs}ms`);

await client.end();
