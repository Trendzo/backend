import { z } from 'zod';
import { PasswordSchema } from '@/shared/validation/common.js';

export const IdParam = z.object({ id: z.string() });

export const ListApplicationsQuery = z.object({
  status: z.enum(['pending', 'docs_requested', 'approved', 'rejected']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const UpdateStatusBody = z.object({
  status: z.enum(['docs_requested']),
  reason: z.string().trim().max(500).optional(),
});

export const ApproveBody = z.object({
  // Optional if the applicant set a password during signup.
  tempPassword: PasswordSchema.optional(),
  note: z.string().trim().max(500).optional(),
  // Platform fee in basis points (e.g. 1000 = 10%). Defaults to 1000.
  platformFeeBp: z.coerce.number().int().min(0).max(10000).default(1000),
});

export const RejectBody = z.object({
  reason: z.string().trim().min(1).max(500),
  // Optional list of document kinds the applicant must replace before resubmitting.
  mustReuploadDocKinds: z
    .array(
      z.enum([
        'gst_certificate',
        'pan',
        'address_proof',
        'bank_proof',
        'storefront_photo',
        'other',
      ]),
    )
    .optional(),
});

const DocKindEnum = z.enum([
  'gst_certificate',
  'pan',
  'address_proof',
  'bank_proof',
  'storefront_photo',
  'other',
]);

export const MessageBody = z.object({
  body: z.string().trim().min(1).max(2000),
  attachmentUrls: z.array(z.string().url()).optional(),
  // Optional field/doc this reply is about (tags the thread bubble).
  fieldKey: z.string().trim().max(64).optional(),
});

/**
 * "Request clarification" — one call that posts the admin's question, flips the
 * application to docs_requested, and (optionally) records which doc kinds the
 * applicant must (re)upload so the app can render structured upload slots.
 */
export const ClarificationBody = z.object({
  question: z.string().trim().min(1).max(2000),
  fieldKey: z.string().trim().max(64).optional(),
  requestedDocKinds: z.array(DocKindEnum).optional(),
  attachmentUrls: z.array(z.string().url()).optional(),
});

export const VerificationCheckBody = z.object({
  kind: z.enum(['gstin', 'pan', 'bank_penny_drop']),
  status: z.enum(['pending', 'in_progress', 'verified', 'failed']),
  rawResponse: z.record(z.unknown()).optional(),
  errorCode: z.string().optional(),
});
