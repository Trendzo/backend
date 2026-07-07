import { z } from 'zod';

export const OrderIdParam = z.object({ id: z.string() });

export const AssignDriverBody = z.object({
  driverId: z.string().min(1),
});
