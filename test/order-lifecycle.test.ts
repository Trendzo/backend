/**
 * Order/delivery lifecycle hardening — end-to-end over the embedded test Postgres.
 *
 *   WS1  money/stock correctness: cancellation refunds, COD payment truth, pickup
 *        counter-capture + stock finalize, door-return refund-on-arrival, restock.
 *   WS2  lifecycle sweeps: auto-close, stale payments, verification window,
 *        held-item warn/expire, dispatch rot, pickup no-show.
 *   WS3  reverse pickup: create-on-return, broadcast claim, collect,
 *        deliver-to-store window handoff, driver earnings coexistence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import {
  addresses,
  adminAccounts,
  categories,
  consumers,
  consumerWallets,
  deliveryAgents,
  driverCashLedger,
  driverEarnings,
  heldItems,
  consumerLoyalty,
  loyaltyTransactions,
  orderItems,
  orders,
  payments,
  platformConfig,
  productListings,
  promotionRedemptions,
  promotions,
  refundDisbursements,
  refunds,
  retailerAccounts,
  retailerStores,
  returns,
  reversePickups,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { createRefundForCancellation } from '@/shared/refunds/create-cancellation-refund.js';
import {
  sweepAutoCloseDelivered,
  sweepDispatchRot,
  sweepHeldItems,
  sweepPickupNoShows,
  sweepStalePayments,
  sweepVerificationWindows,
} from '@/shared/orders/lifecycle-sweeps.js';
import {
  failGatewayCheckout,
  settleGatewayCapture,
} from '@/shared/payments/settle-gateway.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = (res: InjectRes) => JSON.parse(res.body);
const data = (res: InjectRes) => json(res).data;

const PRICE = 50_000; // ₹500 per unit

let app: App;
let adminToken: string;
let storeId: string;
let retailerToken: string;
let consumerId: string;
let consumerToken: string;
let addressId: string;
let driverId: string;
let driverToken: string;
let driver2Token: string;
let variantId: string;

async function variantRow() {
  const v = await db.query.variants.findFirst({ where: eq(variants.id, variantId) });
  return { stock: v!.stock, reserved: v!.reserved };
}

async function orderRow(id: string) {
  const o = await db.query.orders.findFirst({ where: eq(orders.id, id) });
  if (!o) throw new Error(`order ${id} missing`);
  return o;
}

async function placeOrder(opts: {
  deliveryMethod: 'express' | 'standard' | 'pickup' | 'try_and_buy';
  paymentMethod: 'upi' | 'cod';
  paymentOutcome?: 'succeeded' | 'failed' | 'pending';
  applyWallet?: boolean;
}) {
  const isPickup = opts.deliveryMethod === 'pickup';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/consumer/checkout',
    headers: auth(consumerToken),
    payload: {
      storeId,
      items: [{ variantId, qty: 1 }],
      deliveryMethod: opts.deliveryMethod,
      paymentMethod: opts.paymentMethod,
      ...(isPickup
        ? {
            pickupSlotId: `slot_${Date.now()}`,
            pickupSlotStart: new Date(Date.now() + 3_600_000).toISOString(),
            pickupSlotEnd: new Date(Date.now() + 7_200_000).toISOString(),
          }
        : { addressId }),
      ...(opts.paymentOutcome ? { paymentOutcome: opts.paymentOutcome } : {}),
      ...(opts.applyWallet !== undefined ? { applyWallet: opts.applyWallet } : {}),
    },
  });
  expect(res.statusCode).toBe(200);
  return data(res) as { orderId: string; status: string };
}

const retailerPost = (path: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/retailer/orders${path}`,
    headers: auth(retailerToken),
    ...(payload !== undefined ? { payload } : { payload: {} }),
  });

const driverPost = (token: string, path: string, payload?: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/driver${path}`,
    headers: auth(token),
    ...(payload !== undefined ? { payload } : { payload: {} }),
  });

/** accept → pack, then a driver claims the offer and the store verifies the code. */
async function packAndPickUp(orderId: string) {
  expect((await retailerPost(`/${orderId}/accept`)).statusCode).toBe(200);
  expect((await retailerPost(`/${orderId}/pack`)).statusCode).toBe(200);
  expect((await driverPost(driverToken, `/offers/${orderId}/accept`)).statusCode).toBe(200);
  const code = (await orderRow(orderId)).agentHandoffCode;
  expect(code).toBeTruthy();
  const handover = await retailerPost(`/${orderId}/handover`, { handoffCode: code });
  expect(handover.statusCode).toBe(200);
  expect((await orderRow(orderId)).status).toBe('picked_up');
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  // The full seed carries UTF-8 rupee glyphs the Windows-locale embedded PG can't
  // store; sweeps/quote all have code fallbacks — only the payout table (asserted
  // on below) must exist as a real row.
  await db
    .insert(platformConfig)
    .values({
      key: 'driver_payout_table',
      value: { express: 4000, standard: 3000, pickup: 0, try_and_buy: 5000, reverse_pickup: 3000 },
      description: 'test payout table',
    })
    .onConflictDoNothing({ target: platformConfig.key });

  // admin
  const adminId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });
  adminToken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });

  // store + owner
  storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: `LE_${storeId}`,
    legalName: 'Lifecycle Test Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Test Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
  });
  await db.insert(retailerAccounts).values({
    id: retailerId,
    storeId,
    email: `owner+${retailerId}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: '+919000000001',
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  retailerToken = signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' });

  // consumer + address (at the store's coords)
  consumerId = newId(IdPrefix.Consumer);
  await db.insert(consumers).values({
    id: consumerId,
    phone: '+919000000002',
    name: 'Test Consumer',
    email: `c+${consumerId}@test.local`,
    status: 'active',
  });
  consumerToken = signAccessToken({ sub: consumerId, kind: 'consumer' });
  addressId = newId(IdPrefix.Address);
  await db.insert(addresses).values({
    id: addressId,
    consumerId,
    label: 'home',
    line1: '2 Consumer Lane',
    city: 'Mumbai',
    pincode: '400001',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    isDefault: true,
  });

  // drivers
  driverId = newId(IdPrefix.Driver);
  await db.insert(deliveryAgents).values({ id: driverId, phone: '+919000000003', name: 'Driver One' });
  driverToken = signAccessToken({ sub: driverId, kind: 'driver' });
  const driver2Id = newId(IdPrefix.Driver);
  await db.insert(deliveryAgents).values({ id: driver2Id, phone: '+919000000004', name: 'Driver Two' });
  driver2Token = signAccessToken({ sub: driver2Id, kind: 'driver' });

  // catalog: category → listing (active, returnable) → default group → variant
  const categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId,
    slug: `test-cat-${categoryId.slice(-6)}`,
    label: 'Test Category',
    gender: 'unisex',
  });
  const listingId = newId(IdPrefix.Listing);
  await db.insert(productListings).values({
    id: listingId,
    storeId,
    categoryId,
    name: 'Lifecycle Tee',
    gender: 'unisex',
    listingPolicy: 'return',
    status: 'active',
    variantMode: 'single',
  });
  const groupId = newId(IdPrefix.VariantGroup);
  await db.insert(variantGroups).values({
    id: groupId,
    listingId,
    storeId,
    name: 'Default',
    isDefault: true,
  });
  variantId = newId(IdPrefix.Variant);
  await db.insert(variants).values({
    id: variantId,
    listingId,
    storeId,
    groupId,
    attributes: {},
    attributesLabel: 'One size',
    stock: 1000,
    pricePaise: PRICE,
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/* ═══ WS1 — money/stock correctness ═══════════════════════════════════════ */

describe('WS1 — cancellation refunds', () => {
  it('prepaid order cancelled from routing → full refund tree + reservation release', async () => {
    const before = await variantRow();
    const { orderId, status } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    expect(status).toBe('routing');
    expect((await variantRow()).reserved).toBe(before.reserved + 1);

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: { reason: 'changed my mind' },
    });
    expect(cancel.statusCode).toBe(200);
    expect(data(cancel).refundId).toBeTruthy();

    const order = await orderRow(orderId);
    expect(order.status).toBe('cancelled');
    expect((await variantRow()).reserved).toBe(before.reserved);
    const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) });
    expect(item!.outcome).toBe('cancelled');

    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) });
    expect(refund).toBeTruthy();
    expect(refund!.totalRefundPaise).toBe(order.grandTotalPaise);
    expect(refund!.status).toBe('succeeded');
    const disb = await db.query.refundDisbursements.findMany({
      where: eq(refundDisbursements.refundId, refund!.id),
    });
    expect(disb).toHaveLength(1);
    expect(disb[0]!.destination).toBe('original_tender');
    expect(disb[0]!.gatewayRef).toMatch(/^REFUND-TEST-/);

    // second cancel → 409; refund helper re-run → null (idempotent base)
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
    expect(again.statusCode).toBe(409);
    const rerun = await createRefundForCancellation(db, {
      orderId,
      reason: 'order_cancelled:test-rerun',
      actor: { type: 'system', id: 'system' },
    });
    expect(rerun).toBeNull();
  });

  it('wallet + upi mix cancel → wallet CAS-credited back, remainder simulated', async () => {
    const walletId = newId(IdPrefix.WalletTx).replace(/^wtx_/, 'wlt_');
    await db.insert(consumerWallets).values({
      id: walletId,
      consumerId,
      balancePaise: 20_000,
      version: 0,
    });
    const { orderId } = await placeOrder({
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      applyWallet: true,
    });
    const midWallet = await db.query.consumerWallets.findFirst({
      where: eq(consumerWallets.id, walletId),
    });
    expect(midWallet!.balancePaise).toBe(0); // fully drawn at placement

    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);

    const wallet = await db.query.consumerWallets.findFirst({
      where: eq(consumerWallets.id, walletId),
    });
    expect(wallet!.balancePaise).toBe(20_000);
    const order = await orderRow(orderId);
    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) });
    expect(refund!.totalRefundPaise).toBe(order.grandTotalPaise);
    const disb = await db.query.refundDisbursements.findMany({
      where: eq(refundDisbursements.refundId, refund!.id),
    });
    const walletDisb = disb.find((d) => d.destination === 'wallet');
    const tenderDisb = disb.find((d) => d.destination === 'original_tender');
    expect(walletDisb!.amountPaise).toBe(20_000);
    expect(tenderDisb!.amountPaise).toBe(order.grandTotalPaise - 20_000);
    // Leave the wallet in place (wallet_transactions FK it) — later tests never
    // pass applyWallet, so the restored balance is inert.
  });
});

describe('WS1 — COD payment truth', () => {
  it('COD is born pending, order still routes; driver deliver settles COD- ref + codCollectedPaise', async () => {
    const before = await variantRow();
    const { orderId, status } = await placeOrder({
      deliveryMethod: 'standard',
      paymentMethod: 'cod',
      paymentOutcome: 'succeeded', // must be ignored for COD
    });
    expect(status).toBe('routing');
    let pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('pending');
    expect(pay!.gatewayRef).toBeNull();

    await packAndPickUp(orderId);
    expect((await driverPost(driverToken, `/deliveries/${orderId}/depart`)).statusCode).toBe(200);
    const deliver = await driverPost(driverToken, `/deliveries/${orderId}/deliver`, { otp: '1111' });
    expect(deliver.statusCode).toBe(200);

    const order = await orderRow(orderId);
    expect(order.status).toBe('delivered');
    pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('succeeded');
    expect(pay!.gatewayRef).toMatch(/^COD-/);
    expect(pay!.settledAt).toBeTruthy();
    expect(order.codCollectedPaise).toBe(pay!.amountPaise);

    const after = await variantRow();
    expect(after.stock).toBe(before.stock - 1);
    expect(after.reserved).toBe(before.reserved);

    const earning = await db.query.driverEarnings.findFirst({
      where: and(eq(driverEarnings.orderId, orderId), eq(driverEarnings.driverId, driverId)),
    });
    expect(earning).toBeTruthy();
  });

  it('COD cancel pre-delivery → no refund rows, payment flipped to failed', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'cod' });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
    expect(cancel.statusCode).toBe(200);
    expect(data(cancel).refundId).toBeNull();
    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) });
    expect(refund).toBeUndefined();
    const pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('failed');
    expect(pay!.failureCode).toBe('order_cancelled');
  });
});

describe('WS1 — pickup counter capture', () => {
  it('pickup handover finalizes stock and settles COD with a COUNTER- ref; wrong code settles nothing', async () => {
    const before = await variantRow();
    const { orderId } = await placeOrder({ deliveryMethod: 'pickup', paymentMethod: 'cod' });
    expect((await retailerPost(`/${orderId}/accept`)).statusCode).toBe(200);
    expect((await retailerPost(`/${orderId}/pack`)).statusCode).toBe(200);

    const wrong = await retailerPost(`/${orderId}/pickup-handover`, { pickupCode: 'WRONG1' });
    expect(wrong.statusCode).toBe(400);
    let pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('pending');

    const code = (await orderRow(orderId)).pickupCode!;
    const okRes = await retailerPost(`/${orderId}/pickup-handover`, { pickupCode: code });
    expect(okRes.statusCode).toBe(200);

    const order = await orderRow(orderId);
    expect(order.status).toBe('delivered');
    pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('succeeded');
    expect(pay!.gatewayRef).toMatch(/^COUNTER-/);
    expect(order.codCollectedPaise).toBe(pay!.amountPaise);

    const after = await variantRow();
    expect(after.stock).toBe(before.stock - 1);
    expect(after.reserved).toBe(before.reserved);
  });
});

describe('WS1 — door-return refund on arrival', () => {
  it('all-returned try&buy: driver markReturned → auto-accept + refund + reservation release + fully_returned cancel', async () => {
    const before = await variantRow();
    const { orderId } = await placeOrder({ deliveryMethod: 'try_and_buy', paymentMethod: 'upi' });
    await packAndPickUp(orderId);
    expect((await driverPost(driverToken, `/deliveries/${orderId}/depart`)).statusCode).toBe(200);
    expect((await driverPost(driverToken, `/deliveries/${orderId}/door/open`)).statusCode).toBe(200);
    const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) });
    const close = await driverPost(driverToken, `/deliveries/${orderId}/door/close`, {
      otp: '1111',
      items: [{ orderItemId: item!.id, decision: 'returned' }],
    });
    expect(close.statusCode).toBe(200);
    expect((await orderRow(orderId)).status).toBe('returning_to_store');

    const arrived = await driverPost(driverToken, `/deliveries/${orderId}/returned`);
    expect(arrived.statusCode).toBe(200);

    const order = await orderRow(orderId);
    expect(order.status).toBe('cancelled'); // fully_returned terminalization
    const ret = await db.query.returns.findFirst({ where: eq(returns.orderItemId, item!.id) });
    expect(ret!.storeDecision).toBe('accepted'); // auto-accepted on arrival
    const orderRefunds = await db.query.refunds.findMany({ where: eq(refunds.orderId, orderId) });
    expect(orderRefunds.length).toBeGreaterThanOrEqual(1);
    const totalRefunded = orderRefunds.reduce((s, r) => s + r.totalRefundPaise, 0);
    expect(totalRefunded).toBe(order.grandTotalPaise); // per-return + fees top-up = money truth

    const after = await variantRow();
    expect(after.stock).toBe(before.stock); // goods never left inventory count
    expect(after.reserved).toBe(before.reserved); // reservation released

    // a later manual verify loses cleanly
    const verify = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/returns/${ret!.id}/verify`,
      headers: auth(retailerToken),
      payload: { decision: 'accepted' },
    });
    expect(verify.statusCode).toBe(409);
  });
});

