import { z } from 'zod';
import {
  CRM_DOC_KINDS,
  CRM_FOLLOWUP_TYPES,
  CRM_NOT_INTERESTED_REASONS,
  CRM_OUTCOMES,
  CRM_STATUS_ORDER,
  CRM_STEP_KEYS,
} from '../../domain.js';

const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Clock = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM');
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const DigitsOnly = (len: number, label: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v === '' || v.length === len, label)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export const RetailerIdParam = z.object({ id: z.string().min(3).max(80) });

export const ListRetailersQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(CRM_STATUS_ORDER as [string, ...string[]]).optional(),
  area: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  exec: z.string().trim().max(80).optional(),
  from: LocalDay.optional(),
  to: LocalDay.optional(),
  /** Narrow to leads whose next pending follow-up is due today / already overdue. */
  fu: z.enum(['today', 'overdue']).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});

export const CreateRetailerBody = z.object({
  store_name: z.string().trim().min(1, 'Store name is required').max(160),
  owner_name: OptionalText(120),
  mobile: DigitsOnly(10, 'Mobile number must be 10 digits'),
  whatsapp: DigitsOnly(10, 'WhatsApp number must be 10 digits'),
  address: OptionalText(400),
  area: OptionalText(80),
  city: OptionalText(80),
  pincode: DigitsOnly(6, 'Pincode must be 6 digits'),
  category_id: OptionalText(80),
  notes: OptionalText(2000),
  assigned_to: OptionalText(80),
  /** Set after the user acknowledges the duplicate warning. */
  force: z.boolean().optional(),
});

export const UpdateRetailerBody = z
  .object({
    store_name: z.string().trim().min(1).max(160).optional(),
    owner_name: OptionalText(120),
    mobile: DigitsOnly(10, 'Mobile number must be 10 digits'),
    whatsapp: DigitsOnly(10, 'WhatsApp number must be 10 digits'),
    address: OptionalText(400),
    area: OptionalText(80),
    city: OptionalText(80),
    pincode: DigitsOnly(6, 'Pincode must be 6 digits'),
    category_id: OptionalText(80),
    notes: OptionalText(2000),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/**
 * The single mutation endpoint. Every field action is a variant here so the derived status is
 * recomputed in exactly one place, and every variant lands in the audit trail.
 */
export const ActionBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('checklist'),
    step: z.enum(CRM_STEP_KEYS as unknown as [string, ...string[]]),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal('checkin'),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  }),
  z.object({ type: z.literal('checkout') }),
  z.object({
    type: z.literal('outcome'),
    outcome: z.enum(CRM_OUTCOMES.map((o) => o.key) as unknown as [string, ...string[]]),
    reason: z
      .enum(CRM_NOT_INTERESTED_REASONS as unknown as [string, ...string[]])
      .or(z.string().trim().max(160))
      .nullable()
      .optional(),
  }),
  z.object({ type: z.literal('note'), text: z.string().trim().min(1, 'Note is empty').max(4000) }),
  z.object({
    type: z.literal('followup'),
    date: LocalDay,
    time: Clock.nullable().optional(),
    ftype: z.enum(CRM_FOLLOWUP_TYPES as unknown as [string, ...string[]]).default('Phone Call'),
    reason: OptionalText(240),
    notes: OptionalText(2000),
  }),
  z.object({ type: z.literal('followup_done'), followup_id: z.string().min(3).max(80) }),
  z.object({ type: z.literal('followup_cancel'), followup_id: z.string().min(3).max(80) }),
  z.object({ type: z.literal('assign'), user_id: z.string().min(3).max(80) }),
]);

export const DocumentKindSchema = z.enum(CRM_DOC_KINDS as unknown as [string, ...string[]]);

export const DocumentIdParam = z.object({ id: z.string().min(3).max(80) });

export const ListFollowupsQuery = z.object({
  scope: z.enum(['today', 'overdue', 'upcoming', 'pending', 'done', 'all']).default('today'),
  exec: z.string().trim().max(80).optional(),
  from: LocalDay.optional(),
  to: LocalDay.optional(),
});

export const ListVisitsQuery = z.object({
  from: LocalDay.optional(),
  to: LocalDay.optional(),
  exec: z.string().trim().max(80).optional(),
  retailer: z.string().trim().max(80).optional(),
});
