/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * Give the admin CMS picker something to look at.
 *
 * Art bundled in the app binary is addressed by an asset key (`banners/her-new1`) and resolved
 * through a React Native `require()`. The admin portal is a web page: it cannot resolve that,
 * so without this an editor picking bundled art would be choosing from a list of strings.
 *
 * This uploads each bundled file once to object storage and records the resulting URL on
 * `cms_assets.preview_url`. The APP still uses its local copy — nothing about its rendering
 * changes, and no extra bytes are downloaded on a device. These uploads exist purely so the
 * portal can show a thumbnail.
 *
 * Idempotent: keys are deterministic (`cms/bundled/<asset key>`), so a re-run overwrites the
 * same object, and rows that already have a preview URL are skipped unless --force is passed.
 *
 * Run from backend/, with the storage env configured:
 *   npx tsx scripts/upload-cms-assets.ts [--force] [--dry-run]
 *
 * Note it uploads through the SAME facade the app does, so it honours STORAGE_DRIVER — which
 * still defaults to `cloudinary` while the S3 migration finishes. Whichever driver is live is
 * where the previews land.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, isNull, or } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { cmsAssets } from '@/db/schema/cms.js';
import { isStorageConfigured, storageDriverName, uploadObject } from '@/shared/storage/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ASSETS = resolve(HERE, '..', '..', 'customer-app', 'assets');
const MANIFEST = join(HERE, '..', 'src', 'db', 'seed', 'data', 'cms-assets.json');

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

type ManifestRow = { key: string; category: string; kind: 'image' | 'video' };

/** The manifest drops extensions (the key is the identifier); find the file that matches. */
const EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.mp4'];

function readAsset(key: string): { buffer: Buffer; filename: string } | null {
  for (const ext of EXTENSIONS) {
    try {
      const path = join(APP_ASSETS, `${key}${ext}`);
      return { buffer: readFileSync(path), filename: `${key.split('/').pop()}${ext}` };
    } catch {
      // try the next extension
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (!isStorageConfigured()) {
    console.error(
      `Storage driver "${storageDriverName}" is not configured — set its env vars first.\n` +
        'Nothing was uploaded.',
    );
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestRow[];
  const pending = force
    ? await db.select().from(cmsAssets)
    : await db
        .select()
        .from(cmsAssets)
        .where(or(isNull(cmsAssets.previewUrl), eq(cmsAssets.previewUrl, '')));

  const wanted = new Set(pending.map((r) => r.key));
  const todo = manifest.filter((m) => wanted.has(m.key));

  console.log(
    `${todo.length} asset(s) to upload via the "${storageDriverName}" driver` +
      `${dryRun ? ' (dry run)' : ''}.`,
  );
  if (!todo.length) return;

  let done = 0;
  let missing = 0;
  for (const row of todo) {
    const file = readAsset(row.key);
    if (!file) {
      // The manifest is generated from the same folder, so this means the two have drifted —
      // most likely the manifest was copied over from a checkout with different art.
      console.warn(`  ! no file on disk for "${row.key}" — re-run the app's generator`);
      missing += 1;
      continue;
    }
    if (dryRun) {
      console.log(`  · would upload ${row.key} (${(file.buffer.length / 1024).toFixed(0)} KB)`);
      done += 1;
      continue;
    }

    // `publicId` only — passing `folder` as well makes the driver prefix it onto an id that
    // already contains it, producing `cms/bundled/cms/bundled/…`. Harmless (the URL resolves)
    // but confusing, and it was doing exactly that on the first run.
    const result = await uploadObject(file.buffer, {
      publicId: `cms/bundled/${row.key}`,
      resourceType: row.kind,
      filename: file.filename,
      visibility: 'public',
    });

    await db
      .update(cmsAssets)
      .set({
        previewUrl: result.url,
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
      })
      .where(eq(cmsAssets.key, row.key));

    done += 1;
    if (done % 20 === 0) console.log(`  … ${done}/${todo.length}`);
  }

  console.log(`Uploaded ${done} asset preview(s).${missing ? ` ${missing} file(s) missing.` : ''}`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
