import { z } from 'zod';

export const UpdateProfileBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().optional(),
  vehicleType: z.string().trim().min(1).max(40).optional(),
  vehicleNumber: z.string().trim().min(1).max(40).optional(),
  city: z.string().trim().min(1).max(80).optional(),
  licenceDocUrl: z.string().url().optional(),
  rcDocUrl: z.string().url().optional(),
  insuranceDocUrl: z.string().url().optional(),
});
