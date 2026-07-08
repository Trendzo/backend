import { z } from 'zod';

export const StoreParam = z.object({ storeId: z.string() });
export const StoreOrderParam = z.object({ storeId: z.string(), orderId: z.string() });

export const HandoverBody = z
  .object({
    // Verify the dispatched driver's handoff code (mirrors the retailer handover), OR hand
    // to an external courier by name/phone (no code).
    handoffCode: z.string().trim().min(4).max(16).optional(),
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

export const BulkOrderIdsBody = z.object({
  orderIds: z.array(z.string()).min(1).max(100),
});
