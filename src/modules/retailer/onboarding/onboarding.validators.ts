import { z } from 'zod';
import { GstinSchema, EmailSchema, IntlPhoneSchema } from '@/shared/validation/common.js';

export const IdParam = z.object({ id: z.string() });

export const DocKindEnum = z.enum([
  'gst_certificate',
  'pan',
  'address_proof',
  'bank_proof',
  'storefront_photo',
  'other',
]);

/**
 * Shared application-content shape used by both POST /applications and the resubmit flow.
 * Fields here mirror the writable columns on `retailer_applications`.
 */
export const ApplicationContentSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  storeName: z.string().trim().min(2).max(120).optional(),
  gstin: GstinSchema,
  pan: z.string().trim().toUpperCase().length(10).optional(),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: EmailSchema,
  ownerPhone: IntlPhoneSchema,
  addressLine: z.string().trim().min(5).max(300),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  stateCode: z.string().trim().regex(/^\d{2}$/, 'State code must be 2 digits'),
  lat: z.string().optional(),
  lng: z.string().optional(),
  hours: z.record(z.unknown()).optional(),
  categories: z.array(z.string()).optional(),
  brands: z.array(z.string()).optional(),
  sampleSkus: z.array(z.unknown()).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  managerName: z.string().trim().max(120).optional(),
  bankLegalName: z.string().trim().max(200).optional(),
  bankAccountNumber: z.string().trim().max(20).optional(),
  bankIfsc: z.string().trim().toUpperCase().max(11).optional(),
  documents: z
    .array(
      z.object({
        kind: DocKindEnum,
        url: z.string().url(),
      }),
    )
    .optional(),
});

export const SubmitApplicationBody = ApplicationContentSchema.extend({
  password: z.string().min(8).max(128).optional(),
});

export const StatusQuery = z.object({ email: EmailSchema });

export const CheckIdentityQuery = z.object({
  email: EmailSchema.optional(),
  phone: IntlPhoneSchema.optional(),
});

export const MessagesQuery = z.object({ email: EmailSchema });

export const PostMessageBody = z.object({
  applicantEmail: EmailSchema,
  body: z.string().trim().min(1).max(2000),
  attachmentUrls: z.array(z.string().url()).optional(),
});

export const FetchForResubmitBody = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});

export const ResubmitBody = ApplicationContentSchema.extend({
  email: EmailSchema,
  password: z.string().min(1).max(128),
});
