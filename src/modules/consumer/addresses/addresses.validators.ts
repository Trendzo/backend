import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const AddressBodySchema = z.object({
  label: z.string().trim().max(40).nullable().optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  stateCode: z.string().trim().length(2),
  lat: z.number().finite(),
  lng: z.number().finite(),
  isDefault: z.boolean().optional(),
});

export const PartialAddressBodySchema = AddressBodySchema.partial();
