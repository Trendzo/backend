/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * Production bootstrap seed: the platform essentials a fresh database needs, and nothing
 * demo. Unlike `run.ts` (`npm run db:seed`) it seeds NO demo retailer, fake orders,
 * consumers, reviews or demo products — the demo catalogs use generic/unmatched images.
 * Products come from the Indore market seed afterwards, whose photos are chosen per leaf
 * category and vetted against the garment (`npm run seed:indore`).
 *
 * Fresh database, in order:
 *   npm run db:push -- --force   # full schema from src/db/schema
 *   npm run db:baseline          # record migrations as applied
 *   npm run db:seed:prod         # this file
 *   npm run seed:indore          # 20 stores + 400 products with matched images
 *
 * Idempotent: every step skips what already exists.
 * Requires ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD to be set explicitly — it refuses the
 * built-in development defaults unless SEED_ALLOW_DEFAULT_ADMIN=true is passed.
 */
import { db, pool } from '@/db/client.js';
import { seedAdmin } from './admin.js';
import { seedAttributeTemplates } from './attribute-templates.js';
import { seedCatalogDefaults } from './catalog-defaults.js';
import { seedCategoryTaxonomy } from './category-taxonomy.js';
import { seedClubbingMatrix } from './clubbing-matrix.js';
import { seedCmsHome } from './cms-home.js';
import { seedConsumerBrands } from './consumer-catalog.js';
import { seedDelegationModes } from './delegation-modes.js';
import { seedPlatformConfig } from './platform-config.js';
import { seedSizeScales } from './size-scales.js';
import { seedSubRoles } from './sub-roles.js';

const DEV_ADMIN_EMAIL = 'admin@trendzo.local';
const DEV_ADMIN_PASSWORD = 'admin1234';

async function main(): Promise<void> {
  // The dev defaults are public (they are prefilled on the web portal's admin login), so a
  // production seed refuses them unless the operator explicitly accepts that risk.
  const allowDefault = process.env.SEED_ALLOW_DEFAULT_ADMIN === 'true';
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!allowDefault && (!email || email === DEV_ADMIN_EMAIL)) {
    throw new Error('Set ADMIN_SEED_EMAIL to the real admin email (or SEED_ALLOW_DEFAULT_ADMIN=true).');
  }
  if (!allowDefault && (!password || password === DEV_ADMIN_PASSWORD)) {
    throw new Error('Set ADMIN_SEED_PASSWORD to a strong password (or SEED_ALLOW_DEFAULT_ADMIN=true).');
  }
  if (allowDefault && (!password || password === DEV_ADMIN_PASSWORD)) {
    console.warn('WARNING: seeding the super-admin with the PUBLIC default password — change it after first login.');
  }

  console.log('Seeding platform_config…');
  await seedPlatformConfig(db);
  console.log('Seeding clubbing_matrix_entries…');
  await seedClubbingMatrix(db);
  console.log('Seeding attribute_templates…');
  await seedAttributeTemplates(db);
  console.log('Seeding sub_roles / delegation_modes…');
  await seedSubRoles(db);
  await seedDelegationModes(db);
  console.log('Seeding super-admin…');
  await seedAdmin(db);
  console.log('Seeding catalog defaults (brands)…');
  await seedCatalogDefaults(db);
  // Before anything that resolves a category by slug (the Indore seed needs the leaves).
  console.log('Seeding category taxonomy…');
  await seedCategoryTaxonomy(db);
  console.log('Seeding size_scales…');
  await seedSizeScales(db);
  // The brand vocabulary only — no demo listings. The Indore seed references these.
  console.log('Seeding consumer brands…');
  await seedConsumerBrands(db);
  // Draft only; nothing is live until an admin publishes the home CMS.
  console.log('Seeding home CMS draft…');
  await seedCmsHome(db);
  console.log('Production bootstrap seed complete. Next: npm run seed:indore');
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