describe('WS1 — standard return restock', () => {
  it('accepted standard return puts stock back', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    expect((await retailerPost(`/${orderId}/accept`)).statusCode).toBe(200);
    expect((await retailerPost(`/${orderId}/pack`)).statusCode).toBe(200);
    expect((await retailerPost(`/${orderId}/handover`, { agentName: 'Ext', agentPhone: '+911111111111' })).statusCode).toBe(200);
    expect((await retailerPost(`/${orderId}/depart`)).statusCode).toBe(200);
    expect((await retailerPost(`/${orderId}/mark-delivered`, {})).statusCode).toBe(200);
    const afterDeliver = await variantRow();

    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/returns',
      headers: auth(consumerToken),
      payload: {
        orderId,
        items: [
          { orderItemId: (await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) }))!.id },
        ],
      },
    });
    expect(open.statusCode).toBe(200);
    const returnId = (data(open).returnIds as string[])[0]!;

    const verify = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/returns/${returnId}/verify`,
      headers: auth(retailerToken),
      payload: { decision: 'accepted' },
    });
    expect(verify.statusCode).toBe(200);
    expect(data(verify).refundId).toBeTruthy();

    const after = await variantRow();
    expect(after.stock).toBe(afterDeliver.stock + 1); // restocked
    expect(after.reserved).toBe(afterDeliver.reserved);
  });
});

/* ═══ WS2 — lifecycle sweeps ══════════════════════════════════════════════ */

describe('WS2 — sweeps', () => {
  it('auto-close: delivered past window closes; pending-return order does not', async () => {
    // closable order
    const a = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    await retailerPost(`/${a.orderId}/accept`);
    await retailerPost(`/${a.orderId}/pack`);
    await retailerPost(`/${a.orderId}/handover`, { agentName: 'Ext', agentPhone: '+911111111111' });
    await retailerPost(`/${a.orderId}/depart`);
    await retailerPost(`/${a.orderId}/mark-delivered`, {});
    await db
      .update(orders)
      .set({ deliveredAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(orders.id, a.orderId));

    // holdout: same but with a pending return
    const b = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    await retailerPost(`/${b.orderId}/accept`);
    await retailerPost(`/${b.orderId}/pack`);
    await retailerPost(`/${b.orderId}/handover`, { agentName: 'Ext', agentPhone: '+911111111111' });
    await retailerPost(`/${b.orderId}/depart`);
    await retailerPost(`/${b.orderId}/mark-delivered`, {});
    const bItem = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, b.orderId) });
    await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/returns',
      headers: auth(consumerToken),
      payload: { orderId: b.orderId, items: [{ orderItemId: bItem!.id }] },
    });
    await db
      .update(orders)
      .set({ deliveredAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(orders.id, b.orderId));

    const closed = await sweepAutoCloseDelivered(db);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect((await orderRow(a.orderId)).status).toBe('closed');
    expect((await orderRow(b.orderId)).status).toBe('delivered'); // held out
  });

  it('stale-pending: unpaid pending order cancelled + reservations freed; paid one untouched', async () => {
    const before = await variantRow();
    const stale = await placeOrder({
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      paymentOutcome: 'pending',
    });
    expect(stale.status).toBe('pending');
    await db
      .update(orders)
      .set({ placedAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(orders.id, stale.orderId));

    const paid = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });

    const r = await sweepStalePayments(db);
    expect(r.pendingCancelled).toBeGreaterThanOrEqual(1);
    expect((await orderRow(stale.orderId)).status).toBe('cancelled');
    expect((await orderRow(paid.orderId)).status).toBe('routing');
    // stale order's reservation freed; paid one still holds its own
    expect((await variantRow()).reserved).toBe(before.reserved + 1);

    await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${paid.orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
  });

  it('verification window: mark-received starts the clock; expiry auto-accepts + refunds', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    await retailerPost(`/${orderId}/accept`);
    await retailerPost(`/${orderId}/pack`);
    await retailerPost(`/${orderId}/handover`, { agentName: 'Ext', agentPhone: '+911111111111' });
    await retailerPost(`/${orderId}/depart`);
    await retailerPost(`/${orderId}/mark-delivered`, {});
    const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) });
    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/returns',
      headers: auth(consumerToken),
      payload: { orderId, items: [{ orderItemId: item!.id }] },
    });
    const returnId = (data(open).returnIds as string[])[0]!;

    const received = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/returns/${returnId}/mark-received`,
      headers: auth(retailerToken),
      payload: {},
    });
    expect(received.statusCode).toBe(200);

    await db
      .update(returns)
      .set({ verificationWindowExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(returns.id, returnId));
    const accepted = await sweepVerificationWindows(db);
    expect(accepted).toBeGreaterThanOrEqual(1);
    const ret = await db.query.returns.findFirst({ where: eq(returns.id, returnId) });
    expect(ret!.storeDecision).toBe('accepted');
    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) });
    expect(refund).toBeTruthy();
  });

  it('held items: warn once (dedupe) then expire', async () => {
    // build a held item: deliver → return → retailer verify REJECT is admin-only shelving,
    // so use verifyReturn's rejected path via the retailer decline? decline opens a dispute;
    // simplest held item: verify rejected through the shared path — insert directly instead.
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    await retailerPost(`/${orderId}/accept`);
    await retailerPost(`/${orderId}/pack`);
    await retailerPost(`/${orderId}/handover`, { agentName: 'Ext', agentPhone: '+911111111111' });
    await retailerPost(`/${orderId}/depart`);
    await retailerPost(`/${orderId}/mark-delivered`, {});
    const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, orderId) });
    const rid = newId(IdPrefix.Return);
    await db.insert(returns).values({
      id: rid,
      orderItemId: item!.id,
      kind: 'standard_return',
      storeDecision: 'rejected',
      storeDecidedAt: new Date(),
    });
    const heldId = newId(IdPrefix.HeldItem);
    await db.insert(heldItems).values({
      id: heldId,
      returnId: rid,
      storeId,
      consumerId,
      status: 'holding',
      holdingWindowExpiresAt: new Date(Date.now() + 86_400_000), // 1 day out (< 3-day warn horizon)
    });

    const first = await sweepHeldItems(db);
    expect(first.warned).toBeGreaterThanOrEqual(1);
    const second = await sweepHeldItems(db);
    expect(second.warned).toBe(0); // stamped — no re-warn

    await db
      .update(heldItems)
      .set({ holdingWindowExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(heldItems.id, heldId));
    const third = await sweepHeldItems(db);
    expect(third.expired).toBeGreaterThanOrEqual(1);
    const h = await db.query.heldItems.findFirst({ where: eq(heldItems.id, heldId) });
    expect(h!.status).toBe('expired');
    const it2 = await db.query.orderItems.findFirst({ where: eq(orderItems.id, item!.id) });
    expect(it2!.outcome).toBe('held_window_expired');
  });

  it('dispatch rot: unassigned alert stamps once; stale claim auto-unassigns back to pool', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    await retailerPost(`/${orderId}/accept`);
    await retailerPost(`/${orderId}/pack`);
    await db
      .update(orders)
      .set({ packedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(orders.id, orderId));

    const r1 = await sweepDispatchRot(db);
    expect(r1.alerts).toBeGreaterThanOrEqual(1);
    expect((await orderRow(orderId)).dispatchAlertNotifiedAt).toBeTruthy();
    const r2 = await sweepDispatchRot(db);
    expect(r2.alerts).toBe(0); // dedupe

    // stale claim
    expect((await driverPost(driverToken, `/offers/${orderId}/accept`)).statusCode).toBe(200);
    await db
      .update(orders)
      .set({ agentAssignedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(orders.id, orderId));
    const r3 = await sweepDispatchRot(db);
    expect(r3.unassigned).toBeGreaterThanOrEqual(1);
    const o = await orderRow(orderId);
    expect(o.assignedAgentId).toBeNull();
    expect(o.agentHandoffCode).toBeNull();
    expect(o.agentAssignedAt).toBeNull();

    await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    }).catch(() => undefined); // packed → consumer can't cancel; leave for admin (cleanup best-effort)
  });

  it('pickup no-show: uncollected pickup order cancelled with refund path', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'pickup', paymentMethod: 'upi' });
    await retailerPost(`/${orderId}/accept`);
    await retailerPost(`/${orderId}/pack`);
    await db
      .update(orders)
      .set({
        packedAt: new Date(Date.now() - 4 * 86_400_000),
        pickupSlotEnd: new Date(Date.now() - 4 * 86_400_000),
      })
      .where(eq(orders.id, orderId));
    const cancelled = await sweepPickupNoShows(db);
    expect(cancelled).toBeGreaterThanOrEqual(1);
    const o = await orderRow(orderId);
    expect(o.status).toBe('cancelled');
    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, orderId) });
    expect(refund).toBeTruthy(); // prepaid pickup refunded on no-show cancel
  });
});

