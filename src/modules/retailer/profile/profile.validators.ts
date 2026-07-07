import { z } from 'zod';
import { StateCodeSchema } from '@/shared/validation/common.js';

export const DeleteAccountBody = z.object({
  confirmation: z.literal('DELETE'),
});

export const AcceptTermsBody = z.object({ version: z.string().trim().min(1).max(64) });

export const CreateStoreBody = z.object({
  legalName: z.string().trim().min(2).max(120),
  address: z.string().trim().min(5).max(500),
  stateCode: StateCodeSchema,
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  openingHours: z
    .record(
      z.string(),
      z.array(
        z.object({
          open: z.string().regex(/^\d{2}:\d{2}$/),
          close: z.string().regex(/^\d{2}:\d{2}$/),
        }),
      ),
    )
    .optional(),
  contactPhone: z.string().trim().max(20).optional(),
  managerName: z.string().trim().max(120).optional(),
});

export const PatchProfileBody = z.object({
  contactPhone: z.string().trim().max(20).nullish(),
  managerName: z.string().trim().max(120).nullish(),
  galleryImageUrls: z.array(z.string().url()).max(10).nullish(),
  gstScheme: z.enum(['regular', 'composition']).optional(),
});
