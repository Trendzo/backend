import { z } from 'zod';

export const MAX_QTY = 99;
export const MAX_ITEMS = 100;

const VariantIdParam = z.string().trim().min(1).max(64);

/** A single cart line. Qty clamped to [1, MAX_QTY] at the schema boundary. */
export const CartItemSchema = z.object({
  variantId: VariantIdParam,
  qty: z.coerce.number().int().min(1).max(MAX_QTY),
});

/** Full-replace body: the whole items array (deduped + clamped in the controller). */
export const ReplaceCartBody = z.object({
  items: z.array(CartItemSchema).max(MAX_ITEMS),
});

/** Add/merge one line. */
export const AddItemBody = CartItemSchema;

/** Set absolute qty for one line. qty=0 removes it. */
export const SetQtyBody = z.object({
  qty: z.coerce.number().int().min(0).max(MAX_QTY),
});

export const VariantIdParamSchema = z.object({ variantId: VariantIdParam });
