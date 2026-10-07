import { z } from 'zod';
import { StockSchema } from '@/shared/validation/common.js';

export const VariantIdParam = z.object({ variantId: z.string() });

export const ListQuery = z.object({
  q: z.string().trim().optional(),
  status: z.enum(['active', 'draft', 'retired', 'taken_down']).optional(),
  flag: z.enum(['low', 'out', 'all', 'oversold', 'in_stock']).optional(),
  categoryId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Stock adjustment. Exactly one of `delta` (signed change) or `newStock` (absolute count).
 * `reason` is written straight to inventory_adjustments.reason, so it is limited to the
 * hand-adjust values of the `inventory_adjustment_reason` enum (default `manual_edit`);
 * `note` is an optional free-text explanation stored on the same row.
 */
export const ADJUST_REASONS = ['manual_edit', 'audit_correction', 'damage_writeoff'] as const;
const INT4_MAX = 2_147_483_647;
export const AdjustBody = z
  .object({
    delta: z.number().int().min(-INT4_MAX).max(INT4_MAX).optional(),
    newStock: StockSchema.optional(),
    reason: z.enum(ADJUST_REASONS).default('manual_edit'),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => (v.delta === undefined) !== (v.newStock === undefined), {
    message: 'Provide exactly one of delta or newStock',
    path: ['delta'],
  });

export const SettingsBody = z.object({
  lowStockThreshold: z.number().int().min(0).max(100_000),
});

export const ReservationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const AdjustmentsQuery = z.object({
  variantId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ExportQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'draft', 'retired', 'taken_down']).optional(),
  flag: z.enum(['low', 'out', 'all', 'oversold', 'in_stock']).optional(),
  categoryId: z.string().optional(),
  cols: z.string().optional(),
});

export const ImportRowSchema = z
  .object({
    sku: z.string().trim().min(1).max(64).optional(),
    productName: z.string().trim().min(1).max(200).optional(),
    variantLabel: z.string().trim().min(1).max(200).optional(),
    attributes: z.string().trim().optional(),
    brand: z.string().trim().optional(),
    category: z.string().trim().optional(),
    gender: z.enum(['her', 'him', 'unisex']).optional(),
    pricePaise: z.coerce.number().int().nonnegative().optional(),
    stock: StockSchema,
  })
  .refine(
    (v) =>
      Boolean(v.sku) ||
      (Boolean(v.productName) && Boolean(v.variantLabel)) ||
      (Boolean(v.productName) && Boolean(v.attributes)),
    { message: 'Row needs sku, or productName+variantLabel, or productName+attributes' },
  );

export const ImportBody = z.object({
  rows: z.array(ImportRowSchema).min(1).max(5_000),
  dryRun: z.boolean().optional(),
});

export const BestSellersQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
