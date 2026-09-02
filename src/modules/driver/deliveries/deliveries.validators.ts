import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const ItemParam = z.object({ id: z.string(), itemId: z.string() });

export const ListDeliveriesQuery = z.object({
  // Defaults to the driver's active legs (packed … returning_to_store).
  status: z
    .enum([
      'packed',
      'picked_up',
      'out_for_delivery',
      'at_door',
      'delivered',
      'undelivered',
      'returning_to_store',
      'returned_to_store',
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export const DeliverBody = z.object({
  // Consumer-spoken delivery OTP — required (and verified) when the order carries one.
  otp: z.string().trim().min(4).max(8).optional(),
  note: z.string().trim().max(500).optional(),
  proofPhotos: z.array(z.string().url()).optional(),
  signatureUrl: z.string().url().optional(),
  // Cash collected at a COD delivery (paise). Ignored for prepaid orders.
  codCollectedPaise: z.number().int().nonnegative().optional(),
});

// OTP now proves handover at door OPEN (start of the try-on window), not at close.
export const DoorOpenBody = z.object({
  otp: z.string().trim().min(4).max(8).optional(),
});

export const DoorExtendBody = z.object({
  reason: z.string().trim().min(3).max(300).default('one_time_extension'),
});

// Driver "finish / mark-remaining-kept" close. Items are OPTIONAL now: the customer-driven
// flow accumulates per-item decisions on order_items, and an empty body closes from that
// staging (undecided → kept). An explicit `items` payload keeps the legacy all-at-once
// power-close working. OTP is no longer here (it gates door/open).
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
    .min(1)
    .optional(),
});

// Driver responds to a customer-requested return.
export const AcceptReturnBody = z.object({
  note: z.string().trim().max(500).optional(),
});
export const RejectReturnBody = z.object({
  reason: z.string().trim().min(3).max(500),
  photos: z.array(z.string().url()).min(1),
});

export const MarkUndeliveredBody = z.object({
  reason: z.string().trim().min(3).max(500),
  photos: z.array(z.string().url()).optional(),
});
