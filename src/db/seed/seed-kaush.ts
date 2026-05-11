/* eslint-disable no-console -- CLI seed */
/**
 * One-shot seed for kaushalyatharth@gmail.com — sets their store to active
 * and populates listings + orders so the analytics dashboard has real data.
 * Run: npx tsx src/db/seed/seed-kaush.ts
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  addresses,
  brands,
  categories,
  consumers,
  orderGroups,
  orderItems,
  orderTransitions,
  orders,
  payments,
  productListings,
  retailerAccounts,
  retailerStores,
  variants,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { hashPassword } from '@/shared/auth/password.js';

const TARGET_EMAIL = 'kaushalyatharth@gmail.com';

function daysAgo(n: number, hourJitter = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(8 + hourJitter, 0, 0, 0);
  return d;
}

function paise(rupees: number) { return Math.round(rupees * 100); }

function intraGst(subtotalPaise: number) {
  const tax = Math.round(subtotalPaise * 0.05);
  const half = Math.floor(tax / 2);
  return { taxPaise: tax, cgstPaise: half, sgstPaise: tax - half, igstPaise: 0 };
}

async function main() {
  // 1. Load retailer + store
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, TARGET_EMAIL),
    columns: { id: true, storeId: true, status: true },
  });
  if (!retailer) { console.error(`Account ${TARGET_EMAIL} not found`); process.exit(1); }
  if (!retailer.storeId) { console.error('No store linked'); process.exit(1); }

  const storeId = retailer.storeId;
  console.log(`Found store: ${storeId}`);

  // 2. Activate store
  await db.update(retailerStores).set({ status: 'active' }).where(eq(retailerStores.id, storeId));
  console.log('Store → active');

  // 3. Activate any existing draft listings for this store
  await db.update(productListings).set({ status: 'active' }).where(
    inArray(
      productListings.id,
      (await db.query.productListings.findMany({ where: eq(productListings.storeId, storeId), columns: { id: true } })).map((l) => l.id)
    )
  );
  console.log('Existing listings → active');

  // 4. Resolve brand + category
  const genericBrand = await db.query.brands.findFirst({ where: eq(brands.slug, 'generic') });
  const apparelCat = await db.query.categories.findFirst({ where: eq(categories.slug, 'apparel') });
  const herTopsCat = await db.query.categories.findFirst({ where: eq(categories.slug, 'her-tops') });
  const herDressesCat = await db.query.categories.findFirst({ where: eq(categories.slug, 'her-dresses') });
  const himShirtsCat = await db.query.categories.findFirst({ where: eq(categories.slug, 'him-shirts') });

  const brandId = genericBrand?.id ?? null;
  const catFallback = apparelCat?.id;
  if (!catFallback) { console.error('No apparel category found — run catalog-defaults seed first'); process.exit(1); }

  const catTops = herTopsCat?.id ?? catFallback;
  const catDresses = herDressesCat?.id ?? catFallback;
  const catShirts = himShirtsCat?.id ?? catFallback;

  // 5. Add 8 new listings
  type ListingSpec = {
    name: string;
    gender: 'her' | 'him' | 'unisex';
    categoryId: string;
    badge: 'new' | 'hot' | 'trending' | 'none';
    variants: { label: string; pricePaise: number; stock: number }[];
  };

  const listingSpecs: ListingSpec[] = [
    {
      name: 'Floral Wrap Midi Dress',
      gender: 'her', categoryId: catDresses, badge: 'new',
      variants: [
        { label: 'XS / Ivory', pricePaise: paise(1499), stock: 8 },
        { label: 'S / Ivory', pricePaise: paise(1499), stock: 14 },
        { label: 'M / Ivory', pricePaise: paise(1499), stock: 10 },
        { label: 'L / Ivory', pricePaise: paise(1499), stock: 4 },
      ],
    },
    {
      name: 'Linen Co-ord Set',
      gender: 'her', categoryId: catTops, badge: 'trending',
      variants: [
        { label: 'S / Sage', pricePaise: paise(2199), stock: 12 },
        { label: 'M / Sage', pricePaise: paise(2199), stock: 18 },
        { label: 'L / Sage', pricePaise: paise(2199), stock: 7 },
        { label: 'S / Blush', pricePaise: paise(2199), stock: 9 },
        { label: 'M / Blush', pricePaise: paise(2199), stock: 11 },
      ],
    },
    {
      name: 'Embroidered Kurta',
      gender: 'her', categoryId: catTops, badge: 'hot',
      variants: [
        { label: 'S / Mustard', pricePaise: paise(999), stock: 22 },
        { label: 'M / Mustard', pricePaise: paise(999), stock: 18 },
        { label: 'L / Mustard', pricePaise: paise(999), stock: 12 },
      ],
    },
    {
      name: 'Cropped Blazer',
      gender: 'her', categoryId: catTops, badge: 'none',
      variants: [
        { label: 'XS / Black', pricePaise: paise(2799), stock: 5 },
        { label: 'S / Black', pricePaise: paise(2799), stock: 7 },
        { label: 'M / Black', pricePaise: paise(2799), stock: 3 },
        { label: 'S / Camel', pricePaise: paise(2799), stock: 6 },
      ],
    },
    {
      name: 'Slim Fit Oxford Shirt',
      gender: 'him', categoryId: catShirts, badge: 'new',
      variants: [
        { label: 'S / White', pricePaise: paise(1299), stock: 16 },
        { label: 'M / White', pricePaise: paise(1299), stock: 20 },
        { label: 'L / White', pricePaise: paise(1299), stock: 14 },
        { label: 'XL / White', pricePaise: paise(1299), stock: 8 },
        { label: 'M / Light Blue', pricePaise: paise(1299), stock: 18 },
      ],
    },
    {
      name: 'Relaxed Linen Shirt',
      gender: 'him', categoryId: catShirts, badge: 'none',
      variants: [
        { label: 'M / Ecru', pricePaise: paise(1799), stock: 10 },
        { label: 'L / Ecru', pricePaise: paise(1799), stock: 8 },
        { label: 'XL / Ecru', pricePaise: paise(1799), stock: 5 },
      ],
    },
    {
      name: 'Cotton Jogger Pants',
      gender: 'unisex', categoryId: catFallback, badge: 'none',
      variants: [
        { label: 'S / Charcoal', pricePaise: paise(899), stock: 25 },
        { label: 'M / Charcoal', pricePaise: paise(899), stock: 30 },
        { label: 'L / Charcoal', pricePaise: paise(899), stock: 20 },
      ],
    },
    {
      name: 'Printed Oversized Tee',
      gender: 'unisex', categoryId: catFallback, badge: 'trending',
      variants: [
        { label: 'S / Vintage Wash', pricePaise: paise(699), stock: 35 },
        { label: 'M / Vintage Wash', pricePaise: paise(699), stock: 42 },
        { label: 'L / Vintage Wash', pricePaise: paise(699), stock: 28 },
        { label: 'XL / Vintage Wash', pricePaise: paise(699), stock: 15 },
      ],
    },
  ];

  type VariantRec = { id: string; listingId: string; pricePaise: number; label: string; listingName: string };
  const seededVariants: VariantRec[] = [];

  for (const spec of listingSpecs) {
    const listingId = newId(IdPrefix.Listing);
    await db.insert(productListings).values({
      id: listingId,
      storeId,
      brandId,
      categoryId: spec.categoryId,
      name: spec.name,
      gender: spec.gender,
      badge: spec.badge,
      listingPolicy: 'return',
      galleryUrls: [],
      status: 'active',
    });

    for (const v of spec.variants) {
      const varId = newId(IdPrefix.Variant);
      await db.insert(variants).values({
        id: varId,
        listingId,
        attributes: { Size: v.label.split(' / ')[0] ?? 'M', Color: v.label.split(' / ')[1] ?? 'Default' },
        attributesLabel: v.label,
        imageUrls: [],
        stock: v.stock,
        reserved: 0,
        pricePaise: v.pricePaise,
      });
      seededVariants.push({ id: varId, listingId, pricePaise: v.pricePaise, label: v.label, listingName: spec.name });
    }
    console.log(`  Listing "${spec.name}" + ${spec.variants.length} variants`);
  }

  // 6. Consumers
  const consumerPwd = await hashPassword('Consumer@1234');
  const consumerSpecs = [
    { name: 'Priya Sharma', email: 'priya.s.demo.closetx@gmail.com', phone: '9801234567' },
    { name: 'Rahul Mehta', email: 'rahul.m.demo.closetx@gmail.com', phone: '9812345678' },
    { name: 'Ananya Patel', email: 'ananya.p.demo.closetx@gmail.com', phone: '9823456789' },
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
      await db.insert(consumers).values({ id: consumerId, email: cs.email, phone: cs.phone, name: cs.name, passwordHash: consumerPwd, status: 'active' });
      addrId = newId(IdPrefix.Address);
      await db.insert(addresses).values({ id: addrId, consumerId, label: 'home', line1: '101, Sea View Apts, Juhu', city: 'Mumbai', pincode: '400049', stateCode: 'MH', lat: 19.1075, lng: 72.8263 });
    }
    consumerRecs.push({ id: consumerId, name: cs.name, email: cs.email, phone: cs.phone, addressId: addrId });
  }
  console.log(`${consumerRecs.length} consumers ready`);

  // 7. Orders — 50 across 30 days
  type OStatus = 'pending' | 'confirmed' | 'accepted' | 'packed' | 'delivered' | 'cancelled';
  type OSpec = { daysBack: number; hour: number; status: OStatus; variantIdx: number; qty: number; cIdx: number };

  const specs: OSpec[] = [
    // 30 delivered
    { daysBack: 29, hour: 9, status: 'delivered', variantIdx: 0, qty: 1, cIdx: 0 },
    { daysBack: 28, hour: 11, status: 'delivered', variantIdx: 5, qty: 2, cIdx: 1 },
    { daysBack: 27, hour: 14, status: 'delivered', variantIdx: 8, qty: 1, cIdx: 2 },
    { daysBack: 26, hour: 10, status: 'delivered', variantIdx: 12, qty: 1, cIdx: 0 },
    { daysBack: 25, hour: 16, status: 'delivered', variantIdx: 18, qty: 2, cIdx: 1 },
    { daysBack: 24, hour: 9, status: 'delivered', variantIdx: 22, qty: 1, cIdx: 2 },
    { daysBack: 23, hour: 13, status: 'delivered', variantIdx: 25, qty: 3, cIdx: 0 },
    { daysBack: 22, hour: 11, status: 'delivered', variantIdx: 28, qty: 1, cIdx: 1 },
    { daysBack: 21, hour: 15, status: 'delivered', variantIdx: 2, qty: 1, cIdx: 2 },
    { daysBack: 20, hour: 10, status: 'delivered', variantIdx: 6, qty: 2, cIdx: 0 },
    { daysBack: 19, hour: 14, status: 'delivered', variantIdx: 9, qty: 1, cIdx: 1 },
    { daysBack: 18, hour: 9, status: 'delivered', variantIdx: 13, qty: 1, cIdx: 2 },
    { daysBack: 17, hour: 16, status: 'delivered', variantIdx: 19, qty: 2, cIdx: 0 },
    { daysBack: 16, hour: 11, status: 'delivered', variantIdx: 23, qty: 1, cIdx: 1 },
    { daysBack: 15, hour: 13, status: 'delivered', variantIdx: 26, qty: 2, cIdx: 2 },
    { daysBack: 14, hour: 10, status: 'delivered', variantIdx: 29, qty: 3, cIdx: 0 },
    { daysBack: 13, hour: 14, status: 'delivered', variantIdx: 1, qty: 1, cIdx: 1 },
    { daysBack: 12, hour: 9, status: 'delivered', variantIdx: 7, qty: 1, cIdx: 2 },
    { daysBack: 11, hour: 15, status: 'delivered', variantIdx: 10, qty: 2, cIdx: 0 },
    { daysBack: 10, hour: 11, status: 'delivered', variantIdx: 14, qty: 1, cIdx: 1 },
    { daysBack: 9, hour: 13, status: 'delivered', variantIdx: 20, qty: 1, cIdx: 2 },
    { daysBack: 8, hour: 10, status: 'delivered', variantIdx: 24, qty: 2, cIdx: 0 },
    { daysBack: 7, hour: 16, status: 'delivered', variantIdx: 27, qty: 1, cIdx: 1 },
    { daysBack: 6, hour: 9, status: 'delivered', variantIdx: 30, qty: 2, cIdx: 2 },
    { daysBack: 5, hour: 14, status: 'delivered', variantIdx: 3, qty: 1, cIdx: 0 },
    { daysBack: 4, hour: 11, status: 'delivered', variantIdx: 4, qty: 1, cIdx: 1 },
    { daysBack: 3, hour: 10, status: 'delivered', variantIdx: 11, qty: 3, cIdx: 2 },
    { daysBack: 2, hour: 15, status: 'delivered', variantIdx: 15, qty: 1, cIdx: 0 },
    { daysBack: 2, hour: 17, status: 'delivered', variantIdx: 21, qty: 2, cIdx: 1 },
    { daysBack: 1, hour: 10, status: 'delivered', variantIdx: 16, qty: 1, cIdx: 2 },
    // 5 confirmed
    { daysBack: 1, hour: 14, status: 'confirmed', variantIdx: 17, qty: 2, cIdx: 0 },
    { daysBack: 1, hour: 16, status: 'confirmed', variantIdx: 0, qty: 1, cIdx: 1 },
    { daysBack: 0, hour: 9, status: 'confirmed', variantIdx: 5, qty: 2, cIdx: 2 },
    { daysBack: 0, hour: 10, status: 'confirmed', variantIdx: 8, qty: 1, cIdx: 0 },
    { daysBack: 0, hour: 11, status: 'confirmed', variantIdx: 12, qty: 1, cIdx: 1 },
    // 5 accepted/packed
    { daysBack: 0, hour: 12, status: 'accepted', variantIdx: 18, qty: 1, cIdx: 2 },
    { daysBack: 0, hour: 13, status: 'accepted', variantIdx: 22, qty: 2, cIdx: 0 },
    { daysBack: 0, hour: 14, status: 'packed', variantIdx: 25, qty: 1, cIdx: 1 },
    { daysBack: 0, hour: 15, status: 'packed', variantIdx: 28, qty: 1, cIdx: 2 },
    { daysBack: 0, hour: 16, status: 'packed', variantIdx: 2, qty: 3, cIdx: 0 },
    // 5 cancelled
    { daysBack: 20, hour: 11, status: 'cancelled', variantIdx: 6, qty: 1, cIdx: 1 },
    { daysBack: 14, hour: 9, status: 'cancelled', variantIdx: 9, qty: 2, cIdx: 2 },
    { daysBack: 9, hour: 14, status: 'cancelled', variantIdx: 13, qty: 1, cIdx: 0 },
    { daysBack: 4, hour: 10, status: 'cancelled', variantIdx: 19, qty: 1, cIdx: 1 },
    { daysBack: 1, hour: 15, status: 'cancelled', variantIdx: 23, qty: 2, cIdx: 2 },
    // 5 pending
    { daysBack: 0, hour: 17, status: 'pending', variantIdx: 26, qty: 1, cIdx: 0 },
    { daysBack: 0, hour: 18, status: 'pending', variantIdx: 29, qty: 2, cIdx: 1 },
    { daysBack: 0, hour: 19, status: 'pending', variantIdx: 1, qty: 1, cIdx: 2 },
    { daysBack: 0, hour: 20, status: 'pending', variantIdx: 7, qty: 1, cIdx: 0 },
    { daysBack: 0, hour: 21, status: 'pending', variantIdx: 10, qty: 2, cIdx: 1 },
  ];

  let n = 0;
  for (const spec of specs) {
    const consumer = consumerRecs[spec.cIdx % consumerRecs.length]!;
    const variant = seededVariants[spec.variantIdx % seededVariants.length]!;

    const unitPricePaise = variant.pricePaise;
    const linePaise = unitPricePaise * spec.qty;
    const { taxPaise, cgstPaise, sgstPaise, igstPaise } = intraGst(linePaise);
    const deliveryFeePaise = paise(49);
    const grandTotalPaise = linePaise + taxPaise + deliveryFeePaise;

    const placedAt = daysAgo(spec.daysBack, spec.hour - 8);
    const deliveredAt = spec.status === 'delivered'
      ? new Date(placedAt.getTime() + 2 * 86400000) : null;

    const groupId = newId(IdPrefix.OrderGroup);
    const orderId = newId(IdPrefix.Order);

    await db.insert(orderGroups).values({
      id: groupId,
      consumerId: consumer.id,
      status: spec.status === 'delivered' ? 'all_delivered' : spec.status === 'cancelled' ? 'all_cancelled' : 'in_flight',
      placedAt,
    });

    await db.insert(orders).values({
      id: orderId, groupId,
      consumerId: consumer.id,
      storeId,
      addressId: consumer.addressId,
      deliveryMethod: 'standard',
      paymentMethod: 'upi',
      paymentMethodLabel: 'UPI · GPay',
      status: spec.status,
      consumerNameSnap: consumer.name,
      consumerEmailSnap: consumer.email,
      consumerPhoneSnap: consumer.phone,
      addressLine1Snap: '101, Sea View Apts, Juhu',
      addressCitySnap: 'Mumbai',
      addressPincodeSnap: '400049',
      addressStateCodeSnap: 'MH',
      addressLatSnap: 19.1075,
      addressLngSnap: 72.8263,
      storeNameSnap: 'HAHAHAHAHHAHAHAHHAHAHH',
      storeAddressSnap: 'Mumbai, MH',
      storeGstinSnap: '27AAFCK0000M1Z5',
      storeStateCodeSnap: 'MH',
      itemsSubtotalPaise: linePaise,
      retailerPromoPaise: 0, platformPromoPaise: 0, couponPaise: 0,
      pointsRedeemedPaise: 0, walletAppliedPaise: 0,
      taxPaise, taxSplitKind: 'intra_state', cgstPaise, sgstPaise, igstPaise,
      deliveryFeePaise, handlingFeePaise: 0, convenienceFeePaise: 0,
      grandTotalPaise,
      platformFeeBpSnap: 200,
      placedAt,
      ...(spec.status !== 'pending' && spec.status !== 'confirmed' ? { acceptedAt: new Date(placedAt.getTime() + 1800000) } : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(spec.status === 'delivered' || spec.status === 'cancelled' ? { closedAt: deliveredAt ?? new Date(placedAt.getTime() + 3600000) } : {}),
      idempotencyKey: `kaush_${orderId}`,
    });

    const gstAllocPaise = Math.round(linePaise * 0.05);
    await db.insert(orderItems).values({
      id: newId(IdPrefix.OrderItem),
      orderId,
      listingId: variant.listingId,
      variantId: variant.id,
      listingNameSnap: variant.listingName,
      brandSnap: 'Generic',
      categorySnap: 'Apparel',
      attributesLabelSnap: variant.label,
      listingPolicySnap: 'return',
      qty: spec.qty,
      unitPricePaise,
      lineSubtotalPaise: linePaise,
      retailerPromoAllocPaise: 0, platformPromoAllocPaise: 0,
      couponAllocPaise: 0, pointsAllocPaise: 0,
      gstRateBp: 500, gstAllocPaise,
      netLinePaise: linePaise + gstAllocPaise,
      outcome: spec.status === 'delivered' ? 'delivered_kept' : spec.status === 'cancelled' ? 'cancelled' : 'pending_delivery',
    });

    await db.insert(orderTransitions).values({
      id: newId(IdPrefix.OrderTransition),
      orderId,
      fromStatus: null,
      toStatus: 'pending',
      actorType: 'consumer',
      actorId: consumer.id,
      at: placedAt,
    });

    const payStatus = spec.status === 'cancelled' ? 'failed' : spec.status === 'pending' ? 'pending' : 'succeeded';
    // Both 'failed' and 'succeeded' require settledAt per the payments check constraint.
    const settledAt = payStatus !== 'pending' ? new Date(placedAt.getTime() + 300000) : undefined;
    await db.insert(payments).values({
      id: newId(IdPrefix.Payment),
      orderId,
      method: 'upi',
      amountPaise: grandTotalPaise,
      status: payStatus,
      ...(payStatus === 'succeeded' ? { gatewayRef: `razorpay_demo_${n}` } : {}),
      ...(settledAt ? { settledAt } : {}),
      idempotencyKey: `kaush_pay_${orderId}`,
      initiatedAt: placedAt,
    });

    n++;
    if (n % 10 === 0) console.log(`  ${n} orders seeded…`);
  }

  console.log(`Done. ${n} orders seeded for ${TARGET_EMAIL}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
