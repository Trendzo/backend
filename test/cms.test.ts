/**
 * Home CMS — the draft/publish split and the read-time filters.
 *
 * The behaviours worth locking down are the ones that are invisible until they are wrong:
 *   - editing changes a draft that customers cannot see; only publishing moves the public read
 *   - gender / publish-window / city filtering happens when a DEVICE reads, not when an admin
 *     publishes, which is the whole reason a campaign can be scheduled ahead of time
 *   - a city-restricted item is hidden from a caller with no city (fail closed, not open)
 *   - restore rewinds the draft without silently republishing
 *   - `support` can look but not publish
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import { adminAccounts, cmsItems, cmsPublications, cmsSections } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { invalidateCmsPublication } from '@/shared/cms/published.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;

let app: App;
let adminToken: string;
let supportToken: string;

/** A real section key from the catalogue — the API rejects anything else. */
const SECTION = 'home.steals';

const adminGet = (path: string, token = adminToken) =>
  app.inject({ method: 'GET', url: `/api/v1/admin/cms${path}`, headers: auth(token) });
const adminPost = (path: string, payload: unknown, token = adminToken) =>
  app.inject({ method: 'POST', url: `/api/v1/admin/cms${path}`, headers: auth(token), payload });
const publicGet = (query: string) =>
  app.inject({ method: 'GET', url: `/api/v1/cms/home${query}` });

async function seedSection() {
  const id = newId(IdPrefix.CmsSection);
  await db.insert(cmsSections).values({
    id,
    key: SECTION,
    type: 'bento_steals',
    title: 'STEALS',
    ctaLabel: 'ALL',
    config: {},
    isEnabled: true,
    sortOrder: 0,
  });
  return id;
}

/**
 * Insert straight to the DB so a test can set a window or city the API would also allow.
 *
 * Fixture copy is ASCII on purpose: the embedded Postgres the test harness boots runs WIN1252,
 * so a rupee sign fails to insert with "no equivalent in encoding". Production (Neon) is UTF8
 * and the real content does use the symbol — this is a harness limitation, not a product rule.
 */
async function addItem(
  sectionId: string,
  over: Partial<typeof cmsItems.$inferInsert> & { key: string },
) {
  await db.insert(cmsItems).values({
    id: newId(IdPrefix.CmsItem),
    sectionId,
    gender: 'all',
    sortOrder: 0,
    assetKey: 'steals/her/tops',
    content: { label: 'Tops', priceLine: 'Under Rs 1999' },
    isEnabled: true,
    ...over,
  });
}

function sectionOf(payload: { sections: { key: string; items: { key: string }[] }[] }) {
  return payload.sections.find((s) => s.key === SECTION);
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();

  const adminId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `cms-admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });
  adminToken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });

  const supportId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: supportId,
    email: `cms-support+${supportId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'support',
  });
  supportToken = signAccessToken({ sub: supportId, kind: 'admin', subRole: 'support' });
});

beforeEach(async () => {
  // Each test owns the whole CMS: the public read serves ONE latest publication, so leftovers
  // from a previous test would decide the answer.
  await db.delete(cmsPublications);
  await db.delete(cmsItems);
  await db.delete(cmsSections);
  invalidateCmsPublication();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('draft vs published', () => {
  it('serves nothing publicly until a publish happens, then serves the snapshot', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'steal-1', gender: 'her' });

    // Draft exists, but the public read has no publication to serve.
    const before = data(await publicGet('?gender=her'));
    expect(before.version).toBeNull();
    expect(before.sections).toHaveLength(0);

    const published = data(await adminPost('/publish', { note: 'first' }));
    expect(published.version).toBe(1);
    invalidateCmsPublication();

    const after = data(await publicGet('?gender=her'));
    expect(after.version).toBe(1);
    expect(sectionOf(after)?.items.map((i) => i.key)).toEqual(['steal-1']);
  });

  it('does not move the public read when the draft changes after publishing', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'steal-1', gender: 'her' });
    await adminPost('/publish', {});
    invalidateCmsPublication();

    await addItem(sectionId, { key: 'steal-2', gender: 'her', sortOrder: 1 });

    const live = data(await publicGet('?gender=her'));
    expect(sectionOf(live)?.items.map((i) => i.key)).toEqual(['steal-1']);

    // The draft preview shows the pending item, which is the point of having a preview.
    const preview = data(await adminGet('/preview?gender=her&source=draft'));
    expect(sectionOf(preview)?.items.map((i) => i.key)).toEqual(['steal-1', 'steal-2']);
  });
});

