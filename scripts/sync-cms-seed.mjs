#!/usr/bin/env node
/**
 * Refresh the CMS seed data from the consumer app's content file.
 *
 * `customer-app/src/content/home.content.json` is the canonical authored copy — it is what the
 * app renders offline, so it has to be correct there first. The backend needs the same bytes to
 * seed `cms_sections` / `cms_items`, but the two live in SEPARATE git repos with separate
 * deploys, so importing across them would work on a developer's machine and fail everywhere
 * else. Hence a checked-in copy, refreshed by this script.
 *
 * Run from backend/ after editing the app's content file or regenerating its asset manifest:
 *   node scripts/sync-cms-seed.mjs
 *
 * Once the CMS has been published to, the DATABASE is the source of truth. This only refreshes
 * what a brand-new environment starts from.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const APP_CONTENT = resolve(BACKEND, '..', 'customer-app', 'src', 'content');
const DEST = join(BACKEND, 'src', 'db', 'seed', 'data');

const FILES = [
  ['home.content.json', 'cms-home.json'],
  ['asset-manifest.json', 'cms-assets.json'],
];

if (!existsSync(APP_CONTENT)) {
  console.error(
    `Cannot find the consumer app at ${APP_CONTENT}.\n` +
      'This script only works in a checkout that has backend/ and customer-app/ side by side.\n' +
      'The copies under src/db/seed/data/ are committed, so a deploy does not need this.',
  );
  process.exit(1);
}

mkdirSync(DEST, { recursive: true });

for (const [from, to] of FILES) {
  const src = join(APP_CONTENT, from);
  if (!existsSync(src)) {
    console.error(`Missing ${src} — run "node scripts/gen-asset-registry.mjs" in customer-app.`);
    process.exit(1);
  }
  copyFileSync(src, join(DEST, to));
  console.log(`  ${from} → src/db/seed/data/${to}`);
}

const home = JSON.parse(readFileSync(join(DEST, 'cms-home.json'), 'utf8'));
const assets = JSON.parse(readFileSync(join(DEST, 'cms-assets.json'), 'utf8'));
const items = home.sections.reduce((n, s) => n + s.items.length, 0);
console.log(`Synced ${home.sections.length} sections / ${items} items / ${assets.length} assets.`);
