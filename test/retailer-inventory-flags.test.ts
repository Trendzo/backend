/**
 * GET /retailer/inventory?flag=... — the stock-flag buckets are judged on AVAILABLE
 * stock (stock − reserved), matching the badge the app's InventoryRowCard shows. This
 * pins the fix for the old bug where `out`/`low` filtered on raw `stock`, so a
 * part-reserved variant fell under a different chip than its badge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '@/db/client.js';
import { buildApp } from '@/app.js';
import { bearer, makeAccount, makeStore, makeVariant } from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
const data = (res: { body: string }) => JSON.parse(res.body).data;

let app: App;
let token: string;
const V: Record<string, string> = {};

const list = (flag: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/retailer/inventory?flag=${flag}&pageSize=200`,
    headers: bearer(token),
  });

const idsUnder = async (flag: string): Promise<Set<string>> => {
  const res = await list(flag);
  expect(res.statusCode).toBe(200);
  return new Set((data(res).rows as { id: string }[]).map((r) => r.id));
};

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const storeId = await makeStore();
  token = (await makeAccount(storeId, 'owner')).token;

  // threshold = 5
  const settings = await app.inject({
    method: 'PATCH',
    url: '/api/v1/retailer/inventory/settings',
    headers: bearer(token),
    payload: { lowStockThreshold: 5 },
  });
  expect(settings.statusCode).toBe(200);

  // available = stock − reserved. A DB check (reserved <= stock) makes true oversold
  // unreachable, so there is no oversold row to seed.
  V.plenty = (await makeVariant(storeId, { stock: 10, reserved: 0 })).variantId; // avail 10 → in_stock
  V.lowReserved = (await makeVariant(storeId, { stock: 10, reserved: 7 })).variantId; // avail 3 → low + in_stock
  V.lowRaw = (await makeVariant(storeId, { stock: 4, reserved: 0 })).variantId; // avail 4 → low + in_stock
  V.outReserved = (await makeVariant(storeId, { stock: 5, reserved: 5 })).variantId; // avail 0 → out
  V.outZero = (await makeVariant(storeId, { stock: 0, reserved: 0 })).variantId; // avail 0 → out
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /retailer/inventory flag buckets use available stock', () => {
  it('in_stock = available > 0', async () => {
    expect(await idsUnder('in_stock')).toEqual(
      new Set([V.plenty, V.lowReserved, V.lowRaw]),
    );
  });

  it('low = 0 < available <= threshold (includes a fully-stocked-but-reserved variant)', async () => {
    const low = await idsUnder('low');
    expect(low).toEqual(new Set([V.lowReserved, V.lowRaw]));
    // Regression: raw stock (10) is above threshold; it is low only on available (3).
    expect(low.has(V.lowReserved)).toBe(true);
  });

  it('out = available <= 0 (reserved can take a stocked variant to zero)', async () => {
    const out = await idsUnder('out');
    expect(out).toEqual(new Set([V.outReserved, V.outZero]));
    // Regression: raw stock was 5, not 0, yet it is out once fully reserved.
    expect(out.has(V.outReserved)).toBe(true);
  });

  it('oversold is empty (reserved > stock is barred by a DB check)', async () => {
    expect((await idsUnder('oversold')).size).toBe(0);
  });

  it('all returns every variant', async () => {
    expect((await idsUnder('all')).size).toBe(5);
  });
});
