/**
 * Driver location ping. Stores only the last-known point on the driver row (not a
 * track), refreshed by the driver app while on shift. Read back by the admin
 * dispatch desk to place drivers on the live map.
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { LocationPingBody } from './location.validators.js';

export async function pingLocation(input: {
  auth: AccessTokenPayload;
  body: z.infer<typeof LocationPingBody>;
}) {
  await db
    .update(deliveryAgents)
    .set({
      currentLat: input.body.lat,
      currentLng: input.body.lng,
      lastLocationAt: new Date(),
    })
    .where(eq(deliveryAgents.id, input.auth.sub));
  return ok({ ok: true });
}
