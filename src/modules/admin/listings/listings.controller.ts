/**
 * Admin-side listing search for the collection picker + global Listings search page.
 */
import { and, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { productListings, retailerStores } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { SearchQuery } from './listings.validators.js';

export async function searchListings(input: { query: z.infer<typeof SearchQuery> }) {
  const filters = [];
  if (input.query.q) {
    const needle = `%${input.query.q}%`;
    filters.push(
      or(ilike(productListings.name, needle), ilike(productListings.description, needle))!,
    );
  }
  if (input.query.brandId) filters.push(eq(productListings.brandId, input.query.brandId));
  if (input.query.categoryId) filters.push(eq(productListings.categoryId, input.query.categoryId));
  if (input.query.gender) filters.push(eq(productListings.gender, input.query.gender));
  if (input.query.status) filters.push(eq(productListings.status, input.query.status));
  const where = filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);
  const rows = await db.query.productListings.findMany({
    ...(where && { where }),
    orderBy: desc(productListings.createdAt),
    limit: input.query.limit,
  });
  if (rows.length === 0) return ok([]);

  // Attach store legal name so the admin UI can show it instead of storeId.
  const storeIds = Array.from(new Set(rows.map((r) => r.storeId)));
  const stores = await db
    .select({ id: retailerStores.id, name: retailerStores.legalName })
    .from(retailerStores)
    .where(inArray(retailerStores.id, storeIds));
  const storeMap = new Map(stores.map((s) => [s.id, s.name]));

  return ok(rows.map((r) => ({ ...r, storeName: storeMap.get(r.storeId) ?? r.storeId })));
}
