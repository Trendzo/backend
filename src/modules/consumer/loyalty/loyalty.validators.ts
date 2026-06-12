import { z } from 'zod';

/** Shared limit/offset paging for ledger reads (mirrors admin/consumers ListQuery). */
export const TxnListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
