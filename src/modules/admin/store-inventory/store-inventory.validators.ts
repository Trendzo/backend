import { z } from 'zod';
import { StockSchema } from '@/shared/validation/common.js';

export const StoreParam = z.object({ storeId: z.string() });

export const ImportBody = z.object({
  rows: z
    .array(z.object({ sku: z.string().trim().min(1).max(64), stock: StockSchema }))
    .min(1)
    .max(5_000),
});

export const ExportQuery = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'draft', 'retired']).optional(),
  flag: z.enum(['low', 'out', 'all']).optional(),
});
