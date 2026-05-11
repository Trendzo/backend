import { and, count, eq, isNull, or } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '@/db/client.js';
import { attributeTemplates, productListings, retailerAccounts } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { getAuth, requireAuth } from '@/shared/auth/middleware.js';
import { newId } from '@/shared/ids.js';

type AxisEntry = { name: string; type: string; allowedValues: string[] };

function axesRecordToArray(axes: Record<string, { type: string; required: boolean; values?: string[] }>): AxisEntry[] {
  return Object.entries(axes).map(([name, a]) => ({
    name,
    type: a.type,
    allowedValues: a.values ?? [],
  }));
}

function axesArrayToRecord(axes: AxisEntry[]): Record<string, { type: string; required: boolean; values: string[] }> {
  return Object.fromEntries(
    axes.map((a) => [a.name, { type: a.type, required: false, values: a.allowedValues }]),
  );
}

async function getStoreId(retailerId: string): Promise<string> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return retailer.storeId;
}

const AxisSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().trim().min(1),
  allowedValues: z.array(z.string()).default([]),
});

const retailerCatalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', requireAuth('retailer'));

  // ===== GET /retailer/attribute-templates =====
  app.get('/attribute-templates', async (req) => {
    const auth = getAuth(req);
    const storeId = await getStoreId(auth.sub);

    const rows = await db.query.attributeTemplates.findMany({
      where: or(
        eq(attributeTemplates.ownerStoreId, storeId),
        isNull(attributeTemplates.ownerStoreId),
      ),
    });

    const withCounts = await Promise.all(
      rows.map(async (t) => {
        const [row] = await db
          .select({ n: count() })
          .from(productListings)
          .where(eq(productListings.templateId, t.id));
        return {
          id: t.id,
          name: t.name,
          isPlatformDefault: t.isPlatformDefault,
          axes: axesRecordToArray(t.axes as Record<string, { type: string; required: boolean; values?: string[] }>),
          usedByListingCount: row?.n ?? 0,
          updatedAt: null as string | null,
        };
      }),
    );

    return ok(withCounts);
  });

  // ===== GET /retailer/attribute-templates/:id =====
  app.get(
    '/attribute-templates/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const t = await db.query.attributeTemplates.findFirst({
        where: and(
          eq(attributeTemplates.id, req.params.id),
          or(eq(attributeTemplates.ownerStoreId, storeId), isNull(attributeTemplates.ownerStoreId)),
        ),
      });
      if (!t) throw new AppError(404, ErrorCode.NotFound, 'Attribute template not found');

      const [row] = await db
        .select({ n: count() })
        .from(productListings)
        .where(eq(productListings.templateId, t.id));

      return ok({
        id: t.id,
        name: t.name,
        isPlatformDefault: t.isPlatformDefault,
        axes: axesRecordToArray(t.axes as Record<string, { type: string; required: boolean; values?: string[] }>),
        usedByListingCount: row?.n ?? 0,
        updatedAt: null as string | null,
      });
    },
  );

  // ===== POST /retailer/attribute-templates =====
  app.post(
    '/attribute-templates',
    {
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(120),
          axes: z.array(AxisSchema).min(1),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const id = newId('atpl');
      await db.insert(attributeTemplates).values({
        id,
        ownerStoreId: storeId,
        name: req.body.name,
        axes: axesArrayToRecord(req.body.axes) as never,
        isPlatformDefault: false,
      });

      return ok({ id });
    },
  );

  // ===== PATCH /retailer/attribute-templates/:id =====
  app.patch(
    '/attribute-templates/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          name: z.string().trim().min(1).max(120).optional(),
          axes: z.array(AxisSchema).min(1).optional(),
        }),
      },
    },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const t = await db.query.attributeTemplates.findFirst({
        where: and(
          eq(attributeTemplates.id, req.params.id),
          eq(attributeTemplates.ownerStoreId, storeId),
        ),
      });
      if (!t) throw new AppError(404, ErrorCode.NotFound, 'Attribute template not found');
      if (t.isPlatformDefault) throw new AppError(403, ErrorCode.Forbidden, 'Cannot edit platform-default templates');

      const patch: Partial<typeof attributeTemplates.$inferInsert> = {};
      if (req.body.name !== undefined) patch.name = req.body.name;
      if (req.body.axes !== undefined) patch.axes = axesArrayToRecord(req.body.axes) as never;

      const [updated] = await db
        .update(attributeTemplates)
        .set(patch)
        .where(eq(attributeTemplates.id, t.id))
        .returning();

      return ok(updated);
    },
  );

  // ===== DELETE /retailer/attribute-templates/:id =====
  app.delete(
    '/attribute-templates/:id',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const auth = getAuth(req);
      const storeId = await getStoreId(auth.sub);

      const t = await db.query.attributeTemplates.findFirst({
        where: and(
          eq(attributeTemplates.id, req.params.id),
          eq(attributeTemplates.ownerStoreId, storeId),
        ),
      });
      if (!t) throw new AppError(404, ErrorCode.NotFound, 'Attribute template not found');
      if (t.isPlatformDefault) throw new AppError(403, ErrorCode.Forbidden, 'Cannot delete platform-default templates');

      const [usage] = await db
        .select({ n: count() })
        .from(productListings)
        .where(eq(productListings.templateId, t.id));
      if ((usage?.n ?? 0) > 0) {
        throw new AppError(409, ErrorCode.InvalidState, 'Template is in use by listings — remove from listings first');
      }

      await db.delete(attributeTemplates).where(eq(attributeTemplates.id, t.id));
      return ok({ id: t.id });
    },
  );
};

export default retailerCatalogRoutes;
