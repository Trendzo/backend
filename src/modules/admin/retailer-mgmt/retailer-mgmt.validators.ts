import { z } from 'zod';
import { EmailSchema, IntlPhoneSchema, PasswordSchema } from '@/shared/validation/common.js';

const HoursSchema = z
  .record(z.string(), z.array(z.object({ open: z.string(), close: z.string() })))
  .optional();

export const IdParam = z.object({ id: z.string() });

export const RetailerCreateBody = z.object({
  legalName: z.string().trim().min(1).max(200),
  ownerEmail: EmailSchema,
  ownerPhone: IntlPhoneSchema,
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

/**
 * Phone edit — normalise to E.164 the same way migration 0038 did (bare 10-digit
 * Indian → `+91…`, otherwise keep the supplied country code). Keeps admin edits
 * consistent with the `retailer_accounts_phone_idx` unique index.
 */
const EditPhoneSchema = z
  .string()
  .trim()
  .transform((raw, ctx) => {
    const digits = raw.replace(/\D/g, '');
    const e164 = digits.length === 10 ? `+91${digits}` : `+${digits}`;
    if (!/^\+[1-9]\d{7,14}$/.test(e164)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid phone number' });
      return z.NEVER;
    }
    return e164;
  });

export const RetailerEditBody = z
  .object({
    legalName: z.string().trim().min(1).max(200).optional(),
    phone: EditPhoneSchema.optional(),
    email: EmailSchema.optional(),
    subRole: z.enum(['owner', 'manager', 'staff']).optional(),
    gstin: z.string().trim().min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const ReasonBody = z.object({ reason: z.string().trim().min(1).max(500) });

export const OptionalReasonBody = z.preprocess(
  (v) => (v == null ? {} : v),
  z.object({ reason: z.string().trim().max(500).optional() }),
);

export const PosBillingBody = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
