/**
 * POS returns / exchanges must not refund the same unit twice.
 *
 * Returned qty per original line is the sum over every completed (non-voided) return OR exchange
 * document, checked inside the transaction under a row lock on the original sale. 409
 * `pos_return_qty_exceeded` when requested + already returned > sold; idempotent replays are
 * answered before that check; GET /pos/sales/:id exposes returnedQty / returnableQty per line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import { posReturnLines, posSales, variants } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import { newId } from '@/shared/ids.js';
import {
  bearer,
  makeAccount,
  makeStore,
  makeVariant,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;
type Res = { statusCode: number; body: string };
const data = (res: Res) => JSON.parse(res.body).data;
const err = (res: Res) => JSON.parse(res.body).error;

type SaleItem = { id: string; variantId: string; qty: number; netLinePaise: number; returnedQty: number; returnableQty: number };

let app: App;
let ownerToken: string;
let staffToken: string;
let variantA: string;
let variantB: string;

const key = () => newId('idem');

async function sell(lines: Array<{ variantId: string; qty: number }>): Promise<string> {
  const quote = await app.inject({
    method: 'POST',
    url: '/api/v1/retailer/pos/quote',
    headers: bearer(ownerToken),
    payload: { lines },
  });
  expect(quote.statusCode).toBe(200);
  const payable = data(quote).payablePaise as number;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/retailer/pos/sales',
    headers: bearer(ownerToken),
    payload: {
      idempotencyKey: key(),
      lines,
      tenders: [{ method: 'cash', amountPaise: payable, tenderedPaise: payable }],
    },
  });
  expect(res.statusCode).toBe(200);
  return data(res).saleId as string;
}

const getSale = async (id: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/retailer/pos/sales/${id}`,
    headers: bearer(ownerToken),
  });
  expect(res.statusCode).toBe(200);
  return data(res) as { id: string; status: string; items: SaleItem[] };
};

const itemFor = (sale: { items: SaleItem[] }, variantId: string) =>
  sale.items.find((i) => i.variantId === variantId)!;

/** Pro-rata refund the server expects for `qty` units of a sold line. */
const refundFor = (item: SaleItem, qty: number) => Math.round((item.netLinePaise * qty) / item.qty);

function postReturn(
  saleId: string,
  lines: Array<{ originalSaleItemId: string; qty: number; restock?: boolean }>,
  items: SaleItem[],
  idempotencyKey = key(),
  token = ownerToken,
) {
  const refund = lines.reduce((s, l) => {
    const it = items.find((i) => i.id === l.originalSaleItemId)!;
    return s + refundFor(it, l.qty);
  }, 0);
  return app.inject({
    method: 'POST',
    url: `/api/v1/retailer/pos/sales/${saleId}/returns`,
    headers: bearer(token),
    payload: {
      idempotencyKey,
      reason: 'customer changed mind',
      lines,
      refundTenders: [{ method: 'cash', amountPaise: refund }],
    },
  });
}

