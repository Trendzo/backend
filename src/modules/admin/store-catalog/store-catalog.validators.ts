import { z } from 'zod';

export const StoreParam = z.object({ storeId: z.string() });
export const StoreListingParam = z.object({ storeId: z.string(), listingId: z.string() });
export const StoreVariantParam = z.object({ storeId: z.string(), variantId: z.string() });
export const StoreOrderParam = z.object({ storeId: z.string(), orderId: z.string() });

export const ListListingsQuery = z.object({
  status: z.enum(['draft', 'active', 'retired']).optional(),
});

export const PatchListingBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(['draft', 'active', 'retired']).optional(),
    brandId: z.string().nullable().optional(),
    categoryId: z.string().optional(),
    hsn: z.string().trim().max(20).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const PatchVariantBody = z
  .object({
    sku: z.string().trim().max(64).nullable().optional(),
    pricePaise: z.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const InventoryListQuery = z.object({
  q: z.string().trim().optional(),
  status: z.enum(['active', 'draft', 'retired', 'taken_down']).optional(),
  flag: z.enum(['low', 'out', 'all', 'oversold', 'in_stock']).optional(),
  categoryId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const ReservationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const InventoryAdjustBody = z.object({
  variantId: z.string(),
  delta: z.number().int(),
  note: z.string().trim().max(500).optional(),
});

export const OrdersListQuery = z.object({ status: z.string().optional() });
