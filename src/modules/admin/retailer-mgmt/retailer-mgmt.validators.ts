import { z } from 'zod';
import { EmailSchema, PasswordSchema } from '@/shared/validation/common.js';

const HoursSchema = z
  .record(z.string(), z.array(z.object({ open: z.string(), close: z.string() })))
  .optional();

export const IdParam = z.object({ id: z.string() });

export const RetailerCreateBody = z.object({
  legalName: z.string().trim().min(1).max(200),
  ownerEmail: EmailSchema,
  ownerPhone: z.string().trim().min(6).max(20),
  password: PasswordSchema,
  gstin: z.string().trim().min(1),
  pan: z.string().trim().optional(),
  store: z.object({
    storeName: z.string().trim().min(1).max(200),
    address: z.string().trim().min(1),
    stateCode: z.string().trim().min(2).max(3),
    lat: z.number(),
    lng: z.number(),
    openingHours: HoursSchema,
    platformFeeBp: z.number().int().min(0).max(10_000).default(1500),
    payoutCadenceDays: z.number().int().min(1).max(30).default(7),
  }),
  bank: z
    .object({
      accountNumber: z.string().trim().min(1),
      ifsc: z.string().trim().min(1),
      legalName: z.string().trim().min(1),
    })
    .optional(),
});

export const RetailerEditBody = z
  .object({
    legalName: z.string().trim().min(1).max(200).optional(),
    phone: z.string().trim().min(6).max(20).optional(),
    gstin: z.string().trim().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const ReasonBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const OptionalReasonBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);
