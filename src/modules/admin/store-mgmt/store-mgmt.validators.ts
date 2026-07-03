import { z } from 'zod';

const HoursSchema = z
  .record(z.string(), z.array(z.object({ open: z.string(), close: z.string() })))
  .optional();

export const IdParam = z.object({ id: z.string() });

export const StoreCreateBody = z.object({
  legalEntityId: z.string(),
  storeName: z.string().trim().min(1).max(200),
  gstin: z.string().trim().min(1),
  pan: z.string().trim().optional(),
  address: z.string().trim().min(1),
  stateCode: z.string().trim().min(2).max(3),
  lat: z.number(),
  lng: z.number(),
  openingHours: HoursSchema,
  platformFeeBp: z.number().int().min(0).max(10_000).default(1500),
  payoutCadenceDays: z.number().int().min(1).max(30).default(7),
});

export const StoreEditBody = z
  .object({
    storeName: z.string().trim().min(1).max(200).optional(),
    // Admin override of the KYC-verified GSTIN (the "without change request" path).
    gstin: z.string().trim().toUpperCase().length(15, 'GSTIN must be exactly 15 characters').optional(),
    address: z.string().trim().min(1).optional(),
    stateCode: z.string().trim().min(2).max(3).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    openingHours: HoursSchema,
    contactPhone: z.string().trim().max(20).optional().nullable(),
    managerName: z.string().trim().max(100).optional().nullable(),
    platformFeeBp: z.number().int().min(0).max(10_000).optional(),
    payoutCadenceDays: z.number().int().min(1).max(30).optional(),
    platformFeeReason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' })
  .refine(
    (v) =>
      v.platformFeeBp === undefined ||
      (typeof v.platformFeeReason === 'string' && v.platformFeeReason.length >= 3),
    {
      message: 'platformFeeReason is required when platformFeeBp changes',
      path: ['platformFeeReason'],
    },
  );

export const PauseBody = z.object({
  reason: z.string().trim().min(1).max(500),
  visibility: z.enum(['visible', 'hidden']).default('visible'),
  until: z.string().datetime().optional(),
});

export const ReasonBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const OptionalReasonBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);
