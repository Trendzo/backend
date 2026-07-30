/* eslint-disable no-console -- CLI tool: console output is the intended UX */
/**
 * Seed orchestrator. NEVER runs automatically — invoke explicitly with `npm run db:seed`
 * against a fresh database (or one where re-seeding the defaults is safe — every step is
 * idempotent via onConflictDoNothing).
 *
 * Order: independent seeds first, dependent ones later. None depend on identity entities
 * (no super-admin is seeded — that account is created out-of-band per spec).
 */

import { db } from '@/db/client.js';
import { seedAdmin } from './admin.js';
import { seedAttributeTemplates } from './attribute-templates.js';
import { seedCatalogDefaults } from './catalog-defaults.js';
import { seedCatalogExpand } from './catalog-expand.js';
import { seedCategoryTaxonomy } from './category-taxonomy.js';
import { seedClubbingMatrix } from './clubbing-matrix.js';
import { seedCmsHome } from './cms-home.js';
import { seedConsumerCatalog } from './consumer-catalog.js';
import { seedDelegationModes } from './delegation-modes.js';
import { seedDemoRetailer } from './demo-retailer.js';
import { fixImages } from './fix-images.js';
import { seedPlatformConfig } from './platform-config.js';
import { seedProductReviews } from './product-reviews.js';
import { seedSizeScales } from './size-scales.js';
import { seedSubRoles } from './sub-roles.js';

async function main(): Promise<void> {
  console.log('Seeding platform_config…');
  await seedPlatformConfig(db);

  console.log('Seeding clubbing_matrix_entries…');
  await seedClubbingMatrix(db);

  console.log('Seeding attribute_templates…');
  await seedAttributeTemplates(db);

  console.log('Seeding sub_roles (no-op)…');
  await seedSubRoles(db);

  console.log('Seeding delegation_modes (no-op for MVP)…');
  await seedDelegationModes(db);

  console.log('Seeding super-admin…');
  await seedAdmin(db);

  console.log('Seeding catalog defaults (brands)…');
  await seedCatalogDefaults(db);

  // Must precede every seeder that resolves a category by slug — demo-retailer,
  // consumer-catalog and catalog-expand all look up taxonomy leaves.
  console.log('Seeding category taxonomy (tree + listing remap)…');
  await seedCategoryTaxonomy(db);

  console.log('Seeding size_scales…');
  await seedSizeScales(db);

  console.log('Seeding demo retailer (demo@closetx.local)…');
  await seedDemoRetailer(db);

  console.log('Seeding consumer catalog (brands, categories, listings, collections)…');
  await seedConsumerCatalog(db);

  // The hand-written catalog covers a dozen leaves; this fills the remaining ~100 so no
  // browse tile opens empty. Needs the store + brands the seeds above create.
  console.log('Expanding catalog across every taxonomy leaf…');
  await seedCatalogExpand(db);

  console.log('Seeding product reviews…');
  await seedProductReviews(db);

  console.log('Fixing image URLs (pngimg → unsplash)…');
  await fixImages(db);

  // Independent of the catalog — it seeds merchandising content, not products. Last only
  // because it is the newest. Fills the DRAFT; nothing is live until an admin presses Publish.
  console.log('Seeding home CMS (sections, items, bundled-asset catalogue)…');
  await seedCmsHome(db);

  console.log('Seed complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
