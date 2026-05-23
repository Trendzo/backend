import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { promotions, voucherCodes } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { generateCodes } from '@/shared/promotions/voucher-codes.js';
import type { BulkGenerateBody, FormatQuery } from './vouchers.validators.js';

async function loadPromotionOrThrow(id: string) {
  const promo = await db.query.promotions.findFirst({ where: eq(promotions.id, id) });
  if (!promo) throw new AppError(404, ErrorCode.NotFound, 'Promotion not found');
  return promo;
}

export async function listVouchers(input: {
  promotionId: string;
  query: z.infer<typeof FormatQuery>;
  reply: FastifyReply;
}) {
  const { promotionId, query, reply } = input;
  await loadPromotionOrThrow(promotionId);

  const rows = await db.query.voucherCodes.findMany({
    where: eq(voucherCodes.promotionId, promotionId),
    orderBy: voucherCodes.createdAt,
  });

  if (query.format === 'csv') {
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
      .header(
        'Content-Disposition',
        `attachment; filename="vouchers-${promotionId}.csv"`,
      )
      .send(lines.join('\n'));
    return reply;
  }

  return ok(rows);
}

export async function bulkGenerate(input: {
  promotionId: string;
  body: z.infer<typeof BulkGenerateBody>;
}) {
  const { promotionId, body } = input;
  const promo = await loadPromotionOrThrow(promotionId);
  if (promo.mechanism !== 'voucher') {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Bulk-generate is only valid for voucher-mechanism promotions',
    );
  }

  // Generate, with retry-on-collision against the unique index.
  const want = body.count;
  const inserted: (typeof voucherCodes.$inferSelect)[] = [];
  const tried = new Set<string>();
  let attempts = 0;
  while (inserted.length < want && attempts < 5) {
    attempts += 1;
    const need = want - inserted.length;
    const fresh = generateCodes(need, body.prefix).filter((c) => !tried.has(c));
    for (const code of fresh) tried.add(code);
    const rows = fresh.map((code) => ({
      id: newId(IdPrefix.VoucherCode),
      promotionId: promo.id,
      code,
      ...(body.usesAllowed !== null && { totalUses: body.usesAllowed }),
      redeemedCount: 0,
    }));
    const out = await db
      .insert(voucherCodes)
      .values(rows)
      .onConflictDoNothing({ target: voucherCodes.code })
      .returning();
    inserted.push(...out);
  }

  if (inserted.length < want) {
    throw AppError.internal(
      `Could only generate ${inserted.length} of ${want} unique codes after retries`,
    );
  }
  return ok({ generated: inserted.length, codes: inserted });
}

// PRODUCT_SPEC line 707 mentions pushing vouchers to specific consumers' wallets. With
// no consumer-app surface yet, we just record the intended recipients in the code's
// metadata for now. Schema doesn't have a `targetedTo` column on voucher_codes — so
// this endpoint is a no-op stub that returns 501.
export async function distributeStub() {
  throw new AppError(
    501,
    ErrorCode.InvalidState,
    'Voucher distribution UI/data path lands when the consumer-app surface is wired',
  );
}