/** Even swap: hand back `qty` of the original line, take `qty` of another (same price) variant. */
const postExchange = (
  saleId: string,
  item: SaleItem,
  qty: number,
  newVariantId: string,
  idempotencyKey = key(),
) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/retailer/pos/sales/${saleId}/exchange`,
    headers: bearer(ownerToken),
    payload: {
      idempotencyKey,
      reason: 'wrong size',
      returnLines: [{ originalSaleItemId: item.id, qty }],
      newLines: [{ variantId: newVariantId, qty }],
    },
  });

const stockOf = async (variantId: string) =>
  (await db.query.variants.findFirst({ where: eq(variants.id, variantId) }))!.stock;

const returnDocCount = async (originalSaleId: string) =>
  (await db.query.posSales.findMany({ where: eq(posSales.originalSaleId, originalSaleId) })).length;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const storeId = await makeStore({ posBillingEnabled: true });
  ownerToken = (await makeAccount(storeId, 'owner')).token;
  staffToken = (await makeAccount(storeId, 'staff')).token; // staff lack pos.refund by default
  // Same sticker price so an exchange between them nets to zero.
  ({ variantId: variantA } = await makeVariant(storeId, { stock: 500, pricePaise: 50_000, name: 'Tee A' }));
  ({ variantId: variantB } = await makeVariant(storeId, { stock: 500, pricePaise: 50_000, name: 'Tee B' }));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /retailer/pos/sales/:id — returned accounting', () => {
  it('keeps every existing field and adds returnedQty / returnableQty per line', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const sale = await getSale(saleId);
    expect(sale).toMatchObject({ id: saleId, status: 'completed' });
    expect(sale).toHaveProperty('payments');
    expect(sale).toHaveProperty('invoice');
    expect(sale).toHaveProperty('returnLines');
    const item = itemFor(sale, variantA);
    expect(item).toMatchObject({ qty: 3, returnedQty: 0, returnableQty: 3 });
    expect(item).toHaveProperty('netLinePaise');
    expect(item).toHaveProperty('listingNameSnap');
  });
});

describe('POST /retailer/pos/sales/:id/returns — no double refund', () => {
  it('partial return, then the remainder, then a third return is 409', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const stockBefore = await stockOf(variantA);

    const first = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items);
    expect(first.statusCode).toBe(200);
    expect(data(first).refundPaise).toBe(refundFor(item, 1));
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 1, returnableQty: 2 });

    const rest = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items);
    expect(rest.statusCode).toBe(200);
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 3, returnableQty: 0 });
    expect(await stockOf(variantA)).toBe(stockBefore + 3);

    const third = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items);
    expect(third.statusCode).toBe(409);
    expect(err(third).code).toBe('pos_return_qty_exceeded');
    expect(err(third).message).toMatch(/3 of 3 already returned, only 0 left/);
    expect(err(third).details).toMatchObject({
      originalSaleItemId: item.id,
      soldQty: 3,
      returnedQty: 3,
      returnableQty: 0,
      requestedQty: 1,
    });
    // the rejected return moved nothing
    expect(await stockOf(variantA)).toBe(stockBefore + 3);
    expect(await returnDocCount(saleId)).toBe(2);
  });

  it('asking for more than the remainder is 409 and tells how many are left', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items)).statusCode).toBe(200);

    const over = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items);
    expect(over.statusCode).toBe(409);
    expect(err(over).details).toMatchObject({ returnedQty: 2, returnableQty: 1, requestedQty: 2 });
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(200);
  });

  it('a single request cannot exceed the sold qty either (duplicate lines are summed) - 422', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const tooMany = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 4 }], items);
    expect(tooMany.statusCode).toBe(422);
    const split = await postReturn(
      saleId,
      [
        { originalSaleItemId: item.id, qty: 2 },
        { originalSaleItemId: item.id, qty: 2 },
      ],
      items,
    );
    expect(split.statusCode).toBe(422);
    expect(await returnDocCount(saleId)).toBe(0);
  });

  it('an idempotent replay returns the original result, even once the line is fully returned', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const k = key();
    const first = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items, k);
    expect(first.statusCode).toBe(200);
    const stockAfter = await stockOf(variantA);

    // line is now fully returned; a NEW key would be 409, the SAME key replays the original
    const again = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items, k);
    expect(again.statusCode).toBe(200);
    expect(data(again).returnSaleId).toBe(data(first).returnSaleId);
    expect(data(again).refundPaise).toBe(data(first).refundPaise);
    expect(data(again).refundPaise).toBeGreaterThan(0);
    expect(await stockOf(variantA)).toBe(stockAfter);
    expect(await returnDocCount(saleId)).toBe(1);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(409);
  });

  it('an idempotency key reused for a different sale is a conflict, not a replay', async () => {
    const saleOne = await sell([{ variantId: variantA, qty: 1 }]);
    const saleTwo = await sell([{ variantId: variantA, qty: 1 }]);
    const one = await getSale(saleOne);
    const two = await getSale(saleTwo);
    const k = key();
    expect((await postReturn(saleOne, [{ originalSaleItemId: one.items[0]!.id, qty: 1 }], one.items, k)).statusCode).toBe(200);
    const clash = await postReturn(saleTwo, [{ originalSaleItemId: two.items[0]!.id, qty: 1 }], two.items, k);
    expect(clash.statusCode).toBe(409);
    expect(err(clash).code).toBe('idempotency_conflict');
    expect(await returnDocCount(saleTwo)).toBe(0);
  });

  it('concurrent returns of the same units: exactly one wins, no double refund', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const stockBefore = await stockOf(variantA);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    expect(await stockOf(variantA)).toBe(stockBefore + 2);
    expect(await returnDocCount(saleId)).toBe(1);
    const lines = await db.select().from(posReturnLines);
    expect(lines.filter((l) => l.originalSaleItemId === item.id).reduce((s, l) => s + l.qty, 0)).toBe(2);
  });

  it('concurrent replays of the SAME key all succeed with one document', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items, k)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => data(r).returnSaleId)).size).toBe(1);
    expect(await returnDocCount(saleId)).toBe(1);
  });

  it('403 without pos.refund (floor staff); 404 for an unknown sale', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 1 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items, key(), staffToken)).statusCode).toBe(403);
    const missing = await postReturn('pos_nope', [{ originalSaleItemId: item.id, qty: 1 }], items);
    expect(missing.statusCode).toBe(404);
    expect(await returnDocCount(saleId)).toBe(0);
  });
});

describe('exchanges count towards returned qty', () => {
  it('exchange return half first, then a plain return of the rest, then 409', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);

    const ex = await postExchange(saleId, item, 2, variantB);
    expect(ex.statusCode).toBe(200);
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 2, returnableQty: 1 });

    const tooMuch = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items);
    expect(tooMuch.statusCode).toBe(409);
    expect(err(tooMuch).code).toBe('pos_return_qty_exceeded');
    expect(err(tooMuch).details).toMatchObject({ returnedQty: 2, returnableQty: 1 });

    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(200);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(409);
  });

  it('plain return first, then an exchange asking for more than is left is 409', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items)).statusCode).toBe(200);

    const stockB = await stockOf(variantB);
    const over = await postExchange(saleId, item, 2, variantB);
    expect(over.statusCode).toBe(409);
    expect(err(over).code).toBe('pos_return_qty_exceeded');
    // the rejected exchange sold nothing and returned nothing
    expect(await stockOf(variantB)).toBe(stockB);
    expect(await returnDocCount(saleId)).toBe(1);

    expect((await postExchange(saleId, item, 1, variantB)).statusCode).toBe(200);
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 3, returnableQty: 0 });
    expect((await postExchange(saleId, item, 1, variantB)).statusCode).toBe(409);
  });

  it('an idempotent exchange replay returns the original result without another exchange', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const k = key();
    const first = await postExchange(saleId, item, 2, variantB, k);
    expect(first.statusCode).toBe(200);
    const stockB = await stockOf(variantB);

    // fully returned now: a new key is 409, the same key replays
    expect((await postExchange(saleId, item, 1, variantB)).statusCode).toBe(409);
    const again = await postExchange(saleId, item, 2, variantB, k);
    expect(again.statusCode).toBe(200);
    expect(data(again)).toMatchObject({
      exchangeSaleId: data(first).exchangeSaleId,
      newInvoiceId: data(first).newInvoiceId,
      newInvoiceNumber: data(first).newInvoiceNumber,
      returnRefundPaise: data(first).returnRefundPaise,
      newPayablePaise: data(first).newPayablePaise,
      netPaise: data(first).netPaise,
    });
    expect(data(again).returnRefundPaise).toBeGreaterThan(0);
    expect(await stockOf(variantB)).toBe(stockB);
    expect(await returnDocCount(saleId)).toBe(1);
  });
});

describe('void keeps the returned accounting sane', () => {
  const voidSale = (saleId: string, reason = 'cashier error') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/retailer/pos/sales/${saleId}/void`,
      headers: bearer(ownerToken),
      payload: { reason },
    });

  it('a return document cannot be voided (it would re-open returnable qty without undoing the refund)', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const ret = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items);
    expect(ret.statusCode).toBe(200);

    const voided = await voidSale(data(ret).returnSaleId);
    expect(voided.statusCode).toBe(409);
    expect(err(voided).message).toMatch(/return or exchange cannot be voided/);
    expect((await db.query.posSales.findFirst({ where: eq(posSales.id, data(ret).returnSaleId) }))!.status).toBe('completed');
    // so the line stays fully returned and cannot be refunded again
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 2, returnableQty: 0 });
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(409);
  });

  it('an exchange document cannot be voided either', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 1 }]);
    const { items } = await getSale(saleId);
    const ex = await postExchange(saleId, itemFor({ items }, variantA), 1, variantB);
    expect(ex.statusCode).toBe(200);
    expect((await voidSale(data(ex).exchangeSaleId)).statusCode).toBe(409);
  });

  it('the original sale cannot be voided once part of it was returned (no double reversal)', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 3 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    expect((await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items)).statusCode).toBe(200);
    const stockBefore = await stockOf(variantA);

    const voided = await voidSale(saleId);
    expect(voided.statusCode).toBe(409);
    expect(err(voided).message).toMatch(/already has returns or exchanges/);
    expect(await stockOf(variantA)).toBe(stockBefore);
    expect((await getSale(saleId)).status).toBe('completed');
  });

  it('a sale with no returns still voids, and a voided sale cannot be returned against', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const stockBefore = await stockOf(variantA);

    expect((await voidSale(saleId)).statusCode).toBe(200);
    expect(await stockOf(variantA)).toBe(stockBefore + 2);
    expect((await getSale(saleId)).status).toBe('voided');

    const ret = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 1 }], items);
    expect(ret.statusCode).toBe(409);
    expect(err(ret).code).toBe('invalid_state');
    const ex = await postExchange(saleId, item, 1, variantB);
    expect(ex.statusCode).toBe(409);
  });

  it('a voided return document (legacy data) no longer counts as returned', async () => {
    const saleId = await sell([{ variantId: variantA, qty: 2 }]);
    const { items } = await getSale(saleId);
    const item = itemFor({ items }, variantA);
    const ret = await postReturn(saleId, [{ originalSaleItemId: item.id, qty: 2 }], items);
    // simulate a document voided before the guard existed
    await db.update(posSales).set({ status: 'voided' }).where(eq(posSales.id, data(ret).returnSaleId));
    expect(itemFor(await getSale(saleId), variantA)).toMatchObject({ returnedQty: 0, returnableQty: 2 });
  });
});