/* ═══ WS3 — reverse pickup ════════════════════════════════════════════════ */

describe('WS3 — reverse pickup', () => {
  let rpOrderId: string;
  let rpTaskId: string;
  let rpReturnId: string;

  it('consumer return on a driver-delivered order creates a broadcast task with OTP', async () => {
    // full driver delivery (so a forward earning exists on this order)
    const placed = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    rpOrderId = placed.orderId;
    await packAndPickUp(rpOrderId);
    expect((await driverPost(driverToken, `/deliveries/${rpOrderId}/depart`)).statusCode).toBe(200);
    expect(
      (await driverPost(driverToken, `/deliveries/${rpOrderId}/deliver`, { otp: '1111' })).statusCode,
    ).toBe(200);

    const item = await db.query.orderItems.findFirst({ where: eq(orderItems.orderId, rpOrderId) });
    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/returns',
      headers: auth(consumerToken),
      payload: { orderId: rpOrderId, items: [{ orderItemId: item!.id }] },
    });
    expect(open.statusCode).toBe(200);
    expect(data(open).reversePickupId).toBeTruthy();
    rpTaskId = data(open).reversePickupId as string;
    rpReturnId = (data(open).returnIds as string[])[0]!;

    // consumer sees the task + OTP on their returns list
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/consumer/returns',
      headers: auth(consumerToken),
    });
    const row = (data(list) as Array<{ id: string; reversePickup: { id: string; collectOtp: string | null } | null }>).find(
      (r) => r.id === rpReturnId,
    );
    expect(row!.reversePickup!.id).toBe(rpTaskId);
    expect(row!.reversePickup!.collectOtp).toMatch(/^\d{6}$/);

    // task is in the broadcast pool
    const offers = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/reverse-pickups/offers',
      headers: auth(driverToken),
    });
    expect((data(offers) as Array<{ id: string }>).some((t) => t.id === rpTaskId)).toBe(true);
  });

  it('claim race: exactly one of two drivers wins', async () => {
    const [r1, r2] = await Promise.all([
      driverPost(driverToken, `/reverse-pickups/${rpTaskId}/accept`),
      driverPost(driver2Token, `/reverse-pickups/${rpTaskId}/accept`),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 409]);
  });

  it('collect (OTP+photo) → deliver-to-store starts the verify window + pays the reverse leg', async () => {
    const task = await db.query.reversePickups.findFirst({ where: eq(reversePickups.id, rpTaskId) });
    const winnerToken = task!.assignedDriverId === driverId ? driverToken : driver2Token;

    const collect = await driverPost(winnerToken, `/reverse-pickups/${rpTaskId}/collect`, {
      otp: '1111',
      photos: ['https://example.com/proof.jpg'],
    });
    expect(collect.statusCode).toBe(200);

    const deliver = await driverPost(winnerToken, `/reverse-pickups/${rpTaskId}/deliver-to-store`);
    expect(deliver.statusCode).toBe(200);

    const ret = await db.query.returns.findFirst({ where: eq(returns.id, rpReturnId) });
    expect(ret!.verificationWindowExpiresAt).toBeTruthy();
    const hoursOut = (ret!.verificationWindowExpiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hoursOut).toBeGreaterThan(23);
    expect(hoursOut).toBeLessThan(25);

    // reverse earning coexists with the forward earning on the SAME order
    const earnings = await db.query.driverEarnings.findMany({
      where: eq(driverEarnings.orderId, rpOrderId),
    });
    expect(earnings).toHaveLength(2);
    const reverse = earnings.find((e) => e.deliveryMethod === 'reverse_pickup');
    expect(reverse!.reversePickupId).toBe(rpTaskId);
    expect(reverse!.basePaise).toBe(3000); // seeded driver_payout_table.reverse_pickup
  });

  it('store rot after arrival → verification sweep auto-accepts + refunds (full loop)', async () => {
    await db
      .update(returns)
      .set({ verificationWindowExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(returns.id, rpReturnId));
    const accepted = await sweepVerificationWindows(db);
    expect(accepted).toBeGreaterThanOrEqual(1);
    const ret = await db.query.returns.findFirst({ where: eq(returns.id, rpReturnId) });
    expect(ret!.storeDecision).toBe('accepted');
    const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, rpOrderId) });
    expect(refund).toBeTruthy();
  });
});

