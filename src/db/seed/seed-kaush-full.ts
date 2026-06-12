/* eslint-disable no-console -- CLI seed */
/**
 * Comprehensive seed for kaushalyatharth@gmail.com — covers all 15 order statuses,
 * returns (door + standard), held items, disputes, refunds, and support tickets.
 * Run: npx tsx src/db/seed/seed-kaush-full.ts
 *
 * Idempotent: uses idempotencyKey prefix "kaush2_" for orders; skips if already seeded.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  addresses,
  brands,
  categories,
  consumers,
  disputes,
  heldItems,
  orderGroups,
  orderItems,
  orderTransitions,
  orders,
  payments,
  productListings,
  refundDisbursements,
  refundLines,
  refunds,
  retailerAccounts,
  retailerStores,
  returns,
  supportMessages,
  supportTickets,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { hashPassword } from '@/shared/auth/password.js';

const TARGET_EMAIL = 'kaushalyatharth@gmail.com';
const SEED_KEY_PREFIX = 'kaush2_';

function daysAgo(n: number, hours = 10): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hours, 0, 0, 0);
  return d;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600_000);
}

function paise(rupees: number) { return Math.round(rupees * 100); }

function intraGst(subtotalPaise: number) {
  const tax = Math.round(subtotalPaise * 0.05);
  const half = Math.floor(tax / 2);
  return { taxPaise: tax, cgstPaise: half, sgstPaise: tax - half, igstPaise: 0 };
}

async function main() {
  // ── 1. Check idempotency ──────────────────────────────────────────────────
  const existingCheck = await db.query.orders.findFirst({
    where: sql`${orders.idempotencyKey} LIKE ${'kaush2_%'}`,
    columns: { id: true },
  });
  if (existingCheck) {
    console.log('kaush2 seed already applied — skipping');
    return;
  }

  // ── 2. Retailer + store ───────────────────────────────────────────────────
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, TARGET_EMAIL),
    columns: { id: true, storeId: true },
  });
  if (!retailer) { console.error(`Account ${TARGET_EMAIL} not found`); process.exit(1); }
  if (!retailer.storeId) { console.error('No store linked'); process.exit(1); }
  const storeId = retailer.storeId;
  console.log(`Store: ${storeId}`);

  // ── 3. Admin account (for disputes/support) ───────────────────────────────
  const admin = await db.query.adminAccounts.findFirst({ columns: { id: true } });
  if (!admin) { console.error('No admin account found'); process.exit(1); }
  const adminId = admin.id;

  // ── 4. Activate store ─────────────────────────────────────────────────────
  await db.update(retailerStores).set({ status: 'active' }).where(eq(retailerStores.id, storeId));

  // ── 5. Brand + category ───────────────────────────────────────────────────
  const genericBrand = await db.query.brands.findFirst({ where: eq(brands.slug, 'generic') });
  const catApparel = await db.query.categories.findFirst({ where: eq(categories.slug, 'apparel') });
  const herTops = await db.query.categories.findFirst({ where: eq(categories.slug, 'her-tops') });
  const herDresses = await db.query.categories.findFirst({ where: eq(categories.slug, 'her-dresses') });
  const himShirts = await db.query.categories.findFirst({ where: eq(categories.slug, 'him-shirts') });

  const brandId = genericBrand?.id ?? null;
  const catFallback = catApparel?.id;
  if (!catFallback) { console.error('No apparel category — run catalog-defaults seed first'); process.exit(1); }
  const catTops = herTops?.id ?? catFallback;
  const catDresses = herDresses?.id ?? catFallback;
  const catShirts = himShirts?.id ?? catFallback;

  // ── 6. Seed listings ──────────────────────────────────────────────────────
  type VariantRec = { id: string; listingId: string; pricePaise: number; label: string; listingName: string };
  const seededVariants: VariantRec[] = [];

  const listingSpecs = [
    {
      name: 'Cotton Wrap Dress', gender: 'her' as const, categoryId: catDresses,
      variants: [
        { label: 'S / Ivory', pricePaise: paise(1299), stock: 10 },
        { label: 'M / Ivory', pricePaise: paise(1299), stock: 8 },
        { label: 'L / Ivory', pricePaise: paise(1299), stock: 6 },
      ],
    },
    {
      name: 'Linen Shirt', gender: 'him' as const, categoryId: catShirts,
      variants: [
        { label: 'M / White', pricePaise: paise(999), stock: 15 },
        { label: 'L / White', pricePaise: paise(999), stock: 12 },
        { label: 'XL / Blue', pricePaise: paise(999), stock: 8 },
      ],
    },
    {
      name: 'Embroidered Kurta', gender: 'her' as const, categoryId: catTops,
      variants: [
        { label: 'S / Mustard', pricePaise: paise(799), stock: 20 },
        { label: 'M / Mustard', pricePaise: paise(799), stock: 18 },
      ],
    },
    {
      name: 'Oversized Tee', gender: 'unisex' as const, categoryId: catFallback,
      variants: [
        { label: 'M / Black', pricePaise: paise(599), stock: 30 },
        { label: 'L / Black', pricePaise: paise(599), stock: 25 },
        { label: 'XL / Grey', pricePaise: paise(599), stock: 20 },
      ],
    },
  ];

  for (const spec of listingSpecs) {
    const listingId = newId(IdPrefix.Listing);
    await db.insert(productListings).values({
      id: listingId, storeId, brandId, categoryId: spec.categoryId,
      name: spec.name, gender: spec.gender,
      listingPolicy: 'return', galleryUrls: [], variantMode: 'color_size', status: 'active',
    });
    await db.insert(variantGroups).values({
      id: newId(IdPrefix.VariantGroup), listingId, storeId, name: 'Default', isDefault: true,
    });
    const colors = [...new Set(spec.variants.map((v) => v.label.split(' / ')[1] ?? 'Default'))];
    const groupIdByColor = new Map<string, string>();
    for (const [i, color] of colors.entries()) {
      const gid = newId(IdPrefix.VariantGroup);
      await db.insert(variantGroups).values({ id: gid, listingId, storeId, name: color, sortOrder: i });
      groupIdByColor.set(color, gid);
    }
    for (const v of spec.variants) {
      const size = v.label.split(' / ')[0] ?? 'M';
      const color = v.label.split(' / ')[1] ?? 'Default';
      const varId = newId(IdPrefix.Variant);
      await db.insert(variants).values({
        id: varId, listingId, storeId, groupId: groupIdByColor.get(color)!,
        attributes: { size, color },
        attributesLabel: v.label, imageUrls: [], stock: v.stock, reserved: 0, pricePaise: v.pricePaise,
      });
      seededVariants.push({ id: varId, listingId, pricePaise: v.pricePaise, label: v.label, listingName: spec.name });
    }
    console.log(`  Listing "${spec.name}"`);
  }

  // ── 7. Consumers ──────────────────────────────────────────────────────────
  const consumerPwd = await hashPassword('Consumer@1234');
  const consumerSpecs = [
    { name: 'Priya Sharma', email: 'priya.s2.demo.closetx@gmail.com', phone: '9801234560' },
    { name: 'Rahul Mehta', email: 'rahul.m2.demo.closetx@gmail.com', phone: '9812345670' },
    { name: 'Ananya Patel', email: 'ananya.p2.demo.closetx@gmail.com', phone: '9823456780' },
  ];

  type ConsumerRec = { id: string; name: string; email: string; phone: string; addressId: string };
  const consumerRecs: ConsumerRec[] = [];

  for (const cs of consumerSpecs) {
    const existing = await db.query.consumers.findFirst({ where: eq(consumers.email, cs.email) });
    let consumerId: string;
    let addrId: string;
    if (existing) {
      consumerId = existing.id;
      const addr = await db.query.addresses.findFirst({ where: eq(addresses.consumerId, consumerId) });
      addrId = addr?.id ?? newId(IdPrefix.Address);
    } else {
      consumerId = newId(IdPrefix.Consumer);
      await db.insert(consumers).values({
        id: consumerId, email: cs.email, phone: cs.phone,
        name: cs.name, passwordHash: consumerPwd, status: 'active',
      });
      addrId = newId(IdPrefix.Address);
      await db.insert(addresses).values({
        id: addrId, consumerId, label: 'home',
        line1: '202, Palm Heights, Bandra', city: 'Mumbai',
        pincode: '400050', stateCode: 'MH', lat: 19.054, lng: 72.841,
      });
    }
    consumerRecs.push({ id: consumerId, name: cs.name, email: cs.email, phone: cs.phone, addressId: addrId });
  }
  console.log(`${consumerRecs.length} consumers ready`);

  // ── 8. Helper: create one order ───────────────────────────────────────────
  type OrderStatus =
    | 'pending' | 'confirmed' | 'routing' | 'accepted' | 'packed'
    | 'picked_up' | 'out_for_delivery' | 'at_door' | 'undelivered'
    | 'returning_to_store' | 'returned_to_store' | 'delivered'
    | 'cancelled' | 'payment_failed' | 'closed';

  async function createOrder(opts: {
    consumer: ConsumerRec;
    variantRec: VariantRec;
    qty: number;
    status: OrderStatus;
    placedAt: Date;
    deliveryMethod?: 'standard' | 'express' | 'try_and_buy' | 'pickup';
    itemOutcome?: typeof orderItems.$inferInsert['outcome'];
  }): Promise<{ orderId: string; orderItemId: string; paymentId: string; placedAt: Date }> {
    const { consumer, variantRec, qty, status, placedAt } = opts;
    const deliveryMethod = opts.deliveryMethod ?? 'standard';

    const unitPricePaise = variantRec.pricePaise;
    const linePaise = unitPricePaise * qty;
    const { taxPaise, cgstPaise, sgstPaise, igstPaise } = intraGst(linePaise);
    const deliveryFeePaise = paise(49);
    const grandTotalPaise = linePaise + taxPaise + deliveryFeePaise;

    const isTerminal = ['delivered', 'cancelled', 'payment_failed', 'closed', 'returned_to_store'].includes(status);
    const deliveredAt = status === 'delivered' ? new Date(placedAt.getTime() + 2 * 86_400_000) : null;
    const closedAt = isTerminal ? (deliveredAt ?? new Date(placedAt.getTime() + 3 * 86_400_000)) : null;

    const groupId = newId(IdPrefix.OrderGroup);
    const orderId = newId(IdPrefix.Order);
    const orderItemId = newId(IdPrefix.OrderItem);
    const paymentId = newId(IdPrefix.Payment);

    const groupStatus = (() => {
      if (status === 'delivered' || status === 'closed') return 'all_delivered';
      if (status === 'cancelled' || status === 'payment_failed') return 'all_cancelled';
      if (status === 'returned_to_store') return 'partially_cancelled';
      return 'in_flight';
    })();

    await db.insert(orderGroups).values({
      id: groupId, consumerId: consumer.id, status: groupStatus, placedAt,
    });

    await db.insert(orders).values({
      id: orderId, groupId,
      consumerId: consumer.id, storeId, addressId: consumer.addressId,
      deliveryMethod, paymentMethod: 'upi', paymentMethodLabel: 'UPI · GPay',
      status,
      consumerNameSnap: consumer.name,
      consumerEmailSnap: consumer.email,
      consumerPhoneSnap: consumer.phone,
      addressLine1Snap: '202, Palm Heights, Bandra',
      addressCitySnap: 'Mumbai', addressPincodeSnap: '400050',
      addressStateCodeSnap: 'MH', addressLatSnap: 19.054, addressLngSnap: 72.841,
      storeNameSnap: 'Kaush Store', storeAddressSnap: 'Mumbai, MH',
      storeGstinSnap: '27AAFCK0000M1Z5', storeStateCodeSnap: 'MH',
      itemsSubtotalPaise: linePaise,
      retailerPromoPaise: 0, platformPromoPaise: 0, couponPaise: 0,
      pointsRedeemedPaise: 0, walletAppliedPaise: 0,
      taxPaise, taxSplitKind: 'intra_state', cgstPaise, sgstPaise, igstPaise,
      deliveryFeePaise, handlingFeePaise: 0, convenienceFeePaise: 0,
      grandTotalPaise,
      platformFeeBpSnap: 200,
      placedAt,
      ...(!['pending', 'confirmed', 'routing'].includes(status)
        ? { acceptedAt: new Date(placedAt.getTime() + 1_800_000) }
        : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(closedAt ? { closedAt } : {}),
      idempotencyKey: `${SEED_KEY_PREFIX}${orderId}`,
    });

    const gstAllocPaise = Math.round(linePaise * 0.05);
    const itemOutcome = opts.itemOutcome ?? (() => {
      switch (status) {
        case 'delivered': return 'delivered_kept';
        case 'cancelled': case 'payment_failed': return 'cancelled';
        case 'at_door': return 'at_door_kept';
        case 'returned_to_store': return 'at_store_pending_verification';
        default: return 'pending_delivery';
      }
    })();

    await db.insert(orderItems).values({
      id: orderItemId, orderId,
      listingId: variantRec.listingId, variantId: variantRec.id,
      listingNameSnap: variantRec.listingName, brandSnap: 'Generic', categorySnap: 'Apparel',
      attributesLabelSnap: variantRec.label, listingPolicySnap: 'return',
      qty, unitPricePaise, lineSubtotalPaise: linePaise,
      retailerPromoAllocPaise: 0, platformPromoAllocPaise: 0,
      couponAllocPaise: 0, pointsAllocPaise: 0,
      gstRateBp: 500, gstAllocPaise, netLinePaise: linePaise + gstAllocPaise,
      outcome: itemOutcome,
    });

    await db.insert(orderTransitions).values({
      id: newId(IdPrefix.OrderTransition), orderId,
      fromStatus: null, toStatus: 'pending',
      actorType: 'consumer', actorId: consumer.id, at: placedAt,
    });

    const payStatus = status === 'payment_failed' ? 'failed' : status === 'pending' ? 'pending' : 'succeeded';
    const settledAt = payStatus !== 'pending' ? new Date(placedAt.getTime() + 300_000) : undefined;
    await db.insert(payments).values({
      id: paymentId, orderId, method: 'upi',
      amountPaise: grandTotalPaise, status: payStatus,
      ...(payStatus === 'succeeded' ? { gatewayRef: `rzp_demo_${orderId.slice(-8)}` } : {}),
      ...(settledAt ? { settledAt } : {}),
      idempotencyKey: `${SEED_KEY_PREFIX}pay_${orderId}`,
      initiatedAt: placedAt,
    });

    return { orderId, orderItemId, paymentId, placedAt };
  }

  // ── 9. Create orders for all 15 statuses ─────────────────────────────────
  const v0 = seededVariants[0]!;
  const v1 = seededVariants[1]!;
  const v2 = seededVariants[2]!;
  const v3 = seededVariants[3]!;
  const v4 = seededVariants[4]!;
  const v5 = seededVariants[5]!;
  const v6 = seededVariants[6]!;
  const v7 = seededVariants[7]!;
  const v8 = seededVariants[8]!;
  const c0 = consumerRecs[0]!;
  const c1 = consumerRecs[1]!;
  const c2 = consumerRecs[2]!;

  console.log('Creating orders for all 15 statuses…');

  // pending (2)
  const pending1 = await createOrder({ consumer: c0, variantRec: v0, qty: 1, status: 'pending', placedAt: hoursAgo(2) });
  const pending2 = await createOrder({ consumer: c1, variantRec: v1, qty: 2, status: 'pending', placedAt: hoursAgo(1) });

  // confirmed (2)
  const confirmed1 = await createOrder({ consumer: c2, variantRec: v2, qty: 1, status: 'confirmed', placedAt: daysAgo(1, 9) });
  const confirmed2 = await createOrder({ consumer: c0, variantRec: v3, qty: 1, status: 'confirmed', placedAt: daysAgo(1, 14) });

  // routing (1)
  const routing1 = await createOrder({ consumer: c1, variantRec: v4, qty: 1, status: 'routing', placedAt: daysAgo(1, 16) });

  // accepted (2)
  const accepted1 = await createOrder({ consumer: c2, variantRec: v5, qty: 1, status: 'accepted', placedAt: daysAgo(2, 10) });
  const accepted2 = await createOrder({ consumer: c0, variantRec: v6, qty: 2, status: 'accepted', placedAt: daysAgo(2, 14) });

  // packed (2)
  const packed1 = await createOrder({ consumer: c1, variantRec: v7, qty: 1, status: 'packed', placedAt: daysAgo(2, 16) });
  const packed2 = await createOrder({ consumer: c2, variantRec: v8, qty: 1, status: 'packed', placedAt: daysAgo(3, 9) });

  // picked_up (1)
  const pickedUp1 = await createOrder({ consumer: c0, variantRec: v0, qty: 1, status: 'picked_up', placedAt: daysAgo(3, 11) });

  // out_for_delivery (1)
  const outForDelivery1 = await createOrder({ consumer: c1, variantRec: v1, qty: 1, status: 'out_for_delivery', placedAt: daysAgo(3, 13) });

  // at_door try_and_buy (2) — will get door returns below
  const atDoor1 = await createOrder({
    consumer: c2, variantRec: v2, qty: 1, status: 'at_door', placedAt: hoursAgo(3),
    deliveryMethod: 'try_and_buy', itemOutcome: 'at_door_returned',
  });
  const atDoor2 = await createOrder({
    consumer: c0, variantRec: v3, qty: 1, status: 'at_door', placedAt: hoursAgo(4),
    deliveryMethod: 'try_and_buy', itemOutcome: 'at_door_kept',
  });

  // undelivered (1)
  const undelivered1 = await createOrder({ consumer: c1, variantRec: v4, qty: 1, status: 'undelivered', placedAt: daysAgo(4, 9) });

  // returning_to_store (1)
  const returningToStore1 = await createOrder({ consumer: c2, variantRec: v5, qty: 1, status: 'returning_to_store', placedAt: daysAgo(5, 9) });

  // returned_to_store (1) — used for standard return below
  const returnedToStore1 = await createOrder({
    consumer: c0, variantRec: v6, qty: 1, status: 'returned_to_store', placedAt: daysAgo(6, 10),
    itemOutcome: 'at_store_pending_verification',
  });

  // delivered (5) — some will get standard returns, disputes, refunds
  const delivered1 = await createOrder({ consumer: c1, variantRec: v7, qty: 1, status: 'delivered', placedAt: daysAgo(7, 9) });
  const delivered2 = await createOrder({ consumer: c2, variantRec: v8, qty: 2, status: 'delivered', placedAt: daysAgo(8, 10) });
  const delivered3 = await createOrder({ consumer: c0, variantRec: v0, qty: 1, status: 'delivered', placedAt: daysAgo(10, 11) });
  const delivered4 = await createOrder({ consumer: c1, variantRec: v1, qty: 1, status: 'delivered', placedAt: daysAgo(14, 9) });
  const delivered5 = await createOrder({ consumer: c2, variantRec: v2, qty: 1, status: 'delivered', placedAt: daysAgo(20, 10) });

  // cancelled (2)
  const cancelled1 = await createOrder({ consumer: c0, variantRec: v3, qty: 1, status: 'cancelled', placedAt: daysAgo(9, 12) });
  const cancelled2 = await createOrder({ consumer: c1, variantRec: v4, qty: 2, status: 'cancelled', placedAt: daysAgo(15, 10) });

  // payment_failed (1)
  const payFailed1 = await createOrder({ consumer: c2, variantRec: v5, qty: 1, status: 'payment_failed', placedAt: daysAgo(12, 14) });

  // closed (1) — delivered + fully settled
  const closed1 = await createOrder({ consumer: c0, variantRec: v6, qty: 1, status: 'closed', placedAt: daysAgo(25, 9) });

  console.log('All 15 order statuses created');

  // ── 10. Returns ───────────────────────────────────────────────────────────
  console.log('Creating returns…');

  // Door returns (from atDoor1 — returned, atDoor2 — kept)
  const doorReturn1Id = newId(IdPrefix.Return);
  const doorReturn1OpenedAt = new Date(atDoor1.placedAt.getTime() + 1_200_000); // 20 min after
  await db.insert(returns).values({
    id: doorReturn1Id,
    orderItemId: atDoor1.orderItemId,
    kind: 'door_return',
    openedAt: doorReturn1OpenedAt,
    reasonText: 'Tried but did not like the fit',
    photos: [],
    agentDisposition: 'returned', // required for door_return
    storeDecision: 'pending',
  });

  const doorReturn2Id = newId(IdPrefix.Return);
  const doorReturn2OpenedAt = new Date(atDoor2.placedAt.getTime() + 900_000); // 15 min after
  await db.insert(returns).values({
    id: doorReturn2Id,
    orderItemId: atDoor2.orderItemId,
    kind: 'door_return',
    openedAt: doorReturn2OpenedAt,
    reasonText: 'Decided to keep it',
    photos: [],
    agentDisposition: 'kept', // required for door_return
    storeDecision: 'accepted',
    storeDecidedAt: new Date(doorReturn2OpenedAt.getTime() + 3_600_000),
  });

  // Standard returns from delivered orders
  // delivered3 — standard return, store decision pending
  const stdReturn1Id = newId(IdPrefix.Return);
  const stdReturn1OpenedAt = new Date(delivered3.placedAt.getTime() + 3 * 86_400_000);
  await db.insert(returns).values({
    id: stdReturn1Id,
    orderItemId: delivered3.orderItemId,
    kind: 'standard_return',
    openedAt: stdReturn1OpenedAt,
    reasonText: 'Wrong size, want to exchange',
    photos: [],
    storeDecision: 'pending',
  });

  // delivered4 — standard return, store accepted
  const stdReturn2Id = newId(IdPrefix.Return);
  const stdReturn2OpenedAt = new Date(delivered4.placedAt.getTime() + 2 * 86_400_000);
  const stdReturn2DecidedAt = new Date(stdReturn2OpenedAt.getTime() + 86_400_000);
  await db.insert(returns).values({
    id: stdReturn2Id,
    orderItemId: delivered4.orderItemId,
    kind: 'standard_return',
    openedAt: stdReturn2OpenedAt,
    reasonText: 'Defective stitching',
    photos: [],
    storeDecision: 'accepted',
    storeDecidedAt: stdReturn2DecidedAt,
  });

  // delivered5 — standard return, store rejected → held item
  const stdReturn3Id = newId(IdPrefix.Return);
  const stdReturn3OpenedAt = new Date(delivered5.placedAt.getTime() + 4 * 86_400_000);
  const stdReturn3DecidedAt = new Date(stdReturn3OpenedAt.getTime() + 86_400_000);
  await db.insert(returns).values({
    id: stdReturn3Id,
    orderItemId: delivered5.orderItemId,
    kind: 'standard_return',
    openedAt: stdReturn3OpenedAt,
    reasonText: 'Claims item is defective',
    photos: [],
    storeDecision: 'rejected',
    storeDecidedAt: stdReturn3DecidedAt,
  });

  // returnedToStore1 — standard return, store pending
  const stdReturn4Id = newId(IdPrefix.Return);
  await db.insert(returns).values({
    id: stdReturn4Id,
    orderItemId: returnedToStore1.orderItemId,
    kind: 'standard_return',
    openedAt: new Date(returnedToStore1.placedAt.getTime() + 86_400_000),
    reasonText: 'Item not as described',
    photos: [],
    storeDecision: 'pending',
  });

  console.log('Returns created');

  // ── 11. Held items ────────────────────────────────────────────────────────
  console.log('Creating held items…');

  // Holding — from stdReturn3 (rejected)
  const heldItem1Id = newId(IdPrefix.HeldItem);
  await db.insert(heldItems).values({
    id: heldItem1Id,
    returnId: stdReturn3Id,
    storeId,
    consumerId: c2.id,
    status: 'holding',
    holdingWindowExpiresAt: new Date(Date.now() + 7 * 86_400_000), // 7 days from now
  });

  // Expired — simulate another rejected return that expired
  const expiredReturnId = newId(IdPrefix.Return);
  const expiredReturnOpenedAt = daysAgo(30, 10);
  const expiredReturnDecidedAt = new Date(expiredReturnOpenedAt.getTime() + 86_400_000);
  await db.insert(returns).values({
    id: expiredReturnId,
    orderItemId: cancelled1.orderItemId, // reuse a different item
    kind: 'standard_return',
    openedAt: expiredReturnOpenedAt,
    reasonText: 'Size mismatch',
    photos: [],
    storeDecision: 'rejected',
    storeDecidedAt: expiredReturnDecidedAt,
  });

  const heldItem2Id = newId(IdPrefix.HeldItem);
  await db.insert(heldItems).values({
    id: heldItem2Id,
    returnId: expiredReturnId,
    storeId,
    consumerId: c0.id,
    status: 'expired',
    holdingWindowExpiresAt: daysAgo(15, 10), // expired 15 days ago
  });

  // Resolved — collected by consumer
  const resolvedReturnId = newId(IdPrefix.Return);
  const resolvedReturnOpenedAt = daysAgo(20, 10);
  const resolvedReturnDecidedAt = new Date(resolvedReturnOpenedAt.getTime() + 86_400_000);
  await db.insert(returns).values({
    id: resolvedReturnId,
    orderItemId: cancelled2.orderItemId,
    kind: 'standard_return',
    openedAt: resolvedReturnOpenedAt,
    reasonText: 'Wrong color',
    photos: [],
    storeDecision: 'rejected',
    storeDecidedAt: resolvedReturnDecidedAt,
  });

  const heldItem3Id = newId(IdPrefix.HeldItem);
  const resolvedAt = daysAgo(10, 14);
  await db.insert(heldItems).values({
    id: heldItem3Id,
    returnId: resolvedReturnId,
    storeId,
    consumerId: c1.id,
    status: 'resolved',
    holdingWindowExpiresAt: daysAgo(12, 10),
    disposition: 'returned_to_consumer', // required when status='resolved'
    resolvedAt, // required when status='resolved'
  });

  // Resolved — restocked
  const restockedReturnId = newId(IdPrefix.Return);
  const restockedOpenedAt = daysAgo(18, 10);
  await db.insert(returns).values({
    id: restockedReturnId,
    orderItemId: delivered1.orderItemId,
    kind: 'standard_return',
    openedAt: restockedOpenedAt,
    reasonText: 'Ordered duplicate accidentally',
    photos: [],
    storeDecision: 'rejected',
    storeDecidedAt: new Date(restockedOpenedAt.getTime() + 86_400_000),
  });

  const heldItem4Id = newId(IdPrefix.HeldItem);
  await db.insert(heldItems).values({
    id: heldItem4Id,
    returnId: restockedReturnId,
    storeId,
    consumerId: c1.id,
    status: 'resolved',
    holdingWindowExpiresAt: daysAgo(8, 10),
    disposition: 'restocked',
    resolvedAt: daysAgo(9, 14),
  });

  console.log('Held items created');

  // ── 12. Disputes ──────────────────────────────────────────────────────────
  console.log('Creating disputes…');

  // Open dispute — on an order
  const dispute1Id = newId(IdPrefix.Dispute);
  await db.insert(disputes).values({
    id: dispute1Id,
    orderId: undelivered1.orderId, // XOR: orderId set, returnId null
    openedByActorType: 'consumer',
    openedByActorId: c1.id,
    openedAt: new Date(undelivered1.placedAt.getTime() + 86_400_000),
    description: 'Delivery agent marked delivered but item never arrived',
    evidence: [],
    status: 'open',
    // Non-decided: decision/decidedAt/decidedByAdminId must all be null
  });

  // Requested evidence — on a return
  const dispute2Id = newId(IdPrefix.Dispute);
  await db.insert(disputes).values({
    id: dispute2Id,
    returnId: stdReturn1Id, // XOR: returnId set, orderId null
    openedByActorType: 'consumer',
    openedByActorId: c0.id,
    openedAt: new Date(stdReturn1OpenedAt.getTime() + 3_600_000),
    description: 'Store is not acknowledging the return request',
    evidence: [],
    status: 'requested_evidence',
    // Non-decided: decision/decidedAt/decidedByAdminId must all be null
  });

  // Decided — refund decision
  const dispute3Id = newId(IdPrefix.Dispute);
  const dispute3OpenedAt = new Date(delivered2.placedAt.getTime() + 4 * 86_400_000);
  const dispute3DecidedAt = new Date(dispute3OpenedAt.getTime() + 2 * 86_400_000);
  await db.insert(disputes).values({
    id: dispute3Id,
    orderId: delivered2.orderId,
    openedByActorType: 'consumer',
    openedByActorId: c2.id,
    openedAt: dispute3OpenedAt,
    description: 'Item received was damaged',
    evidence: [],
    status: 'decided',
    decision: 'refund', // required when decided
    decisionNote: 'Admin verified photos — full refund approved',
    decidedByAdminId: adminId, // required when decided
    decidedAt: dispute3DecidedAt, // required when decided
  });

  // Escalated — on an order
  const dispute4Id = newId(IdPrefix.Dispute);
  await db.insert(disputes).values({
    id: dispute4Id,
    orderId: delivered3.orderId,
    openedByActorType: 'consumer',
    openedByActorId: c0.id,
    openedAt: new Date(delivered3.placedAt.getTime() + 5 * 86_400_000),
    description: 'Wrong item delivered, store is unresponsive',
    evidence: [],
    status: 'escalated',
    // Non-decided: decision/decidedAt/decidedByAdminId must all be null
  });

  console.log('Disputes created');

  // ── 13. Refunds ───────────────────────────────────────────────────────────
  console.log('Creating refunds…');

  const mkRefund = async (opts: {
    orderId: string; orderItemId: string; paymentId: string;
    amountPaise: number; status: 'pending' | 'processing' | 'succeeded' | 'partially_disbursed' | 'failed';
    reason: string; createdAt: Date;
  }) => {
    const refundId = newId(IdPrefix.Refund);
    const completedAt = opts.status === 'succeeded' ? new Date(opts.createdAt.getTime() + 86_400_000) : null;
    await db.insert(refunds).values({
      id: refundId, orderId: opts.orderId,
      totalRefundPaise: opts.amountPaise, status: opts.status,
      reason: opts.reason, createdAt: opts.createdAt,
      ...(completedAt ? { completedAt } : {}),
    });

    const refundLineId = newId(IdPrefix.RefundLine);
    await db.insert(refundLines).values({
      id: refundLineId, refundId, orderItemId: opts.orderItemId,
      refundedAmountPaise: opts.amountPaise,
      couponClawbackPaise: 0, pointsClawbackPaise: 0, taxRefundPaise: 0,
    });

    // Disbursement
    const disbId = newId(IdPrefix.RefundDisbursement);
    const disbSettledAt = opts.status === 'succeeded' ? new Date(opts.createdAt.getTime() + 86_400_000) : null;
    const disbStatus: 'pending' | 'succeeded' | 'failed' =
      opts.status === 'succeeded' ? 'succeeded'
        : opts.status === 'failed' ? 'failed'
          : 'pending';

    await db.insert(refundDisbursements).values({
      id: disbId, refundId,
      destination: 'original_tender',
      sourcePaymentId: opts.paymentId, // required for original_tender
      amountPaise: opts.amountPaise,
      status: disbStatus,
      ...(opts.status === 'succeeded' ? { gatewayRef: `rzp_ref_${disbId.slice(-8)}` } : {}),
      initiatedAt: opts.createdAt,
      ...(disbSettledAt ? { settledAt: disbSettledAt } : {}),
    });

    // partially_disbursed: add a wallet credit for partial
    if (opts.status === 'partially_disbursed') {
      const walletDisbId = newId(IdPrefix.RefundDisbursement);
      const partialAmount = Math.floor(opts.amountPaise * 0.3);
      await db.insert(refundDisbursements).values({
        id: walletDisbId, refundId,
        destination: 'wallet',
        sourcePaymentId: null, // required: wallet refund has no sourcePaymentId
        amountPaise: partialAmount,
        status: 'succeeded',
        initiatedAt: opts.createdAt,
        settledAt: new Date(opts.createdAt.getTime() + 3_600_000),
      });
    }
  };

  // pending refund — cancelled1
  await mkRefund({
    orderId: cancelled1.orderId, orderItemId: cancelled1.orderItemId,
    paymentId: cancelled1.paymentId,
    amountPaise: paise(400), status: 'pending',
    reason: 'Order cancelled by consumer', createdAt: daysAgo(9, 13),
  });

  // processing refund — cancelled2
  await mkRefund({
    orderId: cancelled2.orderId, orderItemId: cancelled2.orderItemId,
    paymentId: cancelled2.paymentId,
    amountPaise: paise(1600), status: 'processing',
    reason: 'Order cancelled before dispatch', createdAt: daysAgo(15, 11),
  });

  // succeeded refund — delivered2 (from decided dispute)
  await mkRefund({
    orderId: delivered2.orderId, orderItemId: delivered2.orderItemId,
    paymentId: delivered2.paymentId,
    amountPaise: paise(1200), status: 'succeeded',
    reason: 'Damaged item — dispute resolved in consumer favour', createdAt: daysAgo(8, 10),
  });

  // partially_disbursed — delivered5 (rejected return, partial wallet credit)
  await mkRefund({
    orderId: delivered5.orderId, orderItemId: delivered5.orderItemId,
    paymentId: delivered5.paymentId,
    amountPaise: paise(800), status: 'partially_disbursed',
    reason: 'Partial refund: store accepted partial claim', createdAt: daysAgo(20, 14),
  });

  // failed refund — payFailed1
  await mkRefund({
    orderId: payFailed1.orderId, orderItemId: payFailed1.orderItemId,
    paymentId: payFailed1.paymentId,
    amountPaise: paise(600), status: 'failed',
    reason: 'Gateway rejected refund — invalid account', createdAt: daysAgo(12, 15),
  });

  console.log('Refunds created');

  // ── 14. Support tickets ───────────────────────────────────────────────────
  console.log('Creating support tickets…');

  const mkTicket = async (opts: {
    consumer: ConsumerRec;
    orderId?: string;
    subject: string;
    status: 'open' | 'in_progress' | 'resolved' | 'closed';
    createdAt: Date;
    messages: Array<{ senderType: 'consumer' | 'retailer' | 'admin' | 'system'; body: string; minutesAfter: number }>;
  }) => {
    const ticketId = newId('tkt'); // no IdPrefix.SupportTicket, use plain prefix
    const lastMsg = opts.messages.at(-1);
    const lastMessageAt = lastMsg
      ? new Date(opts.createdAt.getTime() + lastMsg.minutesAfter * 60_000)
      : opts.createdAt;
    const closedAt = opts.status === 'closed' || opts.status === 'resolved'
      ? new Date(opts.createdAt.getTime() + 3 * 86_400_000)
      : null;

    await db.insert(supportTickets).values({
      id: ticketId,
      openedByActorType: 'consumer',
      openedByActorId: opts.consumer.id,
      ...(opts.orderId ? { orderId: opts.orderId } : {}),
      subject: opts.subject,
      status: opts.status,
      assignedAdminId: opts.status === 'in_progress' || opts.status === 'resolved' ? adminId : null,
      lastMessageAt,
      createdAt: opts.createdAt,
      ...(closedAt ? { closedAt } : {}),
    });

    for (const msg of opts.messages) {
      const senderId = msg.senderType === 'admin' ? adminId
        : msg.senderType === 'system' ? 'system'
          : opts.consumer.id;
      await db.insert(supportMessages).values({
        id: newId('msg'),
        ticketId,
        senderType: msg.senderType,
        senderId,
        body: msg.body,
        attachments: [],
        at: new Date(opts.createdAt.getTime() + msg.minutesAfter * 60_000),
      });
    }
  };

  // Open — no reply yet
  await mkTicket({
    consumer: c0,
    orderId: pending1.orderId,
    subject: 'Where is my order?',
    status: 'open',
    createdAt: hoursAgo(5),
    messages: [
      { senderType: 'consumer', body: 'Hi, I placed an order 5 hours ago and haven\'t received a confirmation. Can you check?', minutesAfter: 0 },
    ],
  });

  // In progress — admin replied
  await mkTicket({
    consumer: c1,
    orderId: undelivered1.orderId,
    subject: 'Delivery marked as delivered but I never received it',
    status: 'in_progress',
    createdAt: daysAgo(2, 11),
    messages: [
      { senderType: 'consumer', body: 'The app says my order was delivered but I never received anything. The delivery agent is not picking up.', minutesAfter: 0 },
      { senderType: 'admin', body: 'Hi! We\'re sorry to hear that. We\'ve flagged this with the delivery team and are investigating. We\'ll update you within 24 hours.', minutesAfter: 90 },
      { senderType: 'consumer', body: 'Please resolve this quickly, I need the item urgently.', minutesAfter: 180 },
    ],
  });

  // Resolved — issue fixed
  await mkTicket({
    consumer: c2,
    orderId: delivered2.orderId,
    subject: 'Received damaged item',
    status: 'resolved',
    createdAt: daysAgo(10, 9),
    messages: [
      { senderType: 'consumer', body: 'The dress arrived with a torn seam. I\'ve attached photos. I want a refund.', minutesAfter: 0 },
      { senderType: 'admin', body: 'We\'ve reviewed your photos. A full refund has been approved and will be processed within 3-5 business days.', minutesAfter: 120 },
      { senderType: 'consumer', body: 'Thank you for the quick resolution!', minutesAfter: 180 },
      { senderType: 'system', body: 'Refund initiated: ₹1,200 to original payment method.', minutesAfter: 300 },
    ],
  });

  // Closed — fully done
  await mkTicket({
    consumer: c0,
    subject: 'Question about return policy',
    status: 'closed',
    createdAt: daysAgo(20, 10),
    messages: [
      { senderType: 'consumer', body: 'How many days do I have to initiate a return?', minutesAfter: 0 },
      { senderType: 'admin', body: 'You have 7 days from delivery to initiate a return. Let us know if you need anything else!', minutesAfter: 60 },
      { senderType: 'consumer', body: 'Got it, thanks!', minutesAfter: 90 },
      { senderType: 'system', body: 'Ticket auto-closed after 7 days of inactivity.', minutesAfter: 10170 },
    ],
  });

  console.log('Support tickets created');

  // ── Done ──────────────────────────────────────────────────────────────────
  console.log('\n✓ kaush2 comprehensive seed complete.');
  console.log('  Orders: all 15 statuses seeded');
  console.log('  Returns: 2 door + 4 standard (pending/accepted/rejected)');
  console.log('  Held items: holding, expired, resolved ×2');
  console.log('  Disputes: open, requested_evidence, decided, escalated');
  console.log('  Refunds: pending, processing, succeeded, partially_disbursed, failed');
  console.log('  Support tickets: open, in_progress, resolved, closed');

  // Suppress unused var warnings for terminal status orders
  void pending1; void pending2; void confirmed1; void confirmed2;
  void routing1; void accepted1; void accepted2; void packed1; void packed2;
  void pickedUp1; void outForDelivery1; void atDoor1; void atDoor2;
  void undelivered1; void returningToStore1; void returnedToStore1;
  void delivered1; void delivered2; void delivered3; void delivered4; void delivered5;
  void cancelled1; void cancelled2; void payFailed1; void closed1;
  void dispute1Id; void dispute2Id; void dispute3Id; void dispute4Id;
  void heldItem1Id; void heldItem2Id; void heldItem3Id; void heldItem4Id;
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
