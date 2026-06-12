import { and, count, eq, isNull, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  attributeTemplates,
  productListings,
  retailerAccounts,
  variants,
} from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type {
  CreateTemplateBody,
  PatchTemplateBody,
} from './catalog.validators.js';
import type { AxisEntry, AxisType } from './catalog.types.js';

type Auth = AccessTokenPayload;

function axesRecordToArray(
  axes: Record<string, { type: AxisType; required: boolean; values?: string[] }>,
): AxisEntry[] {
  return Object.entries(axes).map(([name, a]) => ({
    name,
    type: a.type,
    allowedValues: a.values ?? [],
  }));
}

function axesArrayToRecord(
  axes: AxisEntry[],
): Record<string, { type: AxisType; required: boolean; values: string[] }> {
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

/**
 * US-5.6.4: compute which variants would be orphaned by replacing a template's
 * axes with `nextAxes`. A variant is orphaned if it uses an axis that was removed,
 * an axis whose name changed, or an enum value that was dropped from the new axis.
 * Returns one entry per affected listing.
 */
async function findOrphanedByAxes(
  templateId: string,
  oldAxes: AxisEntry[],
  nextAxes: AxisEntry[],
): Promise<{ listingId: string; listingName: string; variantCount: number }[]> {
  const nextByName = new Map(nextAxes.map((a) => [a.name.toLowerCase(), a]));
  const offendingAxes = oldAxes.filter((old) => {
    const next = nextByName.get(old.name.toLowerCase());
    if (!next) return true;
    if (old.type === 'enum' && next.type === 'enum') {
      const nextVals = new Set(next.allowedValues);
      return old.allowedValues.some((v) => !nextVals.has(v));
    }
    return false;
  });
  if (offendingAxes.length === 0) return [];

  const listingsOnTpl = await db
    .select({ id: productListings.id, name: productListings.name })
    .from(productListings)
    .where(eq(productListings.templateId, templateId));
  if (listingsOnTpl.length === 0) return [];

  const affected: { listingId: string; listingName: string; variantCount: number }[] = [];
  for (const l of listingsOnTpl) {
    const vs = await db
      .select({ id: variants.id, attributes: variants.attributes })
      .from(variants)
      .where(eq(variants.listingId, l.id));
    let cnt = 0;
    for (const v of vs) {
      const attrs = v.attributes as Record<string, string>;
      const isOrphan = offendingAxes.some((axis) => {
        const next = nextByName.get(axis.name.toLowerCase());
        const key = Object.keys(attrs).find(
          (k) => k.toLowerCase() === axis.name.toLowerCase(),
        );
        if (!key) return false;
        const value = attrs[key];
        if (!next) return true;
        if (next.type === 'enum') return !next.allowedValues.includes(value!);
        return false;
      });
      if (isOrphan) cnt++;
    }
    if (cnt > 0) affected.push({ listingId: l.id, listingName: l.name, variantCount: cnt });
  }
  return affected;
}

async function markOrphanedVariants(
  templateId: string,
  oldAxes: AxisEntry[],
  nextAxes: AxisEntry[],
): Promise<number> {
  const nextByName = new Map(nextAxes.map((a) => [a.name.toLowerCase(), a]));
  const listingsOnTpl = await db
    .select({ id: productListings.id })
    .from(productListings)
    .where(eq(productListings.templateId, templateId));
  let marked = 0;
  for (const l of listingsOnTpl) {
    const vs = await db
      .select({ id: variants.id, attributes: variants.attributes })
      .from(variants)
      .where(eq(variants.listingId, l.id));
    for (const v of vs) {
      const attrs = v.attributes as Record<string, string>;
      const isOrphan = oldAxes.some((axis) => {
        const next = nextByName.get(axis.name.toLowerCase());
        const key = Object.keys(attrs).find(
          (k) => k.toLowerCase() === axis.name.toLowerCase(),
        );
        if (!key) return false;
        const value = attrs[key];
        if (!next) return true;
        if (next.type === 'enum') return !next.allowedValues.includes(value!);
        return false;
      });
      if (isOrphan) {
        await db
          .update(variants)
          .set({ attributesOutOfTemplate: true })
          .where(eq(variants.id, v.id));
        marked++;
      }
    }
  }
  return marked;
}

export async function listTemplates(input: { auth: Auth }) {
  const storeId = await getStoreId(input.auth.sub);

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
        ownerStoreId: t.ownerStoreId,
        axes: axesRecordToArray(
          t.axes as Record<string, { type: AxisType; required: boolean; values?: string[] }>,
        ),
        usedByListingCount: row?.n ?? 0,
        usageCount: t.usageCount,
        lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
        updatedAt: null as string | null,
      };
    }),
  );

  // Suggestion order: the store's own templates first (most recently used), then
  // platform/other templates by popularity (most used). The wizard renders this
  // order directly.
  const isOwn = (s: string | null) => s === storeId;
  withCounts.sort((a, b) => {
    const aOwn = isOwn(a.ownerStoreId);
    const bOwn = isOwn(b.ownerStoreId);
    if (aOwn !== bOwn) return aOwn ? -1 : 1;
    if (aOwn) {
      // own → last used desc (nulls last)
      const at = a.lastUsedAt ? Date.parse(a.lastUsedAt) : -Infinity;
      const bt = b.lastUsedAt ? Date.parse(b.lastUsedAt) : -Infinity;
      return bt - at;
    }
    // platform/others → most used desc
    return b.usageCount - a.usageCount;
  });

  return ok(withCounts);
}

