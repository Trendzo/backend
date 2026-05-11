import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import {
  inventoryAdjustments,
  inventoryReservations,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';
import { recordAudit } from '@/shared/audit.js';

const adminInventoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('admin'));

  // ===== GET /admin/inventory/adjustments — audit trail =====
  app.get(
    '/inventory/adjustments',
    {
      schema: {
        querystring: z.object({
          variantId: z.string().optional(),
          reason: z.enum([
            'manual_edit',
            'csv_import',
            'order_reservation',
            'order_confirmation',
            'order_cancellation',
            'return_restock',
            'damage_writeoff',
            'audit_correction',
          ]).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const { variantId, reason, limit } = req.query;
      const conditions = [];
      if (variantId) conditions.push(eq(inventoryAdjustments.variantId, variantId));
      if (reason) conditions.push(eq(inventoryAdjustments.reason, reason));

      const rows = await db.query.inventoryAdjustments.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(inventoryAdjustments.at),
        limit,
      });
      return ok(rows);
    },
  );

  // ===== POST /admin/inventory/adjustments — admin stock correction =====
  app.post(
    '/inventory/adjustments',
    {
      schema: {
        body: z.object({
          variantId: z.string(),
          delta: z.number().int(),
          reason: z.enum([
            'manual_edit',
            'csv_import',
            'order_reservation',
            'order_confirmation',
            'order_cancellation',
            'return_restock',
            'damage_writeoff',
            'audit_correction',
          ]),
          refKind: z.string().optional(),
          refId: z.string().optional(),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const variant = await db.query.variants.findFirst({
        where: eq(variants.id, req.body.variantId),
      });
      if (!variant) throw new AppError(404, ErrorCode.NotFound, 'Variant not found');

      const newStock = variant.stock + req.body.delta;
      if (newStock < 0) {
        throw new AppError(409, ErrorCode.InvalidState, 'Adjustment would make stock negative');
      }

      await db
        .update(variants)
        .set({ stock: newStock })
        .where(eq(variants.id, variant.id));

      const id = newId('inv');
      await db.insert(inventoryAdjustments).values({
        id,
        variantId: variant.id,
        delta: req.body.delta,
        newStock,
        reason: req.body.reason,
        actorKind: 'admin',
        actorId: auth.sub,
        refKind: req.body.refKind ?? null,
        refId: req.body.refId ?? null,
        note: req.body.note ?? null,
      });

      await recordAudit({
        actor: auth,
        action: 'inventory.adjust',
        resourceKind: 'variant',
        resourceId: variant.id,
        before: { stock: variant.stock },
        after: { stock: newStock },
        requestId: req.id,
      });

      return ok({ id, variantId: variant.id, newStock });
    },
  );

  // ===== GET /admin/inventory/reservations =====
  app.get(
    '/inventory/reservations',
    {
      schema: {
        querystring: z.object({
          variantId: z.string().optional(),
          ownerKind: z.string().optional(),
          active: z.coerce.boolean().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
    },
    async (req) => {
      const { variantId, ownerKind, active, limit } = req.query;
      const conditions = [];
      if (variantId) conditions.push(eq(inventoryReservations.variantId, variantId));
      if (ownerKind) conditions.push(eq(inventoryReservations.ownerKind, ownerKind));
      if (active === true) {
        const { isNull } = await import('drizzle-orm');
        conditions.push(isNull(inventoryReservations.releasedAt));
      }
      const rows = await db.query.inventoryReservations.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: desc(inventoryReservations.reservedAt),
        limit,
      });
      return ok(rows);
    },
  );
};

export default adminInventoryRoutes;
