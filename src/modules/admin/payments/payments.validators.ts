import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const DiscrepancyParams = z.object({
  settlementId: z.string(),
  dId: z.string(),
});

export const ContactConsumerBody = z
  .object({ note: z.string().trim().min(3).max(500).optional() })
  .optional();

export const ReleaseInventoryBody = z
  .object({ reason: z.string().trim().min(3).max(500).optional() })
  .optional();

export const SettlementUploadBody = z
  .object({
    gatewayName: z.string().trim().min(1).max(40),
    cycleStart: z.coerce.date(),
    cycleEnd: z.coerce.date(),
    fileRef: z.string().trim().max(500).optional(),
    payload: z.string().min(1),
  })
  .refine((v) => v.cycleEnd > v.cycleStart, {
    message: 'cycleEnd must be after cycleStart',
  });

export const ResolveDiscrepancyBody = z.object({
  note: z.string().trim().min(3).max(500),
});
