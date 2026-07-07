/** Driver self-service profile (name / vehicle / documents). */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { deliveryAgents } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { UpdateProfileBody } from './profile.validators.js';

function shapeDriver(d: typeof deliveryAgents.$inferSelect) {
  return {
    id: d.id,
    phone: d.phone,
    name: d.name,
    avatarUrl: d.avatarUrl,
    vehicleType: d.vehicleType,
    vehicleNumber: d.vehicleNumber,
    city: d.city,
    licenceDocUrl: d.licenceDocUrl,
    rcDocUrl: d.rcDocUrl,
    insuranceDocUrl: d.insuranceDocUrl,
    status: d.status,
    createdAt: d.createdAt,
    profileComplete: !!d.name,
  };
}

export async function getProfile(input: { auth: AccessTokenPayload }) {
  const driver = await db.query.deliveryAgents.findFirst({
    where: eq(deliveryAgents.id, input.auth.sub),
  });
  if (!driver) throw new AppError(404, ErrorCode.NotFound, 'Driver not found');
  return ok(shapeDriver(driver));
}

export async function updateProfile(input: {
  auth: AccessTokenPayload;
  body: z.infer<typeof UpdateProfileBody>;
}) {
  const b = input.body;
  // Only the keys the driver actually sent (exactOptionalPropertyTypes-safe).
  const patch: Partial<typeof deliveryAgents.$inferInsert> = {
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.avatarUrl !== undefined ? { avatarUrl: b.avatarUrl } : {}),
    ...(b.vehicleType !== undefined ? { vehicleType: b.vehicleType } : {}),
    ...(b.vehicleNumber !== undefined ? { vehicleNumber: b.vehicleNumber } : {}),
    ...(b.city !== undefined ? { city: b.city } : {}),
    ...(b.licenceDocUrl !== undefined ? { licenceDocUrl: b.licenceDocUrl } : {}),
    ...(b.rcDocUrl !== undefined ? { rcDocUrl: b.rcDocUrl } : {}),
    ...(b.insuranceDocUrl !== undefined ? { insuranceDocUrl: b.insuranceDocUrl } : {}),
  };
  if (Object.keys(patch).length === 0) return getProfile({ auth: input.auth });

  const updated = await db
    .update(deliveryAgents)
    .set(patch)
    .where(eq(deliveryAgents.id, input.auth.sub))
    .returning();
  const driver = updated[0];
  if (!driver) throw new AppError(404, ErrorCode.NotFound, 'Driver not found');
  return ok(shapeDriver(driver));
}
