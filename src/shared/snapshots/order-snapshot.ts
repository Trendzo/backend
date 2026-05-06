/**
 * Pure builders for the order/order_item snapshot bags. Used by the checkout module
 * (Phase 7) to populate every *_snap field on orders and order_items at placement time.
 *
 * Per Design Principle 8: once placed, an order is self-contained. These functions are
 * the single point where live-entity state is frozen onto the order.
 */

import type {
  addresses,
  consumers,
  productListings,
  retailerStores,
  variants,
} from '@/db/schema/index.js';

type Consumer = typeof consumers.$inferSelect;
type Address = typeof addresses.$inferSelect;
type Store = typeof retailerStores.$inferSelect;
type Listing = typeof productListings.$inferSelect;
type Variant = typeof variants.$inferSelect;

/**
 * Build the consumer + address + store snapshot fields for an order. Pass `address = null`
 * for pickup orders (no delivery address).
 */
export function buildOrderSnapshot(input: {
  consumer: Pick<Consumer, 'name' | 'email' | 'phone'>;
  address: Pick<
    Address,
    'line1' | 'line2' | 'city' | 'pincode' | 'stateCode' | 'lat' | 'lng'
  > | null;
  store: Pick<Store, 'legalName' | 'address' | 'gstin' | 'stateCode' | 'platformFeeBp'>;
}): {
  consumerNameSnap: string;
  consumerEmailSnap: string;
  consumerPhoneSnap: string;
  addressLine1Snap: string | null;
  addressLine2Snap: string | null;
  addressCitySnap: string | null;
  addressPincodeSnap: string | null;
  addressStateCodeSnap: string | null;
  addressLatSnap: number | null;
  addressLngSnap: number | null;
  storeNameSnap: string;
  storeAddressSnap: string;
  storeGstinSnap: string;
  storeStateCodeSnap: string;
  platformFeeBpSnap: number;
} {
  return {
    consumerNameSnap: input.consumer.name,
    consumerEmailSnap: input.consumer.email,
    consumerPhoneSnap: input.consumer.phone,
    addressLine1Snap: input.address?.line1 ?? null,
    addressLine2Snap: input.address?.line2 ?? null,
    addressCitySnap: input.address?.city ?? null,
    addressPincodeSnap: input.address?.pincode ?? null,
    addressStateCodeSnap: input.address?.stateCode ?? null,
    addressLatSnap: input.address?.lat ?? null,
    addressLngSnap: input.address?.lng ?? null,
    storeNameSnap: input.store.legalName,
    storeAddressSnap: input.store.address,
    storeGstinSnap: input.store.gstin,
    storeStateCodeSnap: input.store.stateCode,
    platformFeeBpSnap: input.store.platformFeeBp,
  };
}

/**
 * Build the listing + variant snapshot fields for one order_item. The first gallery URL
 * is captured as the canonical thumbnail; later listing edits don't affect this row.
 *
 * `brandName` and `categoryLabel` are passed in by the caller — both moved to FK lookups,
 * so the caller is the right place to resolve them (single round-trip in checkout instead
 * of hidden joins inside this helper).
 */
export function buildOrderItemSnapshot(input: {
  listing: Pick<Listing, 'name' | 'hsn' | 'galleryUrls' | 'listingPolicy'>;
  variant: Pick<Variant, 'attributesLabel'>;
  brandName: string;
  categoryLabel: string;
}): {
  listingNameSnap: string;
  brandSnap: string;
  categorySnap: string;
  hsnSnap: string | null;
  galleryImageSnap: string | null;
  attributesLabelSnap: string;
  listingPolicySnap: Listing['listingPolicy'];
} {
  return {
    listingNameSnap: input.listing.name,
    brandSnap: input.brandName,
    categorySnap: input.categoryLabel,
    hsnSnap: input.listing.hsn,
    galleryImageSnap: input.listing.galleryUrls[0] ?? null,
    attributesLabelSnap: input.variant.attributesLabel,
    listingPolicySnap: input.listing.listingPolicy,
  };
}