describe('read-time filtering', () => {
  it('filters by rail, keeping items marked for both', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'her-only', gender: 'her' });
    await addItem(sectionId, { key: 'him-only', gender: 'him', sortOrder: 1 });
    await addItem(sectionId, { key: 'both', gender: 'all', sortOrder: 2 });
    await adminPost('/publish', {});
    invalidateCmsPublication();

    const her = sectionOf(data(await publicGet('?gender=her')));
    expect(her?.items.map((i) => i.key)).toEqual(['her-only', 'both']);

    const him = sectionOf(data(await publicGet('?gender=him')));
    expect(him?.items.map((i) => i.key)).toEqual(['him-only', 'both']);
  });

  it('honours the publish window against the READ time, not the publish time', async () => {
    const sectionId = await seedSection();
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const hourAhead = new Date(Date.now() + 60 * 60_000);
    const twoHoursAhead = new Date(Date.now() + 120 * 60_000);

    await addItem(sectionId, { key: 'live-now', startsAt: hourAgo, endsAt: hourAhead });
    await addItem(sectionId, { key: 'not-yet', sortOrder: 1, startsAt: hourAhead, endsAt: twoHoursAhead });
    await addItem(sectionId, { key: 'expired', sortOrder: 2, startsAt: new Date(Date.now() - 120 * 60_000), endsAt: hourAgo });
    await addItem(sectionId, { key: 'always', sortOrder: 3 });

    // All four are published — scheduling is not a publish-time decision.
    const publishResult = data(await adminPost('/publish', {}));
    expect(publishResult.itemCount).toBe(4);
    invalidateCmsPublication();

    const now = sectionOf(data(await publicGet('?gender=her')));
    expect(now?.items.map((i) => i.key)).toEqual(['live-now', 'always']);
  });

  it('hides a city-restricted item from a caller whose city is unknown', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'everywhere', cities: null });
    await addItem(sectionId, { key: 'mumbai-only', sortOrder: 1, cities: ['Mumbai'] });
    await addItem(sectionId, { key: 'nowhere', sortOrder: 2, cities: [] });
    await adminPost('/publish', {});
    invalidateCmsPublication();

    const noCity = sectionOf(data(await publicGet('?gender=her')));
    expect(noCity?.items.map((i) => i.key)).toEqual(['everywhere']);

    // Case-insensitive, because the city string comes from a saved address, not a picker.
    const mumbai = sectionOf(data(await publicGet('?gender=her&city=mumbai')));
    expect(mumbai?.items.map((i) => i.key)).toEqual(['everywhere', 'mumbai-only']);

    const pune = sectionOf(data(await publicGet('?gender=her&city=Pune')));
    expect(pune?.items.map((i) => i.key)).toEqual(['everywhere']);
  });

  it('drops a disabled section entirely but keeps an emptied one', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'only', gender: 'him' });
    await adminPost('/publish', {});
    invalidateCmsPublication();

    // Section is on, but nothing matches this rail: the section still ships so the app can
    // render its own chrome and decide what an empty rail looks like.
    const her = sectionOf(data(await publicGet('?gender=her')));
    expect(her).toBeDefined();
    expect(her?.items).toHaveLength(0);

    await db.update(cmsSections).set({ isEnabled: false });
    await adminPost('/publish', {});
    invalidateCmsPublication();

    expect(sectionOf(data(await publicGet('?gender=him')))).toBeUndefined();
  });
});

