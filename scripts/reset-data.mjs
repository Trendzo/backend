#!/usr/bin/env node
/**
 * Truncates user-data tables (keeps platform_config, brands, categories, clubbing_matrix
 * defaults, the seeded admin) so the smoke test can re-run from a clean slate.
 */
import 'dotenv/config';
import pg from 'pg';
const { Client } = pg;

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set — check backend/.env'); process.exit(1); }
const c = new Client({ connectionString: url });
await c.connect();
await c.query(`
  TRUNCATE TABLE
    variants, product_listings,
    bank_accounts, retailer_accounts, retailer_stores,
    retailer_applications
  RESTART IDENTITY CASCADE;
`);
// Drop only retailer-created brand 'acme' from previous runs (keep seeded defaults).
await c.query(`DELETE FROM brands WHERE slug = 'acme'`);
console.log('User data reset.');
await c.end();
