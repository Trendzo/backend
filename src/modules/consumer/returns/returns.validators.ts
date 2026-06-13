import { z } from 'zod';

export const ReasonCategoryEnum = z.enum([
  'damaged',
  'wrong_item',
  'not_as_described',
  'doesnt_fit',
  'other',
]);

export const CreateReturnBody = z.object({
  orderId: z.string().min(1),
  items: z
    .array(
      z.object({
        orderItemId: z.string().min(1),
        reasonText: z.string().trim().max(500).optional(),
        reasonCategory: ReasonCategoryEnum.optional(),
        photos: z.array(z.string().url()).max(6).optional(),
      }),
    )
    .min(1),
});
