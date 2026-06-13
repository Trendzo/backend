import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const ListDeliveriesQuery = z.object({
  // Defaults to the agent's active legs (picked_up / out_for_delivery / at_door).
  status: z
    .enum(['picked_up', 'out_for_delivery', 'at_door', 'delivered', 'undelivered'])
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export const DoorExtendBody = z.object({
  reason: z.string().trim().min(3).max(300).default('one_time_extension'),
});

export const DoorCloseBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        decision: z.enum(['kept', 'returned', 'refused', 'return_rejected']),
        reason: z.string().trim().max(500).optional(),
        photos: z.array(z.string().url()).optional(),
      }),
    )
    .min(1),
  // Consumer-spoken delivery OTP. Required (and verified) when the order carries one;
  // legacy orders placed before the OTP column may close without it.
  otp: z.string().trim().min(4).max(8).optional(),
});

export const MarkUndeliveredBody = z.object({
  reason: z.string().trim().min(3).max(500),
  photos: z.array(z.string().url()).optional(),
});
