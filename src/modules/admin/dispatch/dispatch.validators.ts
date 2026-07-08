import { z } from 'zod';

export const OrderIdParam = z.object({ id: z.string() });

export const AssignDriverBody = z.object({
  driverId: z.string().min(1),
});

export const ListReversePickupsQuery = z.object({
  status: z
    .enum(['pending', 'assigned', 'collected', 'delivered_to_store', 'cancelled'])
    .optional(),
});

export const CreateReversePickupBody = z.object({
  orderId: z.string().min(1),
  returnIds: z.array(z.string().min(1)).min(1),
});
