import { z } from 'zod';

export const IdParam = z.object({ id: z.string() });

export const LoyaltyConfigUpdateSchema = z.object({
  // Each field is optional; only the keys present are updated.
  loyalty_point_value_paise: z.number().int().positive().optional(),
  loyalty_earn_rate_bp: z.number().int().nonnegative().max(100_000).optional(),
  min_redeemable_points: z.number().int().nonnegative().optional(),
  max_redeem_fraction_bp: z.number().int().nonnegative().max(10_000).optional(),
  welcome_points: z.number().int().nonnegative().optional(),
  referrer_points: z.number().int().nonnegative().optional(),
  referred_points: z.number().int().nonnegative().optional(),
  quiz_completion_points: z.number().int().nonnegative().optional(),
  daily_reward_table: z.array(z.number().int().nonnegative()).length(7).optional(),
});

export const ConsumerSearchQuery = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
});

export const WalletAdjustBody = z.object({
  /** Signed paise. Positive = credit; negative = debit. */
  amountPaise: z.number().int().refine((v) => v !== 0, 'Amount must be non-zero'),
  note: z.string().trim().min(1).max(500),
});

export const LoyaltyAdjustBody = z.object({
  /** Signed points. Positive = credit; negative = debit. */
  points: z.number().int().refine((v) => v !== 0, 'Points must be non-zero'),
  note: z.string().trim().min(1).max(500),
});