export async function getTemplate(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);

  const t = await db.query.attributeTemplates.findFirst({
    where: and(
      eq(attributeTemplates.id, input.id),
      or(
        eq(attributeTemplates.ownerStoreId, storeId),
        isNull(attributeTemplates.ownerStoreId),
      ),
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
    ownerStoreId: t.ownerStoreId,
    axes: axesRecordToArray(
      t.axes as Record<string, { type: AxisType; required: boolean; values?: string[] }>,
    ),
    usedByListingCount: row?.n ?? 0,
    usageCount: t.usageCount,
    lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
    updatedAt: null as string | null,
  });
}

/**
 * Bump a template's usage stats. Called when a listing attaches a template.
 * `incrementCount=false` only refreshes lastUsedAt (e.g. on variant create) so
 * usageCount stays = number of listings the template was attached to.
 */
export async function bumpTemplateUsage(
  templateId: string,
  opts: { incrementCount: boolean } = { incrementCount: true },
): Promise<void> {
  await db
    .update(attributeTemplates)
    .set({
      lastUsedAt: new Date(),
      ...(opts.incrementCount && {
        usageCount: sql`${attributeTemplates.usageCount} + 1`,
      }),
    })
    .where(eq(attributeTemplates.id, templateId));
}

export async function createTemplate(input: {
  auth: Auth;
  body: z.infer<typeof CreateTemplateBody>;
}) {
  const storeId = await getStoreId(input.auth.sub);

  // US-5.6.2: case-insensitive duplicate-name guard, scoped to the store.
  const existing = await db.query.attributeTemplates.findFirst({
    where: and(
      eq(attributeTemplates.ownerStoreId, storeId),
      sql`lower(${attributeTemplates.name}) = lower(${input.body.name})`,
    ),
  });
  if (existing) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      `A template named "${input.body.name}" already exists`,
    );
  }

  const id = newId('atpl');
  await db.insert(attributeTemplates).values({
    id,
    ownerStoreId: storeId,
    name: input.body.name,
    axes: axesArrayToRecord(input.body.axes) as never,
    isPlatformDefault: false,
  });

  return ok({ id });
}

export async function patchTemplate(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchTemplateBody>;
}) {
  const storeId = await getStoreId(input.auth.sub);

  const t = await db.query.attributeTemplates.findFirst({
    where: and(
      eq(attributeTemplates.id, input.id),
      eq(attributeTemplates.ownerStoreId, storeId),
    ),
  });
  if (!t) throw new AppError(404, ErrorCode.NotFound, 'Attribute template not found');
  if (t.isPlatformDefault)
    throw new AppError(403, ErrorCode.Forbidden, 'Cannot edit platform-default templates');

  // US-5.6.2: dedupe — case-insensitive, scoped to store, excluding self.
  if (input.body.name !== undefined && input.body.name.toLowerCase() !== t.name.toLowerCase()) {
    const clash = await db.query.attributeTemplates.findFirst({
      where: and(
        eq(attributeTemplates.ownerStoreId, storeId),
        ne(attributeTemplates.id, t.id),
        sql`lower(${attributeTemplates.name}) = lower(${input.body.name})`,
      ),
    });
    if (clash) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `A template named "${input.body.name}" already exists`,
      );
    }
  }

  // US-5.6.4: orphan detection. Compute affected listings; without `force`, block
  // with the affected list so the dashboard can prompt the retailer to confirm.
  let orphansToMark: { old: AxisEntry[]; next: AxisEntry[] } | null = null;
  if (input.body.axes !== undefined) {
    const oldAxes = axesRecordToArray(
      t.axes as Record<string, { type: AxisType; required: boolean; values?: string[] }>,
    );
    const nextAxes = input.body.axes;
    const affected = await findOrphanedByAxes(t.id, oldAxes, nextAxes);
    if (affected.length > 0 && input.body.force !== true) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Edit would orphan ${affected.reduce((s, a) => s + a.variantCount, 0)} variant(s). Resubmit with force=true to confirm.`,
        { affected },
      );
    }
    if (affected.length > 0) orphansToMark = { old: oldAxes, next: nextAxes };
  }

  const patch: Partial<typeof attributeTemplates.$inferInsert> = {};
  if (input.body.name !== undefined) patch.name = input.body.name;
  if (input.body.axes !== undefined) patch.axes = axesArrayToRecord(input.body.axes) as never;

  const [updated] = await db
    .update(attributeTemplates)
    .set(patch)
    .where(eq(attributeTemplates.id, t.id))
    .returning();

  let markedCount = 0;
  if (orphansToMark) {
    markedCount = await markOrphanedVariants(t.id, orphansToMark.old, orphansToMark.next);
  }

  return ok({ ...updated, orphansFlagged: markedCount });
}

export async function deleteTemplate(input: { auth: Auth; id: string }) {
  const storeId = await getStoreId(input.auth.sub);

  const t = await db.query.attributeTemplates.findFirst({
    where: and(
      eq(attributeTemplates.id, input.id),
      eq(attributeTemplates.ownerStoreId, storeId),
    ),
  });
  if (!t) throw new AppError(404, ErrorCode.NotFound, 'Attribute template not found');
  if (t.isPlatformDefault)
    throw new AppError(403, ErrorCode.Forbidden, 'Cannot delete platform-default templates');

  const [usage] = await db
    .select({ n: count() })
    .from(productListings)
    .where(eq(productListings.templateId, t.id));
  if ((usage?.n ?? 0) > 0) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Template is in use by listings — remove from listings first',
    );
  }

  await db.delete(attributeTemplates).where(eq(attributeTemplates.id, t.id));
  return ok({ id: t.id });
}
