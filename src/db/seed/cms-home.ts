/**
 * Seed the Home CMS from the content the app ships.
 *
 * `data/cms-home.json` is a copy of `customer-app/src/content/home.content.json` — the app's
 * offline fallback — and `data/cms-assets.json` is a copy of its generated asset manifest.
 * They are copies rather than imports because backend and customer-app are separate git repos
 * with separate deploys, so a relative path across them would resolve on a developer's machine
 * and nowhere else. `npm run cms:sync` refreshes both.
 *
 * Idempotent, and idempotent in a specific way: the SECTION list is reconciled every run
 * (sections are a fixed set that ships with the code, so a new one appears after a deploy
 * without anyone doing anything), while ITEMS are inserted only when their section is empty.
 * An admin who has curated the hero carousel must not have it overwritten the next time
 * someone runs the seeder.
 *
 * Nothing here publishes. Seeding fills the draft; the first Publish in the admin portal is
 * what customers see.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { cmsAssets, cmsItems, cmsSections } from '@/db/schema/cms.js';
import type { CmsLink } from '@/db/schema/cms.js';
import { getSectionSpec } from '@/shared/cms/schema.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const HERE = dirname(fileURLToPath(import.meta.url));

type SeedItem = {
  key: string;
  gender?: 'her' | 'him' | 'all';
  assetKey: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  link: CmsLink | null;
  content: Record<string, unknown>;
};

type SeedSection = {
  key: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  kicker: string | null;
  ctaLabel: string | null;
  config: Record<string, unknown>;
  items: SeedItem[];
};

type SeedFile = { sections: SeedSection[] };

type AssetRow = { key: string; category: string; kind: 'image' | 'video' };

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(HERE, 'data', name), 'utf8')) as T;
}

export async function seedCmsHome(database: typeof Db): Promise<void> {
  const file = readJson<SeedFile>('cms-home.json');
  const assets = readJson<AssetRow[]>('cms-assets.json');

  // ── Assets: the admin picker's catalogue of bundled art. `previewUrl` is filled in later by
  // scripts/upload-cms-assets.mjs, so it is left alone on re-seed rather than reset to null. ──
  if (assets.length) {
    await database
      .insert(cmsAssets)
      .values(assets.map((a) => ({ key: a.key, category: a.category, kind: a.kind })))
      .onConflictDoUpdate({
        target: cmsAssets.key,
        set: { category: sql`excluded.category`, kind: sql`excluded.kind` },
      });
  }

  for (const section of file.sections) {
    // A section in the file that the catalogue does not declare would be unreachable from the
    // admin UI — no form to edit it, no tab to find it. Skip loudly rather than create a row
    // nobody can ever see.
    if (!getSectionSpec(section.key)) {
      console.warn(`  · skipping "${section.key}" — not in SECTION_SCHEMA`);
      continue;
    }

    const existing = await database.query.cmsSections.findFirst({
      where: eq(cmsSections.key, section.key),
    });

    let sectionId: string;
    if (existing) {
      sectionId = existing.id;
      // Only the type is reconciled. Copy, config and the enabled flag are an admin's to own
      // once the row exists — re-running the seeder must not revert their edits.
      if (existing.type !== section.type) {
        await database
          .update(cmsSections)
          .set({ type: section.type, updatedAt: new Date() })
          .where(eq(cmsSections.id, existing.id));
      }
    } else {
      sectionId = newId(IdPrefix.CmsSection);
      await database.insert(cmsSections).values({
        id: sectionId,
        key: section.key,
        type: section.type,
        title: section.title,
        subtitle: section.subtitle,
        kicker: section.kicker,
        ctaLabel: section.ctaLabel,
        config: section.config,
        isEnabled: true,
        sortOrder: file.sections.indexOf(section),
      });
    }

    const [count] = await database
      .select({ n: sql<number>`count(*)::int` })
      .from(cmsItems)
      .where(eq(cmsItems.sectionId, sectionId));
    if ((count?.n ?? 0) > 0) continue; // curated already — leave it alone
    if (section.items.length === 0) continue;

    await database.insert(cmsItems).values(
      section.items.map((item, index) => ({
        id: newId(IdPrefix.CmsItem),
        sectionId,
        key: item.key,
        gender: item.gender ?? 'all',
        sortOrder: index,
        assetKey: item.assetKey,
        imageUrl: item.imageUrl,
        videoUrl: item.videoUrl,
        link: item.link,
        content: item.content,
        isEnabled: true,
      })),
    );
  }
}
