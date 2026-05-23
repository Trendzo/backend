import { z } from 'zod';

export const OrderStatusEnum = z.enum([
  'pending',
  'confirmed',
  'routing',
  'accepted',
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'undelivered',
  'returning_to_store',
  'returned_to_store',
  'delivered',
  'cancelled',
  'payment_failed',
  'closed',
]);

export const IdParam = z.object({ id: z.string() });

export const ListQuery = z.object({
  status: OrderStatusEnum.optional(),
  statusIn: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export const PickupHandoverBody = z.object({
  pickupCode: z.string().trim().min(4).max(16),
});

export const HandoverBody = z
  .object({
    agentName: z.string().trim().min(1).max(120).optional(),
    agentPhone: z.string().trim().min(1).max(20).optional(),
  })
  .default({});

export const MarkDeliveredBody = z
  .object({
    note: z.string().trim().max(500).optional(),
    proofPhotoUrl: z.string().url().optional(),
  })
  .default({});

export const MarkUndeliveredBody = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const RequestCancelBody = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const DoorExtendBody = z.object({
  reason: z.string().trim().min(3).max(300).default('one_time_extension'),
});

export const DoorCloseBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        decision: z.enum(['kept', 'returned', 'refused']),
        reason: z.string().trim().max(500).optional(),
        photos: z.array(z.string().url()).optional(),
      }),
    )
    .min(1),
});
