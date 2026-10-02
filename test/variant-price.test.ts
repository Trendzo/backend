/**
 * A variant always has a real price. The default-variant and group-variant endpoints must
 * answer an unpriced request with a clear 422 — never reach the DB's price_paise > 0 CHECK
 * and surface as a 500. A listing without a variant is a valid draft in the meantime.
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
    legalName: 'Variant Price Store',
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
    email: `variantprice+${retailerId}@test.local`,
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
    slug: `variantprice-${categoryId.slice(-6)}`,
    label: 'Variant Price Category',
    gender: 'unisex',
  });
  token = signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' as const });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, headers: auth(token), payload }) as Promise<InjectRes>;
const put = (id: string, payload: object) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/retailer/listings/${id}/default-variant`,
    headers: auth(token),
    payload,
  }) as Promise<InjectRes>;
const newDraft = async (name: string) => {
  const res = await post('/api/v1/retailer/listings', { name, categoryId, gender: 'unisex' });
  expect(res.statusCode).toBe(200);
  return data(res).id as string;
};
const message = (res: InjectRes): string => JSON.stringify(JSON.parse(res.body));

describe('variant selling price', () => {
  it('a draft without a variant is valid', async () => {
    const id = await newDraft('Unpriced draft');
    const got = (await app.inject({
      method: 'GET',
      url: `/api/v1/retailer/listings/${id}`,
      headers: auth(token),
    })) as InjectRes;
    expect(got.statusCode).toBe(200);
    expect(data(got).status).toBe('draft');
  });

  it('default-variant: price 0, missing or negative is a 422 with a clear message, not a 500', async () => {
    const id = await newDraft('Priced later');
    for (const payload of [
      { pricePaise: 0, stock: 5 },
      { stock: 5 },
      { pricePaise: -100, stock: 5 },
    ]) {
      const res = await put(id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(message(res)).toContain('selling price');
    }
  });

  it('default-variant: a positive price creates then updates the variant, keeping stock', async () => {
    const id = await newDraft('Priced now');
    const first = await put(id, { pricePaise: 49900, stock: 7 });
    expect(first.statusCode).toBe(200);
    expect(data(first).pricePaise).toBe(49900);
    const again = await put(id, { pricePaise: 59900, stock: 9 });
    expect(again.statusCode).toBe(200);
    expect(data(again)).toMatchObject({ pricePaise: 59900, stock: 9 });
  });

  it('group variant create refuses price 0 with a 422 too', async () => {
    const id = await newDraft('Colour draft');
    const group = await post(`/api/v1/retailer/listings/${id}/groups`, { name: 'Black' });
    expect(group.statusCode).toBe(200);
    const gid = data(group).id as string;
    const res = await post(`/api/v1/retailer/listings/${id}/groups/${gid}/variants`, {
      size: 'M',
      pricePaise: 0,
      stock: 1,
    });
    expect(res.statusCode).toBe(422);
    expect(message(res)).toContain('selling price');
  });
});
