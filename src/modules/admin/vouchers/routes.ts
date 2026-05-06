import { eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { promotions, voucherCodes } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { requireAuth } from '@/shared/auth/middleware.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';

/**
 * Admin voucher-code management. Bulk generation generates `count` codes, each with
 * `usesAllowed` redemptions (default 1 = single-use). The DB enforces global uniqueness
 * via voucher_codes_code_idx; we retry on collision (extremely rare with 32^8 alphabet).
 */
const adminVoucherRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ============ List voucher codes for a promotion ============
  app.get(
    '/:promotionId/vouchers',
    {
      schema: {
        params: z.object({ promotionId: z.string() }),
        querystring: z.object({
          format: z.enum(['json', 'csv']).default('json'),
        }),
      },
    },
    async (req, reply) => {
      await loadPromotionOrThrow(req.params.promotionId);

      const rows = await db.query.voucherCodes.findMany({
        where: eq(voucherCodes.promotionId, req.params.promotionId),
        orderBy: voucherCodes.createdAt,
      });

      if (req.query.format === 'csv') {
        const lines = ['code,total_uses,redeemed_count,created_at'];
        for (const r of rows) {
          lines.push(
            [
              r.code,
              r.totalUses ?? '',
              r.redeemedCount,
              r.createdAt.toISOString(),
            ].join(','),
          );
        }
        void reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="vouchers-${req.params.promotionId}.csv"`)
          .send(lines.join('\n'));
        return reply;
      }

      return ok(rows);
    },
  );

  // ============ Bulk-generate ============
  app.post(
    '/:promotionId/vouchers/bulk-generate',
    {
      schema: {
        params: z.object({ promotionId: z.string() }),
        body: z.object({
          count: z.number().int().positive().max(10_000),
          /** How many redemptions each generated code allows (default 1 = single-use). */
          usesAllowed: z.number().int().positive().nullable().default(1),
          /** Optional uppercase alphanumeric prefix (e.g. "DROP24"). */
          prefix: z
            .string()
            .trim()
            .toUpperCase()
            .max(8)
            .regex(/^[A-Z0-9]*$/, 'A–Z and 0–9 only')
            .default(''),
        }),
      },
    },
    async (req) => {
      const promo = await loadPromotionOrThrow(req.params.promotionId);
      if (promo.mechanism !== 'voucher') {
        throw new AppError(
          409,
          ErrorCode.InvalidState,
          'Bulk-generate is only valid for voucher-mechanism promotions',
        );
      }

      // Generate, with retry-on-collision against the unique index.
      const want = req.body.count;
      const inserted: typeof voucherCodes.$inferSelect[] = [];
      const tried = new Set<string>();
      let attempts = 0;
      while (inserted.length < want && attempts < 5) {
        attempts += 1;
        const need = want - inserted.length;
        const fresh = generateCodes(need, req.body.prefix).filter((c) => !tried.has(c));
        for (const code of fresh) tried.add(code);
        const rows = fresh.map((code) => ({
          id: newId(IdPrefix.VoucherCode),
          promotionId: promo.id,
          code,
          ...(req.body.usesAllowed !== null && { totalUses: req.body.usesAllowed }),
          redeemedCount: 0,
        }));
        try {
          const out = await db
            .insert(voucherCodes)
            .values(rows)
            .onConflictDoNothing({ target: voucherCodes.code })
            .returning();
          inserted.push(...out);
        } catch (err) {
          // Anything but a unique conflict bubbles up.
          throw err;
        }
      }

      if (inserted.length < want) {
        throw AppError.internal(
          `Could only generate ${inserted.length} of ${want} unique codes after retries`,
        );
      }
      return ok({ generated: inserted.length, codes: inserted });
    },
  );

  // ============ Distribute (assign) — placeholder ============
  // PRODUCT_SPEC line 707 mentions pushing vouchers to specific consumers' wallets. With
  // no consumer-app surface yet, we just record the intended recipients in the code's
  // metadata for now. Schema doesn't have a `targetedTo` column on voucher_codes — so
  // this endpoint is a no-op stub that returns 501. Add when the consumer surface lands.
  app.post(
    '/:promotionId/vouchers/distribute-to',
    {
      schema: {
        params: z.object({ promotionId: z.string() }),
        body: z.object({
          codeIds: z.array(z.string()).min(1),
          consumerIds: z.array(z.string()).min(1),
        }),
      },
    },
    async () => {
      throw new AppError(
        501,
        ErrorCode.InvalidState,
        'Voucher distribution UI/data path lands when the consumer-app surface is wired',
      );
    },
  );

  async function loadPromotionOrThrow(id: string) {
    const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, id) });
    if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
    return promo;
  }
};

export default adminVoucherRoutes;