/* ═══ Multi-retailer cart split ═══════════════════════════════════════════ */

describe('group checkout — one cart, N stores, one group', () => {
  let store2Id: string;
  let variant2Id: string;
  let zeroStockVariantId: string;
  let groupKey: string;
  let firstGroupId: string;

  const groupPlace = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/consumer/checkout/group',
      headers: auth(consumerToken),
      payload,
    });

  it('setup: a second store with its own catalog', async () => {
    store2Id = newId(IdPrefix.Store);
    await db.insert(retailerStores).values({
      id: store2Id,
      legalEntityId: `LE_${store2Id}`,
      legalName: 'Second Test Store',
      gstin: '27AAFCK9999M1Z5',
      address: '9 Other Rd, Mumbai, MH',
      stateCode: 'MH',
      lat: 19.07,
      lng: 72.84,
      status: 'active',
      platformFeeBp: 200,
    });
    const catId = newId(IdPrefix.Category);
    await db.insert(categories).values({
      id: catId,
      slug: `cat2-${catId.slice(-6)}`,
      label: 'Cat 2',
      gender: 'unisex',
    });
    const listing2 = newId(IdPrefix.Listing);
    await db.insert(productListings).values({
      id: listing2,
      storeId: store2Id,
      categoryId: catId,
      name: 'Second Store Kurta',
      gender: 'unisex',
      listingPolicy: 'return',
      status: 'active',
      variantMode: 'single',
    });
    const group2 = newId(IdPrefix.VariantGroup);
    await db.insert(variantGroups).values({
      id: group2,
      listingId: listing2,
      storeId: store2Id,
      name: 'Default',
      isDefault: true,
    });
    variant2Id = newId(IdPrefix.Variant);
    await db.insert(variants).values({
      id: variant2Id,
      listingId: listing2,
      storeId: store2Id,
      groupId: group2,
      attributes: {},
      attributesLabel: 'One size',
      stock: 1000,
      pricePaise: 30_000,
    });
    zeroStockVariantId = newId(IdPrefix.Variant);
    await db.insert(variants).values({
      id: zeroStockVariantId,
      listingId: listing2,
      storeId: store2Id,
      groupId: group2,
      attributes: { sku: 'zero' },
      attributesLabel: 'Sold out',
      stock: 0,
      pricePaise: 30_000,
    });
  });

  it('splits a 2-store cart into one group with a child order per store', async () => {
    groupKey = `gik_test_${Date.now()}`;
    const res = await groupPlace({
      items: [
        { variantId, qty: 1 },
        { variantId: variant2Id, qty: 2 },
      ],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      idempotencyKey: groupKey,
    });
    expect(res.statusCode).toBe(200);
    const body = data(res) as {
      groupId: string;
      combinedTotalPaise: number;
      orders: Array<{ orderId: string; storeId: string; status: string; pricing: { totalPaise: number } }>;
      alreadyExisted: boolean;
    };
    firstGroupId = body.groupId;
    expect(body.orders).toHaveLength(2);
    expect(new Set(body.orders.map((o) => o.storeId))).toEqual(new Set([storeId, store2Id]));
    expect(body.orders.every((o) => o.status === 'routing')).toBe(true);
    expect(body.alreadyExisted).toBe(false);
    expect(body.combinedTotalPaise).toBe(
      body.orders.reduce((s, o) => s + o.pricing.totalPaise, 0),
    );
    // Both children share the ONE group row.
    for (const o of body.orders) {
      expect((await orderRow(o.orderId)).groupId).toBe(body.groupId);
    }
  });

  it('replays idempotently — same key returns the same group, no duplicates', async () => {
    const res = await groupPlace({
      items: [
        { variantId, qty: 1 },
        { variantId: variant2Id, qty: 2 },
      ],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      idempotencyKey: groupKey,
    });
    expect(res.statusCode).toBe(200);
    const body = data(res) as { groupId: string; alreadyExisted: boolean; combinedTotalPaise: number };
    expect(body.groupId).toBe(firstGroupId);
    expect(body.alreadyExisted).toBe(true);
    const children = await db.query.orders.findMany({
      where: eq(orders.groupId, firstGroupId),
      columns: { id: true },
    });
    expect(children).toHaveLength(2); // no third/fourth child from the replay
  });

  it('all-or-nothing: a failing store unwinds the placed sibling (reservations + refund)', async () => {
    const before = await variantRow(); // fixture variant baseline
    const failKey = `gik_fail_${Date.now()}`;
    const res = await groupPlace({
      items: [
        { variantId, qty: 1 },
        { variantId: zeroStockVariantId, qty: 1 }, // store 2 will fail on stock
      ],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      idempotencyKey: failKey,
    });
    expect(res.statusCode).toBe(409); // OrderStockUnavailable bubbles

    // Reservation restored regardless of which bucket placed first.
    expect((await variantRow()).reserved).toBe(before.reserved);
    // Every child that DID place under this key was compensated to 'cancelled'
    // (and its cancellation refund exists for the prepaid tender).
    for (const sid of [storeId, store2Id]) {
      const child = await db.query.orders.findFirst({
        where: eq(orders.idempotencyKey, `${failKey}#${sid}`),
      });
      if (!child) continue; // this bucket never placed — fine
      expect(child.status).toBe('cancelled');
      const refund = await db.query.refunds.findFirst({ where: eq(refunds.orderId, child.id) });
      expect(refund).toBeTruthy();
    }
  });

  it('rejects a multi-store pickup cart', async () => {
    const res = await groupPlace({
      items: [
        { variantId, qty: 1 },
        { variantId: variant2Id, qty: 1 },
      ],
      deliveryMethod: 'pickup',
      paymentMethod: 'upi',
      pickupSlotId: 'slot_x',
      pickupSlotStart: new Date(Date.now() + 3_600_000).toISOString(),
      pickupSlotEnd: new Date(Date.now() + 7_200_000).toISOString(),
    });
    expect(res.statusCode).toBe(422);
  });

  it('cart-level coupon: applies once to the whole 2-store cart (min-spend met only combined), splits exact, one redemption', async () => {
    // Combined cart = store1 ₹500 + store2 ₹600 = ₹1100. Coupon needs ₹1000 min —
    // neither store alone qualifies (₹500 / ₹600); only the whole cart does.
    const promoId = newId(IdPrefix.Promotion);
    await db.insert(promotions).values({
      id: promoId,
      name: 'CART200',
      mechanism: 'coupon',
      discountType: 'flat_amount',
      issuerType: 'admin',
      appliedTo: 'coupon',
      scope: { minCartPaise: 100_000 },
      config: { amountPaise: 20_000 },
      status: 'active',
      validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 86_400_000),
    });

    // Preview must equal placement.
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/cart',
      headers: auth(consumerToken),
      payload: { items: [{ variantId, qty: 1 }, { variantId: variant2Id, qty: 2 }], couponCode: 'CART200' },
    });
    expect(preview.statusCode).toBe(200);
    const previewTotal = (data(preview) as { aggregate: { grandTotalPaise: number }; rejectedCodes: unknown[] }).aggregate.grandTotalPaise;
    expect((data(preview) as { rejectedCodes: unknown[] }).rejectedCodes).toHaveLength(0);

    const key = `gik_coupon_${Date.now()}`;
    const res = await groupPlace({
      items: [{ variantId, qty: 1 }, { variantId: variant2Id, qty: 2 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      couponCode: 'CART200',
      idempotencyKey: key,
    });
    expect(res.statusCode).toBe(200);
    const body = data(res) as { groupId: string; orders: Array<{ orderId: string }> };
    expect(body.orders).toHaveLength(2);

    // Each child carries its coupon share; the shares sum to the full ₹200.
    const children = await db.query.orders.findMany({ where: eq(orders.groupId, body.groupId) });
    const totalCoupon = children.reduce((s, o) => s + o.couponPaise, 0);
    expect(totalCoupon).toBe(20_000);
    expect(children.every((o) => o.couponPaise > 0)).toBe(true); // both stores got a share
    // Per-child order_items coupon allocs sum to the child's couponPaise.
    for (const o of children) {
      const its = await db.query.orderItems.findMany({ where: eq(orderItems.orderId, o.id) });
      expect(its.reduce((s, i) => s + i.couponAllocPaise, 0)).toBe(o.couponPaise);
    }
    // Placement total == preview total.
    const placedTotal = children.reduce((s, o) => s + o.grandTotalPaise, 0);
    expect(placedTotal).toBe(previewTotal);

    // Coupon redeemed EXACTLY ONCE for the group (not once per child).
    const redemptions = await db.query.promotionRedemptions.findMany({
      where: eq(promotionRedemptions.promotionId, promoId),
    });
    expect(redemptions).toHaveLength(1);
    expect(redemptions[0]!.amountAppliedPaise).toBe(20_000);

    // Replay: same key → same group, still one redemption.
    const replay = await groupPlace({
      items: [{ variantId, qty: 1 }, { variantId: variant2Id, qty: 2 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      couponCode: 'CART200',
      idempotencyKey: key,
    });
    expect(replay.statusCode).toBe(200);
    expect((data(replay) as { groupId: string }).groupId).toBe(body.groupId);
    expect(
      (await db.query.promotionRedemptions.findMany({ where: eq(promotionRedemptions.promotionId, promoId) })).length,
    ).toBe(1);

    // Clean up the placed orders.
    for (const o of children) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/consumer/checkout/orders/${o.id}/cancel`,
        headers: auth(consumerToken),
        payload: {},
      });
    }
  });

  it('cart-level coupon rejected when the full cart is below min-spend → 409, no children placed', async () => {
    const promoId = newId(IdPrefix.Promotion);
    await db.insert(promotions).values({
      id: promoId,
      name: 'BIGMIN',
      mechanism: 'coupon',
      discountType: 'flat_amount',
      issuerType: 'admin',
      appliedTo: 'coupon',
      scope: { minCartPaise: 9_999_900 },
      config: { amountPaise: 20_000 },
      status: 'active',
      validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const key = `gik_reject_${Date.now()}`;
    const res = await groupPlace({
      items: [{ variantId, qty: 1 }, { variantId: variant2Id, qty: 2 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      couponCode: 'BIGMIN',
      idempotencyKey: key,
    });
    expect(res.statusCode).toBe(409);
    // No children left behind under this key.
    for (const sid of [storeId, store2Id]) {
      const child = await db.query.orders.findFirst({
        where: eq(orders.idempotencyKey, `${key}#${sid}`),
      });
      expect(child).toBeUndefined();
    }
  });

  it('cart-level points: redeemed once across the group, shares sum to the redemption', async () => {
    // Give the consumer a points balance.
    await db
      .insert(consumerLoyalty)
      .values({ id: newId(IdPrefix.LoyaltyAccount), consumerId, balancePoints: 5000 })
      .onConflictDoUpdate({ target: consumerLoyalty.consumerId, set: { balancePoints: 5000 } });
    const key = `gik_points_${Date.now()}`;
    const res = await groupPlace({
      items: [{ variantId, qty: 1 }, { variantId: variant2Id, qty: 2 }],
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      addressId,
      pointsToRedeem: 100, // ₹100 at ₹1/point
      idempotencyKey: key,
    });
    expect(res.statusCode).toBe(200);
    const body = data(res) as { groupId: string };
    const children = await db.query.orders.findMany({ where: eq(orders.groupId, body.groupId) });
    const totalPoints = children.reduce((s, o) => s + o.pointsRedeemedPaise, 0);
    expect(totalPoints).toBe(10_000); // 100 pts × ₹1 = ₹100 = 10000 paise
    // Exactly one loyalty 'redeem' row for the group.
    const firstChildId = children.map((o) => o.id).sort()[0];
    const redeemRows = await db.query.loyaltyTransactions.findMany({
      where: and(eq(loyaltyTransactions.kind, 'redeem'), eq(loyaltyTransactions.refOrderId, firstChildId!)),
    });
    // (first child by placement is storeIds[0]; assert a single redeem exists somewhere in the group)
    const allRedeems = await db.query.loyaltyTransactions.findMany({
      where: eq(loyaltyTransactions.kind, 'redeem'),
    });
    const groupRedeems = allRedeems.filter((r) => children.some((o) => o.id === r.refOrderId));
    expect(groupRedeems).toHaveLength(1);
    expect(groupRedeems[0]!.points).toBe(-100);
    void redeemRows;
    for (const o of children) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/consumer/checkout/orders/${o.id}/cancel`,
        headers: auth(consumerToken),
        payload: {},
      });
    }
  });
});

/* ═══ getOrder response shaper (A2) ═══════════════════════════════════════ */

describe('getOrder — consumer-safe shaper', () => {
  it('strips internal fields, keeps consumer-facing OTP/pickupCode + items', async () => {
    const { orderId } = await placeOrder({ deliveryMethod: 'standard', paymentMethod: 'upi' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/consumer/checkout/orders/${orderId}`,
      headers: auth(consumerToken),
    });
    expect(res.statusCode).toBe(200);
    const o = data(res) as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    // internal fields stripped
    for (const leak of ['agentHandoffCode', 'idempotencyKey', 'routingHistory', 'routingAttempts', 'codCollectedPaise', 'platformFeeBpSnap', 'tcsRateBpSnap', 'assignedAgentId']) {
      expect(o).not.toHaveProperty(leak);
    }
    // consumer-facing kept
    expect(o).toHaveProperty('status');
    expect(o).toHaveProperty('deliveryOtp'); // standard delivery carries one (may be a string)
    expect(o).toHaveProperty('grandTotalPaise');
    expect(Array.isArray(o.items)).toBe(true);
    // item internals stripped
    expect(o.items[0]).not.toHaveProperty('couponAllocPaise');
    expect(o.items[0]).not.toHaveProperty('gstRateBp');
    expect(o.items[0]).toHaveProperty('listingNameSnap');
    await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
  });
});

