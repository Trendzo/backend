/**
 * Shared seed helpers for the retailer-app backend tests (push, orders list, inventory adjust,
 * held bills, billing statements). Everything is created fresh per call with unique ids so test
 * files and cases never collide on the shared embedded database.
 */
import { db } from '@/db/client.js';
import {
  addresses,
  categories,
  consumers,
  productListings,
  retailerAccounts,
  retailerStores,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export type SubRole = 'owner' | 'manager' | 'staff' | 'delivery_agent';

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export async function makeStore(opts: { posBillingEnabled?: boolean } = {}): Promise<string> {
  const storeId = newId(IdPrefix.Store);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: `LE_${storeId}`,
    legalName: 'Fixture Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Test Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
    posBillingEnabled: opts.posBillingEnabled ?? false,
  });
  return storeId;
}

export async function makeAccount(
  storeId: string,
  subRole: SubRole = 'owner',
  status: 'active' | 'terminated' | 'closed' | 'pending_approval' = 'active',
): Promise<{ id: string; token: string }> {
  const id = newId(IdPrefix.Retailer);
  await db.insert(retailerAccounts).values({
    id,
    storeId,
    email: `${subRole}+${id}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: `${subRole} ${id.slice(-4)}`,
    phone: subRole === 'owner' ? `+9190${Math.floor(10000000 + Math.random() * 89999999)}` : '',
    gstin: '27AAFCK1234M1Z5',
    subRole,
    status,
  });
  return { id, token: signAccessToken({ sub: id, kind: 'retailer', subRole }) };
}

/** A token for an existing account that carries NO sub-role: every permission gate 403s. */
export function tokenWithoutSubRole(accountId: string): string {
  return signAccessToken({ sub: accountId, kind: 'retailer' });
}

export async function makeVariant(
  storeId: string,
  opts: { stock?: number; reserved?: number; pricePaise?: number; name?: string } = {},
): Promise<{ variantId: string; listingId: string }> {
  const categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId,
    slug: `fx-cat-${categoryId.slice(-8)}`,
    label: 'Fixture Category',
    gender: 'unisex',
  });
  const listingId = newId(IdPrefix.Listing);
  await db.insert(productListings).values({
    id: listingId,
    storeId,
    categoryId,
    name: opts.name ?? 'Fixture Tee',
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
  const variantId = newId(IdPrefix.Variant);
  await db.insert(variants).values({
    id: variantId,
    listingId,
    storeId,
    groupId,
    attributes: {},
    attributesLabel: 'One size',
    stock: opts.stock ?? 10,
    reserved: opts.reserved ?? 0,
    pricePaise: opts.pricePaise ?? 50_000,
  });
  return { variantId, listingId };
}

export async function makeConsumer(
  name: string,
  phone: string,
): Promise<{ id: string; token: string; addressId: string }> {
  const id = newId(IdPrefix.Consumer);
  await db.insert(consumers).values({
    id,
    phone,
    name,
    email: `c+${id}@test.local`,
    status: 'active',
  });
  const addressId = newId(IdPrefix.Address);
  await db.insert(addresses).values({
    id: addressId,
    consumerId: id,
    label: 'home',
    line1: '2 Consumer Lane',
    city: 'Mumbai',
    pincode: '400001',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    isDefault: true,
  });
  return { id, token: signAccessToken({ sub: id, kind: 'consumer' }), addressId };
}
