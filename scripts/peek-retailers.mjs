#!/usr/bin/env node
/**
 * Direct DB peek at retailer accounts. Usage: `node scripts/peek-retailers.mjs [email]`
 * - With no arg: list every retailer
 * - With an email: dump that one row including password hash prefix and full status
 */
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const arg = process.argv[2];

const client = new Client({ connectionString: url });
await client.connect();

if (!arg) {
  const r = await client.query(
    `SELECT id, email, legal_name, phone, gstin, status, store_id,
            substring(password_hash, 1, 7) AS hash_prefix,
            length(password_hash) AS hash_len,
            created_at
       FROM retailer_accounts
       ORDER BY created_at DESC`,
  );
  console.log(`${r.rows.length} retailer account(s):\n`);
  for (const row of r.rows) console.log(row);
} else {
  const r = await client.query(
    `SELECT id, email, legal_name, phone, gstin, status, store_id, password_hash,
            length(password_hash) AS hash_len, created_at
       FROM retailer_accounts WHERE email = $1`,
    [arg.toLowerCase()],
  );
  if (!r.rows.length) {
    console.log(`No retailer with email '${arg}'`);
  } else {
    for (const row of r.rows) {
      console.log({
        ...row,
        password_hash: row.password_hash.slice(0, 4) + '…' + row.password_hash.slice(-4),
      });
    }
  }
}

await client.end();