/* ═══ Razorpay gateway plumbing (mock-gateway mode — no network) ══════════ */

describe('gateway settle/fail — pending checkout lifecycle', () => {
  it('capture settles the pending payment and confirms+routes the order (idempotent)', async () => {
    const { orderId, status } = await placeOrder({
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      paymentOutcome: 'pending', // simulates the two-phase "awaiting Checkout" state
    });
    expect(status).toBe('pending');
    const gwOrder = `order_test_${Date.now()}`;
    await db
      .update(payments)
      .set({ gatewayOrderId: gwOrder })
      .where(eq(payments.orderId, orderId));

    const r1 = await settleGatewayCapture(db, {
      gatewayOrderId: gwOrder,
      razorpayPaymentId: 'pay_testCapture1',
    });
    expect(r1.settledOrderIds).toEqual([orderId]);
    const o = await orderRow(orderId);
    expect(o.status).toBe('routing');
    expect(o.acceptanceDeadlineAt).toBeTruthy(); // dispatched
    const pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('succeeded');
    expect(pay!.gatewayRef).toBe('pay_testCapture1');

    // Webhook replay / verify race — converges, no duplicate transitions.
    const r2 = await settleGatewayCapture(db, {
      gatewayOrderId: gwOrder,
      razorpayPaymentId: 'pay_testCapture1',
    });
    expect(r2.alreadySettled).toBe(true);
    expect((await orderRow(orderId)).status).toBe('routing');

    await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
  });

  it('checkout failure flips payment+order to failed; a late capture recovers them', async () => {
    const { orderId } = await placeOrder({
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      paymentOutcome: 'pending',
    });
    const gwOrder = `order_testfail_${Date.now()}`;
    await db
      .update(payments)
      .set({ gatewayOrderId: gwOrder })
      .where(eq(payments.orderId, orderId));

    const f = await failGatewayCheckout(db, { gatewayOrderId: gwOrder });
    expect(f.failedOrderIds).toEqual([orderId]);
    expect((await orderRow(orderId)).status).toBe('payment_failed');
    let pay = await db.query.payments.findFirst({ where: eq(payments.orderId, orderId) });
    expect(pay!.status).toBe('failed');

    // Late webhook capture on the SAME gateway order: payment row is already
    // failed (no flip) but the ORDER recovers payment_failed→pending→routing.
    await settleGatewayCapture(db, {
      gatewayOrderId: gwOrder,
      razorpayPaymentId: 'pay_lateCapture',
    });
    expect((await orderRow(orderId)).status).toBe('routing');

    await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/checkout/orders/${orderId}/cancel`,
      headers: auth(consumerToken),
      payload: {},
    });
  });

  it('webhook route (secret unset → verification skipped) settles a pending group', async () => {
    // Two-store pending group sharing ONE gateway order — webhook settles both.
    const key = `gik_rzp_${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/checkout/group',
      headers: auth(consumerToken),
      payload: {
        items: [{ variantId, qty: 1 }],
        deliveryMethod: 'standard',
        paymentMethod: 'upi',
        paymentOutcome: 'pending',
        addressId,
        idempotencyKey: key,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = data(res) as { groupId: string; orders: Array<{ orderId: string }> };
    const gwOrder = `order_grp_${Date.now()}`;
    for (const child of body.orders) {
      await db
        .update(payments)
        .set({ gatewayOrderId: gwOrder })
        .where(eq(payments.orderId, child.orderId));
    }

    const hook = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'skipped-in-dev' },
      payload: {
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_webhook1', order_id: gwOrder } } },
      },
    });
    expect(hook.statusCode).toBe(200);
    for (const child of body.orders) {
      expect((await orderRow(child.orderId)).status).toBe('routing');
      const pay = await db.query.payments.findFirst({
        where: eq(payments.orderId, child.orderId),
      });
      expect(pay!.status).toBe('succeeded');
      expect(pay!.gatewayRef).toMatch(/^pay_webhook1/);
      await app.inject({
        method: 'POST',
        url: `/api/v1/consumer/checkout/orders/${child.orderId}/cancel`,
        headers: auth(consumerToken),
        payload: {},
      });
    }
  });
});

