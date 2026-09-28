/**
 * descriptionLong is stored as sanitized HTML regardless of writer: plain text (retailer
 * app input, AI-drafted copy) is normalized to <p>/<ul> on write, HTML passes through the
 * sanitizer unchanged, and null clears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import { backfillLongDescriptionHtml } from '@/db/backfill-long-description-html.js';
import {
  categories,
  productListings,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;

let app: App;
let token: string;
let categoryId: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: 'Long Desc Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
  });
  await db.insert(retailerAccounts).values({
    id: retailerId,
    storeId,
    email: `longdesc+${retailerId}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: `+9194${Math.floor(10000000 + Math.random() * 89999999)}`,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId,
    slug: `longdesc-${categoryId.slice(-6)}`,
    label: 'Long Desc Category',
    gender: 'unisex',
  });
  token = signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' as const });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const create = (descriptionLong: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/retailer/listings',
    headers: auth(token),
    payload: { name: 'Kurta', categoryId, gender: 'unisex', descriptionLong },
  }) as Promise<InjectRes>;

const patch = (id: string, descriptionLong: string | null) =>
  app.inject({
    method: 'PATCH',
    url: `/api/v1/retailer/listings/${id}`,
    headers: auth(token),
    payload: { descriptionLong },
  }) as Promise<InjectRes>;

describe('listing descriptionLong storage', () => {
  it('normalizes plain text (paragraphs + bullets) to HTML on create', async () => {
    const res = await create('Easy kurta & more.\n\n• Soft cotton\n• Straight fit');
    expect(res.statusCode).toBe(200);
    expect(data(res).descriptionLong).toBe(
      '<p>Easy kurta &amp; more.</p><ul><li>Soft cotton</li><li>Straight fit</li></ul>',
    );
  });

  it('keeps HTML (web editor output) as sanitized HTML, and null clears on patch', async () => {
    const created = data(await create('Plain'));
    const html = '<p>Rich <strong>bold</strong></p><ul><li>one</li></ul>';
    const res = await patch(created.id, html);
    expect(res.statusCode).toBe(200);
    expect(data(res).descriptionLong).toBe(html);

    const cleared = await patch(created.id, null);
    expect(data(cleared).descriptionLong).toBeNull();
  });

  it('backfill converts legacy plain-text rows only, dry run writes nothing, re-run is a no-op', async () => {
    const created = data(await create('placeholder'));
    const htmlRow = data(await create('<p>already html</p>'));
    // Simulate a row saved before write-normalization existed.
    await db
      .update(productListings)
      .set({ descriptionLong: 'Old intro\n\n- a\n- b' })
      .where(eq(productListings.id, created.id));
    const read = async (id: string) =>
      (await db.query.productListings.findFirst({ where: eq(productListings.id, id) }))?.descriptionLong;

    const dry = await backfillLongDescriptionHtml(db, { apply: false, batchSize: 2 });
    expect(dry.converted).toBeGreaterThanOrEqual(1);
    expect(await read(created.id)).toBe('Old intro\n\n- a\n- b');

    await backfillLongDescriptionHtml(db, { apply: true, batchSize: 2 });
    expect(await read(created.id)).toBe('<p>Old intro</p><ul><li>a</li><li>b</li></ul>');
    expect(await read(htmlRow.id)).toBe('<p>already html</p>');

    const again = await backfillLongDescriptionHtml(db, { apply: true });
    expect(again.converted).toBe(0);
  });
});
