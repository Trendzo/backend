/**
 * DELETE /retailer/pos/sales/:id — discard a parked (held) bill. Held only; completed and
 * voided sales are immutable here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import { inventoryAdjustments, posSaleItems, posSales, variants } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import { newId } from '@/shared/ids.js';
import {
  bearer,
  makeAccount,
  makeStore,
  makeVariant,
  tokenWithoutSubRole,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
const data = (res: { body: string }) => JSON.parse(res.body).data;
const err = (res: { body: string }) => JSON.parse(res.body).error;

let app: App;
let storeId: string;
let ownerId: string;
let ownerToken: string;
let staffToken: string;
let variantId: string;

const hold = async (token = ownerToken) => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/retailer/pos/sales/hold',
    headers: bearer(token),
    payload: { idempotencyKey: newId('idem'), note: 'parked', lines: [{ variantId, qty: 2 }] },
  });
  expect(res.statusCode).toBe(200);
  return data(res).saleId as string;
};

const discard = (id: string, token = ownerToken) =>
  app.inject({ method: 'DELETE', url: `/api/v1/retailer/pos/sales/${id}`, headers: bearer(token) });

const heldIds = async (token = ownerToken) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/retailer/pos/held', headers: bearer(token) });
  expect(res.statusCode).toBe(200);
  return (data(res) as Array<{ id: string }>).map((r) => r.id);
};

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  storeId = await makeStore({ posBillingEnabled: true });
  const owner = await makeAccount(storeId, 'owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  staffToken = (await makeAccount(storeId, 'staff')).token;
  ({ variantId } = await makeVariant(storeId, { stock: 50 }));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('DELETE /retailer/pos/sales/:id', () => {
  it('401 anonymous; 403 without pos.sell; 403 when POS billing is off for the store', async () => {
    const id = await hold();
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/retailer/pos/sales/${id}` })).statusCode).toBe(401);
    expect((await discard(id, tokenWithoutSubRole(ownerId))).statusCode).toBe(403);

    const offStore = await makeStore({ posBillingEnabled: false });
    const off = await makeAccount(offStore, 'owner');
    const blocked = await discard(id, off.token);
    expect(blocked.statusCode).toBe(403);
    // none of the above touched the bill
    expect(await heldIds()).toContain(id);
  });

  it('discards a held bill (floor staff included) and moves nothing else', async () => {
    const id = await hold();
    const before = await db.query.variants.findFirst({ where: eq(variants.id, variantId) });
    expect(await heldIds()).toContain(id);

    const res = await discard(id, staffToken);
    expect(res.statusCode).toBe(200);
    expect(data(res)).toEqual({ id, discarded: true });

    expect(await heldIds()).not.toContain(id);
    expect(await db.query.posSales.findFirst({ where: eq(posSales.id, id) })).toBeUndefined();
    expect(await db.select().from(posSaleItems).where(eq(posSaleItems.saleId, id))).toHaveLength(0);
    const after = await db.query.variants.findFirst({ where: eq(variants.id, variantId) });
    expect({ stock: after!.stock, reserved: after!.reserved }).toEqual({
      stock: before!.stock,
      reserved: before!.reserved,
    });
    expect(
      await db.query.inventoryAdjustments.findMany({ where: eq(inventoryAdjustments.variantId, variantId) }),
    ).toHaveLength(0);

    // the sale is gone: GET and a second DELETE are 404
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/retailer/pos/sales/${id}`, headers: bearer(ownerToken) }))
        .statusCode,
    ).toBe(404);
    expect((await discard(id)).statusCode).toBe(404);
  });

  it('409 for a completed sale and for a voided sale (left untouched)', async () => {
    const completedId = await hold();
    const sale = await db.query.posSales.findFirst({ where: eq(posSales.id, completedId) });
    await db
      .update(posSales)
      .set({ status: 'completed', tenderedPaise: sale!.payablePaise, completedAt: new Date() })
      .where(eq(posSales.id, completedId));
    const res = await discard(completedId);
    expect(res.statusCode).toBe(409);
    expect(err(res).code).toBe('invalid_state');
    expect(err(res).message).toMatch(/completed/);

    const voidedId = await hold();
    await db
      .update(posSales)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: 'test' })
      .where(eq(posSales.id, voidedId));
    expect((await discard(voidedId)).statusCode).toBe(409);

    for (const id of [completedId, voidedId]) {
      expect(await db.query.posSales.findFirst({ where: eq(posSales.id, id) })).toBeDefined();
      expect(await db.select().from(posSaleItems).where(eq(posSaleItems.saleId, id))).not.toHaveLength(0);
    }
  });

  it('404 for an unknown id and for another store\'s held bill (untouched)', async () => {
    expect((await discard('pos_nope')).statusCode).toBe(404);

    const otherStore = await makeStore({ posBillingEnabled: true });
    const other = await makeAccount(otherStore, 'owner');
    const { variantId: otherVariant } = await makeVariant(otherStore, { stock: 5 });
    const held = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/pos/sales/hold',
      headers: bearer(other.token),
      payload: { idempotencyKey: newId('idem'), lines: [{ variantId: otherVariant, qty: 1 }] },
    });
    const foreignId = data(held).saleId as string;
    expect((await discard(foreignId)).statusCode).toBe(404);
    expect(await heldIds(other.token)).toContain(foreignId);
  });

  it('a discarded bill cannot be completed afterwards (hold id is gone)', async () => {
    const id = await hold();
    const payable = (await db.query.posSales.findFirst({ where: eq(posSales.id, id) }))!.payablePaise;
    expect((await discard(id)).statusCode).toBe(200);
    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/pos/sales',
      headers: bearer(ownerToken),
      payload: {
        idempotencyKey: newId('idem'),
        holdSaleId: id,
        lines: [{ variantId, qty: 2 }],
        tenders: [{ method: 'cash', amountPaise: payable, tenderedPaise: payable }],
      },
    });
    expect(complete.statusCode).toBe(404);
  });
});