/* ═══ Cash ledger ═════════════════════════════════════════════════════════ */

describe('cash ledger — collect, deposit, confirm/reject', () => {
  let depositId: string;
  let outstandingAtStart = 0;

  const balance = async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/driver/cash/balance',
      headers: auth(driverToken),
    });
    expect(res.statusCode).toBe(200);
    return data(res) as {
      collectedTotalPaise: number;
      depositedTotalPaise: number;
      outstandingPaise: number;
      pendingDepositPaise: number;
      pendingDepositId: string | null;
    };
  };

  it('driver-collected COD lands on the ledger as outstanding cash', async () => {
    // The COD-lifecycle test earlier delivered a COD order via this driver.
    const ledger = await db.query.driverCashLedger.findMany({
      where: eq(driverCashLedger.driverId, driverId),
    });
    expect(ledger.some((l) => l.entryKind === 'collected')).toBe(true);
    const b = await balance();
    expect(b.outstandingPaise).toBeGreaterThan(0);
    expect(b.outstandingPaise).toBe(b.collectedTotalPaise - b.depositedTotalPaise);
    outstandingAtStart = b.outstandingPaise;
  });

  it('deposit request defaults to full outstanding; only one pending at a time', async () => {
    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/cash/deposits',
      headers: auth(driverToken),
      payload: { note: 'end of shift' },
    });
    expect(req.statusCode).toBe(200);
    depositId = data(req).depositId as string;
    expect(data(req).amountPaise).toBe(outstandingAtStart);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/cash/deposits',
      headers: auth(driverToken),
      payload: {},
    });
    expect(second.statusCode).toBe(409);

    const b = await balance();
    expect(b.pendingDepositId).toBe(depositId);
    expect(b.outstandingPaise).toBe(outstandingAtStart); // request moves nothing
  });

  it('admin reject: nothing moves; driver can request again', async () => {
    const rej = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/cash/deposits/${depositId}/reject`,
      headers: auth(adminToken),
      payload: { note: 'cash not received' },
    });
    expect(rej.statusCode).toBe(200);
    const b = await balance();
    expect(b.outstandingPaise).toBe(outstandingAtStart);
    expect(b.pendingDepositId).toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/cash/deposits',
      headers: auth(driverToken),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    depositId = data(again).depositId as string;
  });

  it('admin confirm: ledger deposited entry lands, outstanding hits zero; double-confirm 409', async () => {
    const conf = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/cash/deposits/${depositId}/confirm`,
      headers: auth(adminToken),
      payload: { note: 'received at desk' },
    });
    expect(conf.statusCode).toBe(200);

    const b = await balance();
    expect(b.outstandingPaise).toBe(0);
    expect(b.depositedTotalPaise).toBe(outstandingAtStart);
    const entry = await db.query.driverCashLedger.findFirst({
      where: and(
        eq(driverCashLedger.driverId, driverId),
        eq(driverCashLedger.entryKind, 'deposited'),
      ),
    });
    expect(entry!.depositId).toBe(depositId);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/drivers/${driverId}/cash/deposits/${depositId}/confirm`,
      headers: auth(adminToken),
      payload: {},
    });
    expect(again.statusCode).toBe(409);

    // Nothing left to deposit.
    const over = await app.inject({
      method: 'POST',
      url: '/api/v1/driver/cash/deposits',
      headers: auth(driverToken),
      payload: {},
    });
    expect(over.statusCode).toBe(409);

    // Admin visibility: list carries the outstanding + driver detail aggregates.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/drivers',
      headers: auth(adminToken),
    });
    const row = (data(list) as Array<{ id: string; cashOutstandingPaise: number }>).find(
      (r) => r.id === driverId,
    );
    expect(row!.cashOutstandingPaise).toBe(0);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/drivers/${driverId}`,
      headers: auth(adminToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(data(detail).cash.outstandingPaise).toBe(0);
  });
});
