/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Seeds a demo retailer account (demo@closetx.local) with a full store,
 * product catalog, consumer accounts, and 30 days of order history so the
 * retailer dashboard has real analytics to display.
 *
 * Idempotent — skips each section if the anchor row already exists.
 */

import { eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
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
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';

const DEMO_EMAIL = 'demo@closetx.local';
const DEMO_PHONE = '+919800000001';
const DEMO_PASSWORD = 'Demo@1234';

// ── Helpers ──────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function paise(rupees: number): number {
  return Math.round(rupees * 100);
}

function intraGst(subtotalPaise: number): {
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
} {
  const taxPaise = Math.round(subtotalPaise * 0.05);
  const half = Math.floor(taxPaise / 2);
  return { taxPaise, cgstPaise: half, sgstPaise: taxPaise - half, igstPaise: 0 };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function seedDemoRetailer(database: typeof Db): Promise<void> {
  // 1. Retailer account
  const existing = await database.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.email, DEMO_EMAIL),
  });
  if (existing) {
    console.log(`  → demo retailer '${DEMO_EMAIL}' already exists, skipping`);
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // 2. Store (must exist before account FK)
  const storeId = newId(IdPrefix.Store);
  await database.insert(retailerStores).values({
    id: storeId,
    legalEntityId: `LE_KAUSH_001`,
    legalName: 'Kaushaly Fashion Studio',
    gstin: '27AAFCK1234M1Z5',
    pan: 'AAFCK1234M',
    address: '12, Linking Road, Bandra West, Mumbai, MH 400050',
    stateCode: 'MH',
    lat: 19.0608,
    lng: 72.8362,
    status: 'active',
    platformFeeBp: 200,
    handlingFeePaise: paise(0),
    convenienceFeePaise: paise(0),
    payoutCadenceDays: 7,
    delegationModeEnabled: false,
    // Demo store uses the POS counter (see POS sales seeded below) — keep it enabled.
    posBillingEnabled: true,
  });
  console.log(`  → seeded store ${storeId}`);

  // 3. Retailer account linked to store
  const retailerId = newId(IdPrefix.Retailer);
  await database.insert(retailerAccounts).values({
    id: retailerId,
    storeId,
    email: DEMO_EMAIL,
    passwordHash,
    legalName: 'Kaushalya Harath',
    phone: DEMO_PHONE,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  console.log(`  → seeded retailer account ${retailerId}`);

  // 4. Resolve brand + category IDs (seeded by seedCatalogDefaults)
  const [genericBrand, apparelCat, herDressesCat, herTopsCat, himShirtsCat] = await Promise.all([
    database.query.brands.findFirst({ where: eq(brands.slug, 'generic') }),
    database.query.categories.findFirst({ where: eq(categories.slug, 'apparel') }),
    database.query.categories.findFirst({ where: eq(categories.slug, 'her-dresses') }),
    database.query.categories.findFirst({ where: eq(categories.slug, 'her-tops') }),
    database.query.categories.findFirst({ where: eq(categories.slug, 'him-shirts') }),
  ]);

  const brandId = genericBrand?.id ?? null;
  const catApparel = apparelCat?.id ?? (await ensureCategory(database, 'apparel'));
  const catDresses = herDressesCat?.id ?? catApparel;
  const catTops = herTopsCat?.id ?? catApparel;
  const catShirts = himShirtsCat?.id ?? catApparel;

  // 5. Product listings
  type ListingSpec = {
    id: string;
    name: string;
    gender: 'her' | 'him' | 'unisex';
    categoryId: string;
    variants: { label: string; pricePaise: number; stock: number }[];
  };

  const listingSpecs: ListingSpec[] = [
    {
      id: newId(IdPrefix.Listing),
      name: 'Floral Wrap Dress',
      gender: 'her',
      categoryId: catDresses,
      variants: [
        { label: 'XS / Ivory', pricePaise: paise(1499), stock: 8 },
        { label: 'S / Ivory', pricePaise: paise(1499), stock: 12 },
        { label: 'M / Ivory', pricePaise: paise(1499), stock: 6 },
        { label: 'L / Ivory', pricePaise: paise(1499), stock: 4 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Solid Linen Co-ord Set',
      gender: 'her',
      categoryId: catTops,
      variants: [
        { label: 'S / Sage', pricePaise: paise(2199), stock: 10 },
        { label: 'M / Sage', pricePaise: paise(2199), stock: 15 },
        { label: 'L / Sage', pricePaise: paise(2199), stock: 7 },
        { label: 'S / Blush', pricePaise: paise(2199), stock: 9 },
        { label: 'M / Blush', pricePaise: paise(2199), stock: 11 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Embroidered Kurta',
      gender: 'her',
      categoryId: catTops,
      variants: [
        { label: 'S / Mustard', pricePaise: paise(999), stock: 20 },
        { label: 'M / Mustard', pricePaise: paise(999), stock: 18 },
        { label: 'L / Mustard', pricePaise: paise(999), stock: 14 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Cropped Blazer',
      gender: 'her',
      categoryId: catTops,
      variants: [
        { label: 'XS / Black', pricePaise: paise(2799), stock: 5 },
        { label: 'S / Black', pricePaise: paise(2799), stock: 7 },
        { label: 'M / Black', pricePaise: paise(2799), stock: 3 },
        { label: 'S / Camel', pricePaise: paise(2799), stock: 6 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Slim Fit Oxford Shirt',
      gender: 'him',
      categoryId: catShirts,
      variants: [
        { label: 'S / White', pricePaise: paise(1299), stock: 15 },
        { label: 'M / White', pricePaise: paise(1299), stock: 20 },
        { label: 'L / White', pricePaise: paise(1299), stock: 12 },
        { label: 'XL / White', pricePaise: paise(1299), stock: 8 },
        { label: 'M / Light Blue', pricePaise: paise(1299), stock: 18 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Relaxed Linen Shirt',
      gender: 'him',
      categoryId: catShirts,
      variants: [
        { label: 'M / Ecru', pricePaise: paise(1799), stock: 10 },
        { label: 'L / Ecru', pricePaise: paise(1799), stock: 8 },
        { label: 'XL / Ecru', pricePaise: paise(1799), stock: 5 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Cotton Jogger Pants',
      gender: 'unisex',
      categoryId: catApparel,
      variants: [
        { label: 'S / Charcoal', pricePaise: paise(899), stock: 25 },
        { label: 'M / Charcoal', pricePaise: paise(899), stock: 30 },
        { label: 'L / Charcoal', pricePaise: paise(899), stock: 20 },
      ],
    },
    {
      id: newId(IdPrefix.Listing),
      name: 'Printed Oversized Tee',
      gender: 'unisex',
      categoryId: catApparel,
      variants: [
        { label: 'S / Vintage Wash', pricePaise: paise(699), stock: 35 },
        { label: 'M / Vintage Wash', pricePaise: paise(699), stock: 40 },
        { label: 'L / Vintage Wash', pricePaise: paise(699), stock: 28 },
        { label: 'XL / Vintage Wash', pricePaise: paise(699), stock: 15 },
      ],
    },
  ];

  type VariantRecord = { id: string; listingId: string; pricePaise: number; label: string; stock: number };
  const variantsByListing: Record<string, VariantRecord[]> = {};

  for (const spec of listingSpecs) {
    await database.insert(productListings).values({
      id: spec.id,
      storeId,
      brandId,
      categoryId: spec.categoryId,
      name: spec.name,
      gender: spec.gender,
      listingPolicy: 'return',
      galleryUrls: [],
      variantMode: 'color_size',
      status: 'active',
    });
    await database.insert(variantGroups).values({
      id: newId(IdPrefix.VariantGroup),
      listingId: spec.id,
      storeId,
      name: 'Default',
      isDefault: true,
    });

    // Color groups first (label format is "Size / Color"), then size variants.
    const colors = [...new Set(spec.variants.map((v) => v.label.split(' / ')[1] ?? 'Default'))];
    const groupIdByColor = new Map<string, string>();
    for (const [i, color] of colors.entries()) {
      const gid = newId(IdPrefix.VariantGroup);
      await database.insert(variantGroups).values({
        id: gid,
        listingId: spec.id,
        storeId,
        name: color,
        sortOrder: i,
      });
      groupIdByColor.set(color, gid);
    }

    variantsByListing[spec.id] = [];
    for (const v of spec.variants) {
      const size = v.label.split(' / ')[0] ?? 'M';
      const color = v.label.split(' / ')[1] ?? 'Default';
      const varId = newId(IdPrefix.Variant);
      await database.insert(variants).values({
        id: varId,
        listingId: spec.id,
        storeId,
        groupId: groupIdByColor.get(color)!,
        attributes: { size, color },
        attributesLabel: v.label,
        imageUrls: [],
        stock: v.stock,
        reserved: 0,
        pricePaise: v.pricePaise,
      });
      variantsByListing[spec.id]!.push({ id: varId, listingId: spec.id, pricePaise: v.pricePaise, label: v.label, stock: v.stock });
    }
    console.log(`  → seeded listing "${spec.name}" with ${spec.variants.length} variants`);
  }

  // 6. Consumers + addresses (all MH for intra-state GST)
  type ConsumerRecord = { id: string; name: string; email: string; phone: string; addressId: string };
  const consumerPwd = await hashPassword('Consumer@1234');
  const consumerSpecs = [
    { name: 'Priya Sharma', email: 'priya.sharma.closetx@gmail.com', phone: '9811234567' },
    { name: 'Rahul Mehta', email: 'rahul.mehta.closetx@gmail.com', phone: '9822345678' },
    { name: 'Ananya Patel', email: 'ananya.patel.closetx@gmail.com', phone: '9833456789' },
  ];
  const consumerRecords: ConsumerRecord[] = [];

  for (const cs of consumerSpecs) {
    // Check if consumer already exists (email unique)
    const existing = await database.query.consumers.findFirst({ where: eq(consumers.email, cs.email) });
    let consumerId: string;
    let addrId: string;
    if (existing) {
      consumerId = existing.id;
      const existingAddr = await database.query.addresses.findFirst({ where: eq(addresses.consumerId, consumerId) });
      addrId = existingAddr?.id ?? newId(IdPrefix.Address);
    } else {
      consumerId = newId(IdPrefix.Consumer);
      await database.insert(consumers).values({
        id: consumerId,
        email: cs.email,
        phone: cs.phone,
        name: cs.name,
        passwordHash: consumerPwd,
        status: 'active',
      });
      addrId = newId(IdPrefix.Address);
      await database.insert(addresses).values({
        id: addrId,
        consumerId,
        label: 'home',
        line1: '101, Sea View Apartments, Juhu',
        city: 'Mumbai',
        pincode: '400049',
        stateCode: 'MH',
        lat: 19.1075,
        lng: 72.8263,
      });
    }
    consumerRecords.push({ id: consumerId, name: cs.name, email: cs.email, phone: cs.phone, addressId: addrId });
  }
  console.log(`  → seeded ${consumerRecords.length} consumers`);

  // 7. Orders — 50 orders spread across 30 days
  // Distribution: 30 delivered, 5 confirmed, 5 accepted/packed, 5 cancelled, 5 pending
  type OrderStatus = 'pending' | 'confirmed' | 'accepted' | 'packed' | 'delivered' | 'cancelled';

  type OrderSpec = {
    daysBack: number;
    status: OrderStatus;
    listingIdx: number;
    variantIdx: number;
    qty: number;
    consumerIdx: number;
  };

  const orderSpecs: OrderSpec[] = [
    // 30 delivered (spread over days 1–28)
    { daysBack: 28, status: 'delivered', listingIdx: 0, variantIdx: 0, qty: 1, consumerIdx: 0 },
    { daysBack: 27, status: 'delivered', listingIdx: 1, variantIdx: 1, qty: 2, consumerIdx: 1 },
    { daysBack: 26, status: 'delivered', listingIdx: 2, variantIdx: 0, qty: 1, consumerIdx: 2 },
    { daysBack: 25, status: 'delivered', listingIdx: 3, variantIdx: 1, qty: 1, consumerIdx: 0 },
    { daysBack: 24, status: 'delivered', listingIdx: 4, variantIdx: 2, qty: 2, consumerIdx: 1 },
    { daysBack: 23, status: 'delivered', listingIdx: 5, variantIdx: 0, qty: 1, consumerIdx: 2 },
    { daysBack: 22, status: 'delivered', listingIdx: 6, variantIdx: 1, qty: 3, consumerIdx: 0 },
    { daysBack: 21, status: 'delivered', listingIdx: 7, variantIdx: 2, qty: 1, consumerIdx: 1 },
    { daysBack: 20, status: 'delivered', listingIdx: 0, variantIdx: 2, qty: 1, consumerIdx: 2 },
    { daysBack: 19, status: 'delivered', listingIdx: 1, variantIdx: 3, qty: 2, consumerIdx: 0 },
    { daysBack: 18, status: 'delivered', listingIdx: 2, variantIdx: 1, qty: 1, consumerIdx: 1 },
    { daysBack: 17, status: 'delivered', listingIdx: 3, variantIdx: 2, qty: 1, consumerIdx: 2 },
    { daysBack: 16, status: 'delivered', listingIdx: 4, variantIdx: 0, qty: 2, consumerIdx: 0 },
    { daysBack: 15, status: 'delivered', listingIdx: 5, variantIdx: 1, qty: 1, consumerIdx: 1 },
    { daysBack: 14, status: 'delivered', listingIdx: 6, variantIdx: 0, qty: 2, consumerIdx: 2 },
    { daysBack: 13, status: 'delivered', listingIdx: 7, variantIdx: 1, qty: 3, consumerIdx: 0 },
    { daysBack: 12, status: 'delivered', listingIdx: 0, variantIdx: 1, qty: 1, consumerIdx: 1 },
    { daysBack: 11, status: 'delivered', listingIdx: 1, variantIdx: 2, qty: 1, consumerIdx: 2 },
    { daysBack: 10, status: 'delivered', listingIdx: 2, variantIdx: 2, qty: 2, consumerIdx: 0 },
    { daysBack: 9, status: 'delivered', listingIdx: 3, variantIdx: 0, qty: 1, consumerIdx: 1 },
    { daysBack: 8, status: 'delivered', listingIdx: 4, variantIdx: 3, qty: 1, consumerIdx: 2 },
    { daysBack: 7, status: 'delivered', listingIdx: 5, variantIdx: 2, qty: 2, consumerIdx: 0 },
    { daysBack: 6, status: 'delivered', listingIdx: 6, variantIdx: 2, qty: 1, consumerIdx: 1 },
    { daysBack: 5, status: 'delivered', listingIdx: 7, variantIdx: 0, qty: 2, consumerIdx: 2 },
    { daysBack: 4, status: 'delivered', listingIdx: 0, variantIdx: 3, qty: 1, consumerIdx: 0 },
    { daysBack: 3, status: 'delivered', listingIdx: 1, variantIdx: 4, qty: 1, consumerIdx: 1 },
    { daysBack: 3, status: 'delivered', listingIdx: 2, variantIdx: 0, qty: 3, consumerIdx: 2 },
    { daysBack: 2, status: 'delivered', listingIdx: 3, variantIdx: 3, qty: 1, consumerIdx: 0 },
    { daysBack: 2, status: 'delivered', listingIdx: 4, variantIdx: 4, qty: 2, consumerIdx: 1 },
    { daysBack: 1, status: 'delivered', listingIdx: 5, variantIdx: 2, qty: 1, consumerIdx: 2 },
    // 5 confirmed (days 0-2)
    { daysBack: 1, status: 'confirmed', listingIdx: 6, variantIdx: 1, qty: 2, consumerIdx: 0 },
    { daysBack: 1, status: 'confirmed', listingIdx: 7, variantIdx: 3, qty: 1, consumerIdx: 1 },
    { daysBack: 0, status: 'confirmed', listingIdx: 0, variantIdx: 0, qty: 1, consumerIdx: 2 },
    { daysBack: 0, status: 'confirmed', listingIdx: 1, variantIdx: 1, qty: 2, consumerIdx: 0 },
    { daysBack: 0, status: 'confirmed', listingIdx: 2, variantIdx: 2, qty: 1, consumerIdx: 1 },
    // 5 accepted/packed
    { daysBack: 0, status: 'accepted', listingIdx: 3, variantIdx: 0, qty: 1, consumerIdx: 2 },
    { daysBack: 0, status: 'accepted', listingIdx: 4, variantIdx: 1, qty: 2, consumerIdx: 0 },
    { daysBack: 0, status: 'packed', listingIdx: 5, variantIdx: 0, qty: 1, consumerIdx: 1 },
    { daysBack: 0, status: 'packed', listingIdx: 6, variantIdx: 2, qty: 1, consumerIdx: 2 },
    { daysBack: 0, status: 'packed', listingIdx: 7, variantIdx: 1, qty: 3, consumerIdx: 0 },
    // 5 cancelled
    { daysBack: 15, status: 'cancelled', listingIdx: 0, variantIdx: 1, qty: 1, consumerIdx: 1 },
    { daysBack: 12, status: 'cancelled', listingIdx: 2, variantIdx: 0, qty: 2, consumerIdx: 2 },
    { daysBack: 8, status: 'cancelled', listingIdx: 4, variantIdx: 2, qty: 1, consumerIdx: 0 },
    { daysBack: 4, status: 'cancelled', listingIdx: 6, variantIdx: 0, qty: 1, consumerIdx: 1 },
    { daysBack: 1, status: 'cancelled', listingIdx: 7, variantIdx: 2, qty: 2, consumerIdx: 2 },
    // 5 pending
    { daysBack: 0, status: 'pending', listingIdx: 0, variantIdx: 2, qty: 1, consumerIdx: 0 },
    { daysBack: 0, status: 'pending', listingIdx: 1, variantIdx: 0, qty: 2, consumerIdx: 1 },
    { daysBack: 0, status: 'pending', listingIdx: 3, variantIdx: 1, qty: 1, consumerIdx: 2 },
    { daysBack: 0, status: 'pending', listingIdx: 5, variantIdx: 1, qty: 1, consumerIdx: 0 },
    { daysBack: 0, status: 'pending', listingIdx: 7, variantIdx: 0, qty: 2, consumerIdx: 1 },
  ];

  let orderCount = 0;
  for (const spec of orderSpecs) {
    const consumer = consumerRecords[spec.consumerIdx]!;
    const listingSpec = listingSpecs[spec.listingIdx]!;
    const variantList = variantsByListing[listingSpec.id];
    const variantIdx = Math.min(spec.variantIdx, (variantList?.length ?? 1) - 1);
    const variant = variantList?.[variantIdx];
    if (!variant) continue;

    const unitPricePaise = variant.pricePaise;
    const lineSubtotalPaise = unitPricePaise * spec.qty;
    const { taxPaise, cgstPaise, sgstPaise, igstPaise } = intraGst(lineSubtotalPaise);
    const deliveryFeePaise = paise(49);
    const grandTotalPaise = lineSubtotalPaise + taxPaise + deliveryFeePaise;

    const placedAt = daysAgo(spec.daysBack);
    // Jitter within the day
    placedAt.setHours(8 + (orderCount % 12), (orderCount * 7) % 60, 0, 0);

    const deliveredAt =
      spec.status === 'delivered'
        ? new Date(placedAt.getTime() + 2 * 24 * 60 * 60 * 1000)
        : null;

    const groupId = newId(IdPrefix.OrderGroup);
    const orderId = newId(IdPrefix.Order);

    await database.insert(orderGroups).values({
      id: groupId,
      consumerId: consumer.id,
      status: spec.status === 'delivered' ? 'all_delivered' : spec.status === 'cancelled' ? 'all_cancelled' : 'in_flight',
      placedAt,
    });

    await database.insert(orders).values({
      id: orderId,
      groupId,
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

      addressLine1Snap: '101, Sea View Apartments, Juhu',
      addressCitySnap: 'Mumbai',
      addressPincodeSnap: '400049',
      addressStateCodeSnap: 'MH',
      addressLatSnap: 19.1075,
      addressLngSnap: 72.8263,

      storeNameSnap: 'Kaushaly Fashion Studio',
      storeAddressSnap: '12, Linking Road, Bandra West, Mumbai, MH 400050',
      storeGstinSnap: '27AAFCK1234M1Z5',
      storeStateCodeSnap: 'MH',

      itemsSubtotalPaise: lineSubtotalPaise,
      retailerPromoPaise: 0,
      platformPromoPaise: 0,
      couponPaise: 0,
      pointsRedeemedPaise: 0,
      walletAppliedPaise: 0,
      taxPaise,
      taxSplitKind: 'intra_state',
      cgstPaise,
      sgstPaise,
      igstPaise,
      deliveryFeePaise,
      handlingFeePaise: 0,
      convenienceFeePaise: 0,
      grandTotalPaise,

      platformFeeBpSnap: 200,

      placedAt,
      ...(spec.status === 'accepted' || spec.status === 'packed' || spec.status === 'delivered'
        ? { acceptedAt: new Date(placedAt.getTime() + 30 * 60 * 1000) }
        : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
      ...(spec.status === 'delivered' || spec.status === 'cancelled'
        ? { closedAt: deliveredAt ?? new Date(placedAt.getTime() + 60 * 60 * 1000) }
        : {}),

      idempotencyKey: `demo_${orderId}`,
    });

    // Order item
    const gstRateBp = 500; // 5%
    const gstAllocPaise = Math.round(lineSubtotalPaise * 0.05);
    const netLinePaise = lineSubtotalPaise - 0 + gstAllocPaise;

    await database.insert(orderItems).values({
      id: newId(IdPrefix.OrderItem),
      orderId,
      listingId: listingSpec.id,
      variantId: variant.id,

      listingNameSnap: listingSpec.name,
      brandSnap: 'Generic',
      categorySnap: 'Apparel',
      attributesLabelSnap: variant.label,
      listingPolicySnap: 'return',

      qty: spec.qty,
      unitPricePaise,
      lineSubtotalPaise,
      retailerPromoAllocPaise: 0,
      platformPromoAllocPaise: 0,
      couponAllocPaise: 0,
      pointsAllocPaise: 0,
      gstRateBp,
      gstAllocPaise,
      netLinePaise,

      outcome: spec.status === 'delivered' ? 'delivered_kept' : spec.status === 'cancelled' ? 'cancelled' : 'pending_delivery',
    });

    // Initial transition
    await database.insert(orderTransitions).values({
      id: newId(IdPrefix.OrderTransition),
      orderId,
      fromStatus: null,
      toStatus: 'pending',
      actorType: 'consumer',
      actorId: consumer.id,
      at: placedAt,
    });

    // Payment (succeeded for delivered/active, pending for pending, cancelled for cancelled)
    const payStatus =
      spec.status === 'cancelled' ? 'failed' :
      spec.status === 'pending' ? 'pending' : 'succeeded';
    const settledAt =
      payStatus === 'succeeded' || payStatus === 'failed'
        ? new Date(placedAt.getTime() + 5 * 60 * 1000)
        : undefined;

    await database.insert(payments).values({
      id: newId(IdPrefix.Payment),
      orderId,
      method: 'upi',
      amountPaise: grandTotalPaise,
      status: payStatus,
      ...(payStatus === 'succeeded' ? { gatewayRef: `pay_demo_${orderCount}` } : {}),
      ...(settledAt ? { settledAt } : {}),
      idempotencyKey: `demo_pay_${orderId}`,
      initiatedAt: placedAt,
    });

    orderCount++;
  }

  console.log(`  → seeded ${orderCount} orders`);
}

// Fallback: insert a minimal category if catalog-defaults hasn't run yet
async function ensureCategory(database: typeof Db, _slug: string): Promise<string> {
  const id = newId(IdPrefix.Category);
  await database.insert(categories).values({
    id,
    slug: `apparel-${id}`,
    label: 'Apparel',
    gender: 'unisex',
    sortOrder: 10,
    isActive: true,
  }).onConflictDoNothing();
  return id;
}
