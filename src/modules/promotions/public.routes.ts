/**
 * Public promotions surface (UNAUTHENTICATED — mounted without an auth hook, like
 * /catalog). Lists live offers + coupons so the consumer app can render offer
 * banners and the coupon wallet. Vouchers are excluded — their codes are private
 * (often consumer-assigned) and only resolve at checkout.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, desc, gte, inArray, lte } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { promotions } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';

export async function listActivePromotions() {
  const now = new Date();
  const rows = await db.query.promotions.findMany({
    where: and(
      inArray(promotions.mechanism, ['offer', 'coupon']),
      lte(promotions.validFrom, now),
      gte(promotions.validUntil, now),
    ),
    orderBy: [desc(promotions.createdAt)],
  });
  return ok(
    rows
      .filter((p) => p.status === 'active')
      .filter((p) => p.totalUses === null || p.redeemedCount < p.totalUses)
      .map((p) => ({
        id: p.id,
        // For coupons the name IS the code the consumer types at checkout.
        code: p.mechanism === 'coupon' ? p.name : null,
        name: p.name,
        mechanism: p.mechanism,
        discountType: p.discountType,
        appliedTo: p.appliedTo,
        // Discount parameters (percent / amountPaise / maxAmountPaise …) — public by design.
        config: p.config,
        storeId: p.storeId,
        validUntil: p.validUntil,
      })),
  );
}

const publicPromotionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/active', async () => listActivePromotions());
};

export default publicPromotionRoutes;
