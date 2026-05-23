import { z } from 'zod';
import { AppliedToEnum, ClubbingDefaultEnum } from '@/shared/promotions/schemas.js';

export const UpsertBody = z.object({
  appliedToA: AppliedToEnum,
  appliedToB: AppliedToEnum,
  defaultValue: ClubbingDefaultEnum,
  note: z.string().trim().max(200).optional(),
});
