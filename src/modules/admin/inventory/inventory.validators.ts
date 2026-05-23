import { z } from 'zod';

export const AdjustmentReasonEnum = z.enum([
  'manual_edit',
  'csv_import',
  'order_reservation',
  'order_confirmation',
  'order_cancellation',
  'return_restock',
  'damage_writeoff',
  'audit_correction',
]);

export const ListAdjustmentsQuery = z.object({
  variantId: z.string().optional(),
  reason: AdjustmentReasonEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const CreateAdjustmentBody = z.object({
  variantId: z.string(),
  delta: z.number().int(),
  reason: AdjustmentReasonEnum,
  refKind: z.string().optional(),
  refId: z.string().optional(),
  note: z.string().trim().max(500).optional(),
});

export const ListReservationsQuery = z.object({
  variantId: z.string().optional(),
  ownerKind: z.string().optional(),
  active: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
