/**
 * The retailer API must never return the proof-of-delivery secrets on an orders row:
 * `deliveryOtp` (the customer's door OTP) and `agentHandoffCode` (the driver's store handover
 * code). Covered: order detail + list, returns list + detail (which embed the order), held items.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import { heldItems, orderItems, orders } from '@/db/schema/index.js';
import { buildApp } from '@/app.js';
import { openReturn } from '@/shared/returns/open-return.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import {
  bearer,
  makeAccount,
  makeConsumer,
  makeStore,
  makeVariant,
} from './helpers/retailer-fixtures.js';

type App = ReturnType<typeof buildApp>;

const SECRET_OTP = 'SECRETOTP94817';
const SECRET_HANDOFF = 'SECRETHANDOFF5521';

let app: App;
let ownerToken: string;
let staffToken: string;
let orderId: string;
let returnId: string;
let heldId: string;

/** True when `key` appears as a property name anywhere in the (parsed) JSON. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}

function expectNoSecrets(res: { statusCode: number; body: string }) {
  expect(res.statusCode).toBe(200);
  const parsed = JSON.parse(res.body);
  expect(hasKeyDeep(parsed, 'deliveryOtp')).toBe(false);
  expect(hasKeyDeep(parsed, 'agentHandoffCode')).toBe(false);
  // and no copy of the values under any other name either
  expect(res.body).not.toContain(SECRET_OTP);
  expect(res.body).not.toContain(SECRET_HANDOFF);
  return parsed.data;
}

const get = (url: string, token = ownerToken) =>
  app.inject({ method: 'GET', url: `/api/v1${url}`, headers: bearer(token) });

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const storeId = await makeStore();
  ownerToken = (await makeAccount(storeId, 'owner')).token;
  staffToken = (await makeAccount(storeId, 'staff')).token;
  const { variantId } = await makeVariant(storeId, { stock: 100 });
  const consumer = await makeConsumer('Secret Buyer', '+919333300001');

  const placed = await app.inject({
    method: 'POST',
    url: '/api/v1/consumer/checkout',
    headers: bearer(consumer.token),
    payload: {
      storeId,
      items: [{ variantId, qty: 1 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId: consumer.addressId,
    },
  });
  expect(placed.statusCode).toBe(200);
  orderId = JSON.parse(placed.body).data.orderId;

  // Distinctive secrets so absence is meaningful (and a real OTP exists to leak).
  await db
    .update(orders)
    .set({
      deliveryOtp: SECRET_OTP,
      agentHandoffCode: SECRET_HANDOFF,
      status: 'delivered',
      deliveredAt: new Date(),
    })
    .where(eq(orders.id, orderId));
  const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) });
  await db.update(orderItems).set({ outcome: 'delivered_kept' }).where(eq(orderItems.id, item!.id));

  const opened = await openReturn(db, {
    orderId,
    items: [{ orderItemId: item!.id }],
    counterReturn: false,
    actor: { type: 'consumer', id: consumer.id },
  });
  returnId = opened.returnIds[0]!;

  heldId = newId(IdPrefix.HeldItem);
  await db.insert(heldItems).values({
    id: heldId,
    returnId,
    storeId,
    consumerId: consumer.id,
    status: 'holding',
    holdingWindowExpiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('retailer API never exposes deliveryOtp / agentHandoffCode', () => {
  it('the secrets really exist on the order row (so the assertions below mean something)', async () => {
    const row = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    expect(row).toMatchObject({ deliveryOtp: SECRET_OTP, agentHandoffCode: SECRET_HANDOFF });
  });

  it('GET /retailer/orders/:id', async () => {
    const data = expectNoSecrets(await get(`/retailer/orders/${orderId}`));
    // still the full detail the app renders
    expect(data).toMatchObject({ id: orderId, status: 'delivered' });
    expect(data.items).toHaveLength(1);
    expect(data).toHaveProperty('availableTransitions');
    expect(data).toHaveProperty('returns');
  });

  it('GET /retailer/orders (list), for owner and floor staff', async () => {
    for (const token of [ownerToken, staffToken]) {
      const data = expectNoSecrets(await get('/retailer/orders?statusIn=delivered', token));
      expect((data as Array<{ id: string }>).map((o) => o.id)).toContain(orderId);
    }
  });

  it('GET /retailer/returns (embeds the order)', async () => {
    const data = expectNoSecrets(await get('/retailer/returns'));
    const row = (data as Array<{ id: string; orderItem: { order: { id: string; storeId: string } } }>).find(
      (r) => r.id === returnId,
    );
    expect(row).toBeDefined();
    // the embedded order is still there with its useful, non-secret fields
    expect(row!.orderItem.order).toMatchObject({ id: orderId });
    expect(row!.orderItem.order).toHaveProperty('grandTotalPaise');
  });

  it('GET /retailer/returns/:id (embeds the order)', async () => {
    const data = expectNoSecrets(await get(`/retailer/returns/${returnId}`));
    expect(data.orderItem.order).toMatchObject({ id: orderId });
    expect(data.orderItem.order).toHaveProperty('storeId');
  });

  it('GET /retailer/held-items (return -> orderItem -> order)', async () => {
    const data = expectNoSecrets(await get('/retailer/held-items'));
    const row = (data as Array<{ id: string; return: { orderItem: { order: { id: string } } } }>).find(
      (h) => h.id === heldId,
    );
    expect(row).toBeDefined();
    expect(row!.return.orderItem.order.id).toBe(orderId);
  });

  it('GET /retailer/issues, /retailer/issues/:id and /retailer/disputes (an issue exists on the order)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/issues',
      headers: bearer(ownerToken),
      payload: { kind: 'query', orderId, subject: 'Secrets check', description: 'Order detail' },
    });
    expect(created.statusCode).toBe(200);
    const issueId = JSON.parse(created.body).data.issueId ?? JSON.parse(created.body).data.id;
    expect(issueId).toBeTruthy();

    const list = expectNoSecrets(await get('/retailer/issues'));
    expect((list as Array<{ id: string }>).map((i) => i.id)).toContain(issueId);
    expect(expectNoSecrets(await get(`/retailer/issues/${issueId}`))).toMatchObject({ orderId });
    expectNoSecrets(await get('/retailer/disputes'));
  });
});
