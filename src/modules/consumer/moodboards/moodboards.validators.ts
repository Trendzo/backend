import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const ItemParam = z.object({ id: z.string(), itemId: z.string() });

export const CreateBoardBody = z.object({
  name: z.string().trim().min(1).max(80),
  note: z.string().trim().max(500).nullable().optional(),
  isPublic: z.boolean().optional(),
});

export const PatchBoardBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    note: z.string().trim().max(500).nullable().optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const AddItemBody = z.object({
  listingId: z.string().min(1),
});
