import { z } from 'zod';

export const IdParam = z.object({ id: z.string().min(1) });

/** Basis points, so odds are integers and cannot drift the way floats do. */
const WeightBp = z.number().int().min(0).max(10_000);

export const SegmentInput = z
  .object({
    label: z.string().min(1).max(24),
    sublabel: z.string().max(24).nullish(),
    icon: z.string().max(48).nullish(),
    colorHex: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, 'Use a #RRGGBB colour')
      .nullish(),
    weightBp: WeightBp,
    rewardKind: z.enum(['promotion', 'points', 'none']),
    promotionId: z.string().nullish(),
    points: z.number().int().positive().nullish(),
    stockTotal: z.number().int().nonnegative().nullish(),
  })
  /**
   * A slice must be able to pay out what it advertises. The DB has the same CHECK, but
   * failing here gives the admin a field-level message instead of a constraint name.
   */
  .superRefine((s, ctx) => {
    if (s.rewardKind === 'promotion' && !s.promotionId) {
      ctx.addIssue({ code: 'custom', path: ['promotionId'], message: 'Pick a promotion' });
    }
    if (s.rewardKind === 'points' && !s.points) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: 'Set the points to award' });
    }
    if (s.rewardKind !== 'promotion' && s.promotionId) {
      ctx.addIssue({ code: 'custom', path: ['promotionId'], message: 'Only prize slices take a promotion' });
    }
    if (s.rewardKind !== 'points' && s.points) {
      ctx.addIssue({ code: 'custom', path: ['points'], message: 'Only points slices take points' });
    }
  });

/**
 * The whole ordered slice list, replaced in one call — the same shape the collections
 * roster uses. Partial updates of an ordered array with odds that must total 100% invite
 * exactly the kind of half-applied state this avoids.
 */
export const SegmentsBody = z
  .object({ segments: z.array(SegmentInput).min(2).max(12) })
  .refine(
    (b) => b.segments.reduce((sum, s) => sum + s.weightBp, 0) === 10_000,
    { path: ['segments'], message: 'Slice odds must add up to exactly 100%' },
  );

const WheelCommon = {
  name: z.string().min(1).max(80),
  surface: z.enum(['popup', 'screen', 'both']),
  spinsPerDevicePerDay: z.number().int().min(1).max(50),
  /** Null = unlimited prizes per account. Deliberately explicit rather than absent. */
  maxClaimsPerConsumer: z.number().int().min(1).max(100).nullable(),
  guestSpinAllowed: z.boolean(),
  claimWindowHours: z.number().int().min(1).max(8760),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
};

export const CreateWheelBody = z
  .object(WheelCommon)
  .refine((b) => b.validUntil > b.validFrom, {
    path: ['validUntil'],
    message: 'The end date must be after the start date',
  });

export const PatchWheelBody = z.object({
  name: WheelCommon.name.optional(),
  surface: WheelCommon.surface.optional(),
  spinsPerDevicePerDay: WheelCommon.spinsPerDevicePerDay.optional(),
  maxClaimsPerConsumer: WheelCommon.maxClaimsPerConsumer.optional(),
  guestSpinAllowed: WheelCommon.guestSpinAllowed.optional(),
  claimWindowHours: WheelCommon.claimWindowHours.optional(),
  validFrom: WheelCommon.validFrom.optional(),
  validUntil: WheelCommon.validUntil.optional(),
});

export const PlaysQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
