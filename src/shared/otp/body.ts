import { z } from 'zod';

/**
 * Body of every OTP login (`…/otp/login`, and the legacy `…/otp/msg91` paths): the access
 * token the client got from its OTP provider after a successful verify, plus which provider
 * issued it. `provider` is omitted by app builds that predate Slide — those are MSG91.
 */
export const OtpLoginBody = z.object({
  accessToken: z.string().min(20).max(4096),
  provider: z.enum(['msg91', 'slide']).optional(),
});
export type OtpLoginInput = z.infer<typeof OtpLoginBody>;

/** `?client=web` selects the web widget (portal + CRM); the mobile apps send nothing. */
export const OtpConfigQuery = z.object({ client: z.enum(['app', 'web']).default('app') });
