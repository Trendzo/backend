import { z } from 'zod';

export const StoreParam = z.object({ storeId: z.string() });
export const StoreOrderParam = z.object({ storeId: z.string(), orderId: z.string() });
export const StoreReturnParam = z.object({ storeId: z.string(), returnId: z.string() });
export const StoreHeldParam = z.object({ storeId: z.string(), id: z.string() });

export const ListReturnsQuery = z.object({
  decision: z.enum(['pending', 'accepted', 'rejected']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const OpenCounterBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        reasonText: z.string().trim().max(500).optional(),
        photos: z.array(z.string().url()).optional(),
      }),
    )
    .min(1),
});

export const VerifyBody = z.object({
  decision: z.enum(['accepted', 'rejected']),
  reasonNote: z.string().trim().max(500).optional(),
  rejectPhotos: z.array(z.string().url()).max(5).optional(),
});

export const ListHeldQuery = z.object({
  status: z.enum(['holding', 'expired', 'resolved']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const RecordDispositionBody = z.object({
  disposition: z.enum(['restocked', 'forfeited_to_store', 'written_off']),
  note: z.string().trim().max(500).optional(),
});