describe('validation', () => {
  it('rejects an unknown section key', async () => {
    const res = await adminPost('/sections/not.a.section/items', {
      key: 'x',
      content: {},
      assetKey: 'steals/her/tops',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a content field the section does not declare', async () => {
    await seedSection();
    const res = await adminPost(`/sections/${SECTION}/items`, {
      key: 'bad-field',
      assetKey: 'steals/her/tops',
      content: { label: 'Tops', priceLine: 'Rs 999', nonsense: 'x' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error.message).toContain('nonsense');
  });

  it('rejects a link naming a route the app does not register', async () => {
    await seedSection();
    const res = await adminPost(`/sections/${SECTION}/items`, {
      key: 'bad-route',
      assetKey: 'steals/her/tops',
      content: { label: 'Tops', priceLine: 'Rs 999' },
      link: { route: 'NoSuchScreen' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('caps items PER RAIL, not across both', async () => {
    const sectionId = await seedSection();
    // Fill HER only. HIM must still have room — the two rails render independently.
    for (const key of ['a', 'b', 'c']) await addItem(sectionId, { key, gender: 'her' });

    const full = await adminPost(`/sections/${SECTION}/items`, {
      key: 'd',
      gender: 'her',
      assetKey: 'steals/her/tops',
      content: { label: 'Tops', priceLine: 'Rs 999' },
    });
    expect(full.statusCode).toBe(422);
    expect(JSON.parse(full.body).error.message).toContain('HER is full');

    const otherRail = await adminPost(`/sections/${SECTION}/items`, {
      key: 'him-1',
      gender: 'him',
      assetKey: 'steals/him/tee',
      content: { label: 'Tees', priceLine: 'Rs 999' },
    });
    expect(otherRail.statusCode).toBe(200);

    // An `all` item renders on BOTH rails, so a full HER blocks it even though HIM has room.
    const bothRails = await adminPost(`/sections/${SECTION}/items`, {
      key: 'shared',
      gender: 'all',
      assetKey: 'steals/her/tops',
      content: { label: 'Shared', priceLine: 'Rs 999' },
    });
    expect(bothRails.statusCode).toBe(422);
  });
});

describe('restore', () => {
  it('rewinds the draft to an old version without changing what is live', async () => {
    const sectionId = await seedSection();
    await addItem(sectionId, { key: 'v1-item' });
    await adminPost('/publish', { note: 'v1' });

    await db.delete(cmsItems);
    await addItem(sectionId, { key: 'v2-item' });
    const v2 = data(await adminPost('/publish', { note: 'v2' }));
    expect(v2.version).toBe(2);
    invalidateCmsPublication();

    const restore = data(await adminPost('/publications/1/restore', {}));
    expect(restore.restoredVersion).toBe(1);
    expect(restore.published).toBe(false);

    // Draft is back at v1 …
    const draft = data(await adminGet('/preview?gender=her&source=draft'));
    expect(sectionOf(draft)?.items.map((i) => i.key)).toEqual(['v1-item']);

    // … and customers are still on v2 until someone publishes again.
    invalidateCmsPublication();
    const live = data(await publicGet('?gender=her'));
    expect(live.version).toBe(2);
    expect(sectionOf(live)?.items.map((i) => i.key)).toEqual(['v2-item']);
  });
});

describe('seed content matches the catalogue', () => {
  /**
   * `data/cms-home.json` is a copy of the app's shipped content file, and the app renders it
   * verbatim when offline. If it names a section the catalogue does not declare, the seeder
   * skips it and that rail is silently empty on a fresh environment; if an item carries a
   * field the section does not declare, the admin form cannot edit it. Neither shows up
   * anywhere until someone looks at a phone, so it is asserted here.
   */
  it('every seeded section and item field is declared', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const { getSectionSpec } = await import('@/shared/cms/schema.js');

    const here = dirname(fileURLToPath(import.meta.url));
    const file = JSON.parse(
      readFileSync(join(here, '..', 'src', 'db', 'seed', 'data', 'cms-home.json'), 'utf8'),
    ) as {
      sections: {
        key: string;
        type: string;
        items: {
          key: string;
          gender?: 'her' | 'him' | 'all';
          content: Record<string, unknown>;
          link: unknown;
        }[];
      }[];
    };

    const problems: string[] = [];
    const seenKeys = new Set<string>();

    for (const section of file.sections) {
      const spec = getSectionSpec(section.key);
      if (!spec) {
        problems.push(`section "${section.key}" is not in SECTION_SCHEMA`);
        continue;
      }
      if (spec.type !== section.type) {
        problems.push(`section "${section.key}" type ${section.type} != catalogue ${spec.type}`);
      }
      // Caps are per rail, matching how the app renders — count each rail separately.
      for (const rail of ['her', 'him'] as const) {
        const onRail = section.items.filter(
          (i) => !spec.genderSplit || !i.gender || i.gender === rail || i.gender === 'all',
        ).length;
        if (onRail > spec.maxItems) {
          problems.push(
            `section "${section.key}" seeds ${onRail} items on ${rail}, cap is ${spec.maxItems}`,
          );
        }
        if (!spec.genderSplit) break; // one pass is enough when there is no rail split
      }

      const allowed = new Set(spec.itemFields.map((f) => f.key));
      for (const item of section.items) {
        const dupeKey = `${section.key}::${item.key}`;
        if (seenKeys.has(dupeKey)) problems.push(`duplicate item key ${dupeKey}`);
        seenKeys.add(dupeKey);

        for (const field of Object.keys(item.content ?? {})) {
          if (!allowed.has(field)) {
            problems.push(`"${section.key}" item "${item.key}" has undeclared field "${field}"`);
          }
        }
        if (item.link && !spec.link) {
          problems.push(`"${section.key}" item "${item.key}" has a link but the section is not tappable`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('permissions', () => {
  it('lets support read but not publish or edit', async () => {
    await seedSection();

    const read = await adminGet('/sections', supportToken);
    expect(read.statusCode).toBe(200);

    const publish = await adminPost('/publish', {}, supportToken);
    expect(publish.statusCode).toBe(403);

    const create = await adminPost(
      `/sections/${SECTION}/items`,
      { key: 'nope', assetKey: 'steals/her/tops', content: { label: 'x', priceLine: 'y' } },
      supportToken,
    );
    expect(create.statusCode).toBe(403);
  });
});
