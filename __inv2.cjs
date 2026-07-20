const { Client } = require('pg');
const fs = require('fs');
const env = Object.fromEntries(
  fs.readFileSync('e:/Android/Projects/closetx/backend/.env', 'utf8')
    .split(/\r?\n/).filter(Boolean).filter(l => !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();

  // digits-only normalized match (handles spaces/dashes/hidden chars)
  console.log('=== retailer_accounts: digits-normalized phone ends with 9926446622 ===');
  console.log(JSON.stringify((await c.query(
    `select id, email, phone, status, store_id from retailer_accounts
      where regexp_replace(phone, '\\D', '', 'g') like '%9926446622'`)).rows, null, 2));

  console.log('=== retailer_applications: digits-normalized owner_phone ends with 9926446622 ===');
  console.log(JSON.stringify((await c.query(
    `select id, owner_email, owner_phone, status from retailer_applications
      where regexp_replace(owner_phone, '\\D', '', 'g') like '%9926446622'`)).rows, null, 2));

  // stores table — the message says "account or store"
  const cols = (await c.query(
    `select column_name from information_schema.columns where table_name='stores' and (column_name ilike '%phone%' or column_name ilike '%email%')`)).rows.map(r=>r.column_name);
  console.log('=== stores phone/email-ish columns:', cols);
  for (const col of cols) {
    const r = await c.query(`select id, ${col} from stores where regexp_replace(coalesce(${col},''),'\\D','','g') like '%9926446622' or coalesce(${col},'') ilike '%9926446622%'`);
    if (r.rowCount) console.log(`  stores.${col} matches:`, JSON.stringify(r.rows));
  }

  // How many total accounts/apps, and show near-miss 99264 prefixes
  console.log('=== any phone containing 99264 (near-miss) ===');
  console.log('accounts:', JSON.stringify((await c.query(`select phone from retailer_accounts where regexp_replace(phone,'\\D','','g') like '%99264%'`)).rows.map(r=>r.phone)));
  console.log('apps:', JSON.stringify((await c.query(`select owner_phone from retailer_applications where regexp_replace(owner_phone,'\\D','','g') like '%99264%'`)).rows.map(r=>r.owner_phone)));

  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
