/**
 * Media migration runner against the real schema: discovery across jsonb + text columns,
 * dry-run probing, copy into the (memory) store, in-place rewrite that keeps column types,
 * and re-run idempotency. The network is a fake fetch — nothing leaves the process.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import { migrateMedia } from '@/db/migrate-media.js';
import { categories, cmsAssets, productListings, retailerStores } from '@/db/schema/index.js';
import { memoryObjects } from '@/shared/storage/drivers/memory.driver.js';
import { IdPrefix, newId } from '@/shared/ids.js';

// 1×1 PNG, so the memory driver's byte sniffing resolves a real image type.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const CLD = 'https://res.cloudinary.com/demo/image/upload/v1700000000/closetx/listings/kurta.png';
const CLD_DESC = 'https://res.cloudinary.com/demo/image/upload/v1700000001/closetx/desc/detail.png';
const CLD_ASSET = 'https://res.cloudinary.com/demo/image/upload/v1700000002/closetx/cms/banner.png';
const CF = 'https://dgwf2q4dx1fzq.cloudfront.net/uploads/2026/08/med_mig.png';
const UNSPLASH = 'https://images.unsplash.com/photo-1?w=900';
const GONE = 'https://res.cloudinary.com/demo/image/upload/v1/closetx/listings/gone.png';
// Same object as CLD — only the query differs, so it must share CLD's copy.
const CLD_QUERY = `${CLD}?mock=1786530890`;
// A PDF the CDN refuses unsigned (401); its original is readable via the signed fallback.
const PDF = 'https://res.cloudinary.com/demo/image/upload/v1700000003/closetx/applications/doc.pdf';
const SIGNED_PDF = 'https://api.cloudinary.test/v1_1/demo/image/download?public_id=doc&signature=x';
const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF\n');
const signedSourceUrl = (url: string) => (url === PDF ? SIGNED_PDF : null);

const NEW_CLD =
  'https://memory.test/legacy/cloudinary/demo/image/upload/v1700000000/closetx/listings/kurta.png';
const NEW_CLD_DESC =
  'https://memory.test/legacy/cloudinary/demo/image/upload/v1700000001/closetx/desc/detail.png';
const NEW_CLD_ASSET =
  'https://memory.test/legacy/cloudinary/demo/image/upload/v1700000002/closetx/cms/banner.png';
const NEW_CF = 'https://memory.test/uploads/2026/08/med_mig.png';
const NEW_PDF =
  'https://memory.test/legacy/cloudinary/demo/image/upload/v1700000003/closetx/applications/doc.pdf';

const DESC = (src: string) => `<p>Detail</p><img src="${src}" />`;

const calls: Array<{ url: string; method: string }> = [];
const fakeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? 'GET';
  calls.push({ url, method });
  if (url === GONE) return new Response(null, { status: 404 });
  if (url === PDF) return new Response(null, { status: 401 });
  if (url === SIGNED_PDF) {
    return new Response(new Uint8Array(PDF_BYTES), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    });
  }
  return new Response(method === 'HEAD' ? null : new Uint8Array(PNG), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
};

let listingId: string;
let assetKey: string;

const readListing = async () => {
  const row = await db.query.productListings.findFirst({
    where: eq(productListings.id, listingId),
  });
  return { gallery: row?.galleryUrls, desc: row?.descriptionLong };
};
const readAsset = async () =>
  (await db.query.cmsAssets.findFirst({ where: eq(cmsAssets.key, assetKey) }))?.previewUrl;

beforeAll(async () => {
  const storeId = newId(IdPrefix.Store);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: newId(IdPrefix.Retailer),
    legalName: 'Media Migration Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
  });
  const categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId,
    slug: `mediamig-${categoryId.slice(-6)}`,
    label: 'Media Migration Category',
    gender: 'unisex',
  });
  listingId = newId(IdPrefix.Listing);
  await db.insert(productListings).values({
    id: listingId,
    storeId,
    categoryId,
    name: 'Kurta',
    gender: 'unisex',
    galleryUrls: [CLD, CF, UNSPLASH, GONE, CLD_QUERY, PDF],
    descriptionLong: DESC(CLD_DESC),
  });
  assetKey = `mediamig/${listingId}`;
  await db.insert(cmsAssets).values({ key: assetKey, category: 'mediamig', previewUrl: CLD_ASSET });
});

afterAll(async () => {
  await pool.end();
});

describe('migrateMedia', () => {
  it('dry run probes with HEAD, reports unreachable sources and writes nothing', async () => {
    calls.length = 0;
    const stored = memoryObjects.size;
    const dry = await migrateMedia(db, { apply: false, fetchImpl: fakeFetch, signedSourceUrl });

    expect(dry.failed).toEqual([{ url: GONE, reason: 'HTTP 404' }]);
    expect(dry.reachable).toBeGreaterThanOrEqual(5);
    expect(dry.aliased).toBe(1);
    expect(dry.copied).toBe(0);
    expect(dry.rowsRewritten).toBe(0);
    for (const col of ['gallery_urls', 'description_long']) {
      expect(dry.columns).toContainEqual(
        expect.objectContaining({ table: 'product_listings', column: col }),
      );
    }
    expect(dry.columns).toContainEqual(
      expect.objectContaining({ table: 'cms_assets', column: 'preview_url' }),
    );
    expect(calls.map((c) => c.url)).not.toContain(UNSPLASH);
    expect(calls.map((c) => c.url)).not.toContain(CLD_QUERY);
    // Sources are only HEAD-probed; the signed download endpoint is GET-only.
    expect(calls.filter((c) => c.url !== SIGNED_PDF).every((c) => c.method === 'HEAD')).toBe(true);

    expect(memoryObjects.size).toBe(stored);
    expect(await readListing()).toEqual({
      gallery: [CLD, CF, UNSPLASH, GONE, CLD_QUERY, PDF],
      desc: DESC(CLD_DESC),
    });
    expect(await readAsset()).toBe(CLD_ASSET);
  });

  it('apply copies into the store and rewrites jsonb + text links, leaving the rest alone', async () => {
    const res = await migrateMedia(db, { apply: true, fetchImpl: fakeFetch, signedSourceUrl });

    expect(res.failed).toEqual([{ url: GONE, reason: 'HTTP 404' }]);
    expect(res.copied).toBeGreaterThanOrEqual(5);
    expect(res.aliased).toBe(1);
    expect(res.rowsRewritten).toBeGreaterThanOrEqual(2);

    // Gallery + description live on the same row: both must land (one UPDATE per row).
    expect(await readListing()).toEqual({
      gallery: [NEW_CLD, NEW_CF, UNSPLASH, GONE, NEW_CLD, NEW_PDF],
      desc: DESC(NEW_CLD_DESC),
    });
    expect(await readAsset()).toBe(NEW_CLD_ASSET);

    const typed = await db.execute(
      sql`select pg_typeof(gallery_urls)::text as t, jsonb_typeof(gallery_urls) as j
          from product_listings where id = ${listingId}`,
    );
    expect(typed.rows[0]).toEqual({ t: 'jsonb', j: 'array' });

    expect(memoryObjects.get('uploads/2026/08/med_mig.png')?.contentType).toBe('image/png');
    expect(
      memoryObjects.get(
        'legacy/cloudinary/demo/image/upload/v1700000000/closetx/listings/kurta.png',
      )?.body,
    ).toEqual(PNG);
    expect(
      memoryObjects.get(
        'legacy/cloudinary/demo/image/upload/v1700000003/closetx/applications/doc.pdf',
      ),
    ).toEqual({ body: PDF_BYTES, contentType: 'application/pdf' });
  });

  it('without a signed fallback a refused source is reported, not copied', async () => {
    await db
      .update(productListings)
      .set({ galleryUrls: [NEW_CLD, PDF] })
      .where(eq(productListings.id, listingId));
    const res = await migrateMedia(db, {
      apply: true,
      fetchImpl: fakeFetch,
      signedSourceUrl: () => null,
    });
    expect(res.failed).toContainEqual({ url: PDF, reason: 'HTTP 401' });
    expect((await readListing()).gallery).toEqual([NEW_CLD, PDF]);
    await db
      .update(productListings)
      .set({ galleryUrls: [NEW_CLD, NEW_CF, UNSPLASH, GONE] })
      .where(eq(productListings.id, listingId));
  });

  it('a re-run is a no-op: only the unreachable link is left to retry', async () => {
    const again = await migrateMedia(db, { apply: true, fetchImpl: fakeFetch, signedSourceUrl });
    expect(again.urls).toBe(1);
    expect(again.failed).toEqual([{ url: GONE, reason: 'HTTP 404' }]);
    expect(again.copied).toBe(0);
    expect(again.rowsRewritten).toBe(0);

    // Once the dead link is gone, nothing is left to migrate at all.
    await db
      .update(productListings)
      .set({ galleryUrls: [NEW_CLD, NEW_CF, UNSPLASH] })
      .where(eq(productListings.id, listingId));
    const done = await migrateMedia(db, { apply: true, fetchImpl: fakeFetch, signedSourceUrl });
    expect(done.urls).toBe(0);
    expect(done.rowsRewritten).toBe(0);
  });
});
