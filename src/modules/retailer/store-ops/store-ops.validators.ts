import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });
export const DateParam = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const DaySlotSchema = z.object({
  from: z.string(),
  to: z.string(),
  closed: z.boolean(),
});

export const StoreHoursBody = z.object({
  monday: DaySlotSchema,
  tuesday: DaySlotSchema,
  wednesday: DaySlotSchema,
  thursday: DaySlotSchema,
  friday: DaySlotSchema,
  saturday: DaySlotSchema,
  sunday: DaySlotSchema,
});

export const UploadDocBody = z.object({ url: z.string().url() });

export const HolidayCreateBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  reason: z.string().trim().max(200).optional(),
});

export const StorePauseBody = z.object({
  visibility: z.enum(['visible', 'hidden']),
  reason: z.string().trim().max(500).optional(),
  pauseUntil: z.string().datetime().optional(),
});

export const NotificationPrefsBody = z.object({
  pushEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  dailyDigestEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  language: z.string().min(2).max(10).optional(),
  dashboardTiles: z.array(z.string()).optional(),
});

export const InboxQuery = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const PickupSlotCreateBody = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  capacity: z.number().int().min(1).max(1000).default(1),
});

export const PickupSlotPatchBody = z
  .object({
    startTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    endTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    capacity: z.number().int().min(1).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields' });
