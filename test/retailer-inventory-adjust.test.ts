/**
 * POST /retailer/inventory/:variantId/adjust — floor-staff stock correction gated by
 * inventory.adjust (staff have it; they do NOT have listings.edit).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import { inventoryAdjustments, variants } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
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

const adjust = (variantId: string, payload: unknown, token = ownerToken) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/retailer/inventory/${variantId}/adjust`,
    headers: bearer(token),
    payload: payload as object,
  });

const row = async (variantId: string) => {
  const v = await db.query.variants.findFirst({ where: eq(variants.id, variantId) });
  return { stock: v!.stock, reserved: v!.reserved };
};

const lastAdjustment = (variantId: string) =>
  db.query.inventoryAdjustments.findFirst({
    where: eq(inventoryAdjustments.variantId, variantId),
    orderBy: desc(inventoryAdjustments.at),
  });

const adjustmentCount = async (variantId: string) =>
  (await db.query.inventoryAdjustments.findMany({ where: eq(inventoryAdjustments.variantId, variantId) }))
    .length;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  storeId = await makeStore();
  const owner = await makeAccount(storeId, 'owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  staffToken = (await makeAccount(storeId, 'staff')).token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('POST /retailer/inventory/:variantId/adjust — access', () => {
  it('401 anonymous, 403 without inventory.adjust', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const anon = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/inventory/${variantId}/adjust`,
      payload: { delta: 1, reason: 'audit_correction' },
    });
    expect(anon.statusCode).toBe(401);
    const denied = await adjust(variantId, { delta: 1, reason: 'audit_correction' }, tokenWithoutSubRole(ownerId));
    expect(denied.statusCode).toBe(403);
    expect((await row(variantId)).stock).toBe(10);
  });

  it('floor staff can adjust although they cannot edit listings (PATCH /variants/:id is 403)', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const res = await adjust(variantId, { delta: 3, reason: 'manual_edit' }, staffToken);
    expect(res.statusCode).toBe(200);
    expect(data(res).stock).toBe(13);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/retailer/variants/${variantId}`,
      headers: bearer(staffToken),
      payload: { stock: 99 },
    });
    expect(patch.statusCode).toBe(403);
    expect((await row(variantId)).stock).toBe(13);
  });
});

describe('POST /retailer/inventory/:variantId/adjust — validation (422)', () => {
  it.each([
    ['neither delta nor newStock', { reason: 'audit_correction' }],
    ['both delta and newStock', { delta: 1, newStock: 5, reason: 'audit_correction' }],
    ['unknown reason', { delta: 1, reason: 'damaged' }],
    ['free-text reason (belongs in note)', { delta: 1, reason: 'Found behind the counter' }],
    ['reason of a system-written kind', { delta: 1, reason: 'pos_sale' }],
    ['note longer than 200 chars', { delta: 1, reason: 'manual_edit', note: 'x'.repeat(201) }],
    ['non-string note', { delta: 1, note: 5 }],
    ['fractional delta', { delta: 1.5, reason: 'audit_correction' }],
    ['non-numeric delta', { delta: 'two', reason: 'audit_correction' }],
    ['negative newStock', { newStock: -1, reason: 'audit_correction' }],
    ['newStock beyond int4', { newStock: 2_147_483_648, reason: 'audit_correction' }],
  ])('rejects %s', async (_label, payload) => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const res = await adjust(variantId, payload);
    expect(res.statusCode).toBe(422);
    expect(err({ body: res.body }).code).toBe('validation_error');
    expect((await row(variantId)).stock).toBe(10);
  });

  it('422 when the resulting stock would overflow int4', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const res = await adjust(variantId, { delta: 2_147_483_647, reason: 'audit_correction' });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /retailer/inventory/:variantId/adjust — 404 and 409', () => {
  it('404 for an unknown variant and for another store\'s variant (untouched)', async () => {
    const otherStore = await makeStore();
    const { variantId: foreign } = await makeVariant(otherStore, { stock: 10 });
    const res = await adjust(foreign, { delta: 5, reason: 'audit_correction' });
    expect(res.statusCode).toBe(404);
    expect((await row(foreign)).stock).toBe(10);
    expect((await adjust('var_does_not_exist', { delta: 5, reason: 'audit_correction' })).statusCode).toBe(404);
  });

  it('409 when the result would drop below what is reserved (delta and newStock)', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10, reserved: 4 });
    const byDelta = await adjust(variantId, { delta: -7, reason: 'damage_writeoff' });
    expect(byDelta.statusCode).toBe(409);
    expect(err(byDelta).code).toBe('invalid_state');
    expect(err(byDelta).message).toMatch(/reserved \(4\)/);
    const byAbsolute = await adjust(variantId, { newStock: 3, reason: 'audit_correction' });
    expect(byAbsolute.statusCode).toBe(409);
    expect(await row(variantId)).toEqual({ stock: 10, reserved: 4 });
    expect(await adjustmentCount(variantId)).toBe(0);

    // exactly down to the reserved floor is allowed
    const atFloor = await adjust(variantId, { newStock: 4, reason: 'audit_correction' });
    expect(atFloor.statusCode).toBe(200);
    expect(await row(variantId)).toEqual({ stock: 4, reserved: 4 });
  });
});

describe('POST /retailer/inventory/:variantId/adjust — happy paths', () => {
  it('delta adjusts relative to current stock and records the adjustment', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const up = await adjust(variantId, { delta: 5, reason: 'manual_edit' });
    expect(up.statusCode).toBe(200);
    expect(data(up)).toMatchObject({ id: variantId, stock: 15, reserved: 0 });
    expect(data(up).adjustment).toMatchObject({ delta: 5, newStock: 15, reason: 'manual_edit' });

    const down = await adjust(variantId, { delta: -2, reason: 'damage_writeoff', note: 'dropped in the stockroom' });
    expect(data(down)).toMatchObject({ stock: 13 });

    const last = await lastAdjustment(variantId);
    expect(last).toMatchObject({
      delta: -2,
      newStock: 13,
      reason: 'damage_writeoff',
      actorKind: 'retailer',
      actorId: ownerId,
      note: 'dropped in the stockroom',
    });
    expect((await row(variantId)).stock).toBe(13);
  });

  it('newStock sets an absolute count; delta is derived', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const res = await adjust(variantId, { newStock: 4, reason: 'audit_correction' });
    expect(res.statusCode).toBe(200);
    expect(data(res).stock).toBe(4);
    expect(await lastAdjustment(variantId)).toMatchObject({
      delta: -6,
      newStock: 4,
      reason: 'audit_correction',
    });
    const zero = await adjust(variantId, { newStock: 0, reason: 'manual_edit' });
    expect(zero.statusCode).toBe(200);
    expect(await lastAdjustment(variantId)).toMatchObject({ delta: -4, newStock: 0, reason: 'manual_edit', note: null });
  });

  it('reason defaults to manual_edit; note is optional free text (blank note stored as null)', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const res = await adjust(variantId, { delta: 1, note: '  Found behind the counter  ' });
    expect(res.statusCode).toBe(200);
    expect(await lastAdjustment(variantId)).toMatchObject({
      reason: 'manual_edit',
      note: 'Found behind the counter',
    });
    expect(data(res).adjustment).toMatchObject({ reason: 'manual_edit' });

    await adjust(variantId, { delta: 1, reason: 'damage_writeoff', note: '   ' });
    expect(await lastAdjustment(variantId)).toMatchObject({ reason: 'damage_writeoff', note: null });
  });

  it('a no-op (result equals current stock) returns the row and writes nothing', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const same = await adjust(variantId, { newStock: 10, reason: 'audit_correction' });
    expect(same.statusCode).toBe(200);
    expect(data(same).stock).toBe(10);
    const zero = await adjust(variantId, { delta: 0, reason: 'audit_correction' });
    expect(zero.statusCode).toBe(200);
    expect(await adjustmentCount(variantId)).toBe(0);
  });

  it('concurrent adjustments serialise (no lost update, floor respected)', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => adjust(variantId, { delta: -3, reason: 'damage_writeoff' })),
    );
    const okCount = results.filter((r) => r.statusCode === 200).length;
    const conflicts = results.filter((r) => r.statusCode === 409).length;
    expect(okCount).toBe(3); // 10 -> 7 -> 4 -> 1, then -3 would go negative (below reserved 0)
    expect(conflicts).toBe(2);
    expect((await row(variantId)).stock).toBe(1);
  });

  it('shows up in GET /retailer/inventory/adjustments', async () => {
    const { variantId } = await makeVariant(storeId, { stock: 10 });
    await adjust(variantId, { delta: 2, reason: 'audit_correction' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/retailer/inventory/adjustments?variantId=${variantId}`,
      headers: bearer(ownerToken),
    });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toHaveLength(1);
    expect(data(res)[0]).toMatchObject({ delta: 2, newStock: 12, reason: 'audit_correction' });
  });
});
