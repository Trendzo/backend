import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

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
  // Accept only. Declining a return goes through /returns/:id/decline (opens a dispute).
  decision: z.literal('accepted'),
  reasonNote: z.string().trim().max(500).optional(),
});

export const DeclineBody = z.object({
  reasonNote: z.string().trim().max(500).optional(),
  rejectPhotos: z.array(z.string().url()).max(5).optional(),
});

export const ListHeldQuery = z.object({
  status: z.enum(['holding', 'expired', 'resolved']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const StandardReturnBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        reasonText: z.string().trim().max(500).optional(),
        reasonCategory: z.enum([
          'damaged',
          'wrong_item',
          'not_as_described',
          'doesnt_fit',
          'other',
        ]),
        consumerPhotos: z.array(z.string().url()).default([]),
      }),
    )
    .min(1),
});

export const RecordDispositionBody = z.object({
  disposition: z.enum(['restocked', 'forfeited_to_store', 'written_off']),
  note: z.string().trim().max(500).optional(),
});
