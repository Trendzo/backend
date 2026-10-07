import { z } from 'zod';

export const OrderStatusEnum = z.enum([
  'pending',
  'confirmed',
  'routing',
  'accepted',
  'packed',
  'picked_up',
  'out_for_delivery',
  'at_door',
  'undelivered',
  'returning_to_store',
  'returned_to_store',
  'delivered',
  'cancelled',
  'payment_failed',
  'closed',
]);

export const IdParam = z.object({ id: z.string() });

/** Query strings arrive as '' for a cleared filter box — treat that as "not provided". */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/**
 * `from`/`to` bound `placedAt`. Accepts a full ISO-8601 timestamp (`2026-10-01T00:00:00+05:30`)
 * or a bare `YYYY-MM-DD` date: a bare `from` is the START of that UTC day and a bare `to` is
 * the END of it (inclusive), so `from=2026-10-01&to=2026-10-01` is exactly one day.
 */
const PlacedAtBound = (edge: 'start' | 'end') =>
  z.preprocess(
    blankToUndefined,
    z
      .string()
      .trim()
      .transform((raw, ctx) => {
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
        const d = new Date(dateOnly ? `${raw}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z` : raw);
        if (Number.isNaN(d.getTime())) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected an ISO-8601 date or timestamp' });
          return z.NEVER;
        }
        return d;
      })
      .optional(),
  );

export const ListQuery = z.object({
  status: OrderStatusEnum.optional(),
  statusIn: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  /** Skip this many rows (same ordering as the unpaged list) — for "load more". */
  offset: z.coerce.number().int().min(0).default(0),
  /** placedAt >= from. */
  from: PlacedAtBound('start'),
  /** placedAt <= to. */
  to: PlacedAtBound('end'),
  /** Case-insensitive match on order id PREFIX, consumer name, or consumer phone. */
  q: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  deliveryMethod: z.preprocess(
    blankToUndefined,
    z.enum(['express', 'standard', 'pickup', 'try_and_buy']).optional(),
  ),
});

export const PickupHandoverBody = z.object({
  pickupCode: z.string().trim().min(4).max(16),
});

export const HandoverBody = z
  .object({
    // In-house handover: the code the agent reads off their app, verified against the
    // order's minted `agentHandoffCode`. Required once an agent has been assigned.
    handoffCode: z.string().trim().min(4).max(16).optional(),
    // External-courier fallback (no account, no app) — hand over directly with a
    // free-text name/phone snapshot and no code.
    agentName: z.string().trim().min(1).max(120).optional(),
    agentPhone: z.string().trim().min(1).max(20).optional(),
  })
  .default({});

/**
 * `otp` is REQUIRED and the whole body no longer `.default({})`, so an empty POST is a
 * 400. This route could previously mark ANY packed order delivered with no proof of
 * handover whatsoever — no OTP, no pickup code, not even a photo.
 */
export const MarkDeliveredBody = z.object({
  otp: z.string().trim().min(4).max(8),
  note: z.string().trim().max(500).optional(),
  proofPhotoUrl: z.string().url().optional(),
});

export const MarkUndeliveredBody = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const RequestCancelBody = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const DoorExtendBody = z.object({
  reason: z.string().trim().min(3).max(300).default('one_time_extension'),
});

export const DoorCloseBody = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        decision: z.enum(['kept', 'returned', 'refused', 'return_rejected']),
        reason: z.string().trim().max(500).optional(),
        photos: z.array(z.string().url()).optional(),
      }),
    )
    .min(1),
});
