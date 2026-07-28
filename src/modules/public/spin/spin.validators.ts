import { z } from 'zod';

/**
 * Client-generated, stable per install, stored in the app's AsyncStorage. The only
 * anonymous identity the app has — there is no device or session concept anywhere else in
 * the system. Bounded so a caller cannot use it as a free-text write channel.
 */
const DeviceId = z.string().min(8).max(64);

export const SpinSurface = z.enum(['popup', 'screen']);

export const WheelQuery = z.object({
  deviceId: DeviceId,
  surface: SpinSurface.default('popup'),
});

export const PlayBody = z.object({
  deviceId: DeviceId,
  surface: SpinSurface.default('popup'),
});

export const ClaimBody = z.object({
  claimToken: z.string().min(10).max(80),
});
