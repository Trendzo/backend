import { z } from 'zod';

export const OrderParam = z.object({ id: z.string() });
export const OrderItemParam = z.object({ id: z.string(), itemId: z.string() });
