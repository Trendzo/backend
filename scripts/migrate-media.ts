/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * Copy externally hosted media (Cloudinary + the old S3/CloudFront bucket) into the
 * configured object store and rewrite the stored links. Logic + rationale live in
 * src/db/migrate-media.ts (tested in test/migrate-media.test.ts).
 *
 * Run from backend/ with DATABASE_URL pointing at the target DB and STORAGE_DRIVER=s3
 * (S3_BUCKET, S3_PUBLIC_BASE_URL, and S3_ENDPOINT + S3_FORCE_PATH_STYLE=true for MinIO):
 *   npx tsx scripts/migrate-media.ts                    # dry run (default): discover + probe
 *   npx tsx scripts/migrate-media.ts --apply            # copy, then rewrite links
 *   npx tsx scripts/migrate-media.ts --concurrency=12   # parallel downloads (default 6)
 *
 * Re-runnable: rewritten links are no longer sources, so a re-run only retries failures.
 */
import { db, pool } from '@/db/client.js';
import { migrateMedia } from '@/db/migrate-media.js';
import { storageDriverName } from '@/shared/storage/index.js';

const apply = process.argv.includes('--apply');
const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='));
const concurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : undefined;

async function main(): Promise<void> {
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new Error(`--concurrency must be a positive integer, got ${concurrencyArg}`);
  }
  console.log(
    apply
      ? `APPLY mode — media will be copied into "${storageDriverName}" storage and links rewritten.`
      : 'Dry run (pass --apply to copy + rewrite).',
  );
  const r = await migrateMedia(db, {
    apply,
    ...(concurrency !== undefined && { concurrency }),
    log: (msg) => console.log(msg),
  });

  for (const c of r.columns) console.log(`  ${c.table}.${c.column}: ${c.urls} URL(s)`);
  for (const s of r.samples) console.log(`  ${s.from} → ${s.to}`);
  if (r.failed.length) {
    console.log(`Failures (${r.failed.length}${r.failed.length > 20 ? ', first 20' : ''}):`);
    for (const x of r.failed.slice(0, 20)) console.log(`  ${x.url} — ${x.reason}`);
  }
  console.log(
    apply
      ? `${r.urls} source URL(s) in ${r.columns.length} column(s): ${r.copied} copied, ` +
          `${r.aliased} query alias(es), ${r.failed.length} failed; ${r.rowsRewritten} row(s) rewritten.`
      : `${r.urls} source URL(s) in ${r.columns.length} column(s): ${r.reachable} reachable, ` +
          `${r.aliased} query alias(es), ${r.failed.length} would fail.`,
  );
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
