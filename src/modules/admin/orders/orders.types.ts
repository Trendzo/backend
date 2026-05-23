import type { z } from 'zod';
import type { OrderStatusEnum } from './orders.validators.js';

export type OrderStatusFromQuery = z.infer<typeof OrderStatusEnum>;

export type CancelRequestMarker = {
  id: string;
  orderId: string;
  reason: string | null;
  metadata: unknown;
  actorId: string | null;
  at: Date;
};
