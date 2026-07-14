/**
 * Variant-group domain helpers — the single place that owns the parent-child
 * variant invariants:
 *
 *   - Every listing has ≥ 1 group; exactly one carries `isDefault`.
 *   - Every variant belongs to exactly one group.
 *   - System (color_size) path: group = color, variant = size; `attributes` and
 *     `attributesLabel` are DERIVED here, never trusted from the client.
 *   - Single-product + custom-template variants live in the default group.
 *
 * Used by retailer listings, admin store-variants, CSV import, and seeds so all
 * insert paths produce identical shapes.
 */
import { eq, inArray } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { orderItems, productListings, variantGroups, variants } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type DbOrTx = typeof Db | Tx;
type VariantGroup = typeof variantGroups.$inferSelect;

export const DEFAULT_GROUP_NAME = 'Default';
export const DEFAULT_VARIANT_LABEL = 'Default';

/** Case-insensitive color value lookup across the key spellings seen in data. */
export function colorFromAttributes(attrs: Record<string, string>): string | null {
  for (const key of Object.keys(attrs)) {
    const k = key.toLowerCase();
    if (k === 'color' || k === 'colour') return attrs[key] ?? null;
  }
  return null;
}

/**
 * Insert the listing's default group. Called eagerly from listing-create
 * transactions so "every listing has ≥1 group" holds from birth.
 */
export async function insertDefaultGroup(
  dbx: DbOrTx,
  listingId: string,
  storeId: string,
): Promise<VariantGroup> {
  const [row] = await dbx
    .insert(variantGroups)
    .values({
      id: newId(IdPrefix.VariantGroup),
      listingId,
      storeId,
      name: DEFAULT_GROUP_NAME,
      isDefault: true,
    })
    .returning();
  if (!row) throw AppError.internal('variant group insert returned no row');
  return row;
}

/**
 * The listing's default group, created on demand for listings that predate the
 * eager-create rule (drafts created mid-deploy, defensive paths).
 */
export async function getOrCreateDefaultGroup(
  dbx: DbOrTx,
  listingId: string,
  storeId: string,
): Promise<VariantGroup> {
  const existing = await dbx.query.variantGroups.findFirst({
    where: eq(variantGroups.listingId, listingId),
    orderBy: (t, { desc }) => [desc(t.isDefault)],
  });
  if (existing?.isDefault) return existing;
  return insertDefaultGroup(dbx, listingId, storeId);
}

/**
 * Resolve which group a new variant lands in:
 *   - explicit groupId → verified to belong to the listing;
 *   - else a color attribute → matching color group by case-insensitive name
 *     (created when `createMissing`, e.g. CSV import);
 *   - else the listing's default group.
 */
export async function resolveGroupId(
  dbx: DbOrTx,
  listing: { id: string; storeId: string },
  opts: {
    groupId?: string | undefined;
    attributes?: Record<string, string> | undefined;
    createMissing?: boolean;
  },
): Promise<string> {
  if (opts.groupId) {
    const group = await dbx.query.variantGroups.findFirst({
      where: eq(variantGroups.id, opts.groupId),
    });
    if (!group || group.listingId !== listing.id) {
      throw new AppError(404, ErrorCode.NotFound, 'Variant group not found on this listing');
    }
    return group.id;
  }

  const color = opts.attributes ? colorFromAttributes(opts.attributes) : null;
  if (color) {
    const groups = await dbx.query.variantGroups.findMany({
      where: eq(variantGroups.listingId, listing.id),
    });
    const match = groups.find((g) => g.name.toLowerCase() === color.toLowerCase());
    if (match) return match.id;
    if (opts.createMissing) {
      // Custom-template listings stay flat in the default group — never derive
      // color groups for them (a group rename would rewrite template attrs).
      const listingRow = await dbx.query.productListings.findFirst({
        where: eq(productListings.id, listing.id),
        columns: { variantMode: true },
      });
      if (listingRow?.variantMode !== 'custom') {
        const [row] = await dbx
          .insert(variantGroups)
          .values({
            id: newId(IdPrefix.VariantGroup),
            listingId: listing.id,
            storeId: listing.storeId,
            name: color,
            sortOrder: groups.length,
          })
          .returning();
        if (!row) throw AppError.internal('variant group insert returned no row');
        return row.id;
      }
    }
  }

  return (await getOrCreateDefaultGroup(dbx, listing.id, listing.storeId)).id;
}

/**
 * Server-derived identity for a system-path (color → size) variant. The default
 * group contributes no color key — its variants are size-only ("M") or, for the
 * single-product default variant, `{}` / "Default".
 */
export function deriveVariantIdentity(
  group: { name: string; isDefault: boolean },
  size: string | null | undefined,
): { attributes: Record<string, string>; attributesLabel: string } {
  const hasSize = typeof size === 'string' && size.trim().length > 0;
  if (group.isDefault) {
    // Default group carries no color. Size-only ("M") is a valid single-axis product;
    // no size AND no color means no axes at all — that's the single-product default
    // variant, which has its own idempotent endpoint.
    if (!hasSize) {
      throw AppError.validation(
        'A variant needs a colour or a size. For a product with neither, use the single-product default variant.',
      );
    }
    return { attributes: { size: size! }, attributesLabel: size! };
  }
  // Named (colour) group. Colour-only ("Black") is a valid single-axis product.
  if (!hasSize) {
    return { attributes: { color: group.name }, attributesLabel: group.name };
  }
  return {
    attributes: { color: group.name, size: size! },
    attributesLabel: `${group.name} / ${size!}`,
  };
}

/** Identity of the single-product default variant. */
export function defaultVariantIdentity(): {
  attributes: Record<string, string>;
  attributesLabel: string;
} {
  return { attributes: {}, attributesLabel: DEFAULT_VARIANT_LABEL };
}

/**
 * Guard a group delete: never the listing's last group, and every child variant
 * must individually be deletable (no reserved stock, no order history) — the
 * same rules `deleteVariant` applies, checked up front so the delete is
 * all-or-nothing.
 */
export async function assertGroupDeletable(
  dbx: DbOrTx,
  group: { id: string; listingId: string; name: string },
): Promise<{ childIds: string[] }> {
  const siblingCount = await dbx.$count(
    variantGroups,
    eq(variantGroups.listingId, group.listingId),
  );
  if (siblingCount <= 1) {
    throw new AppError(
      409,
      ErrorCode.InvalidState,
      'Cannot delete the last variant group on a product',
    );
  }

  const children = await dbx.query.variants.findMany({
    where: eq(variants.groupId, group.id),
    columns: { id: true, reserved: true, attributesLabel: true },
  });
  for (const child of children) {
    if (child.reserved > 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Cannot delete "${group.name}": "${child.attributesLabel}" has ${child.reserved} unit(s) reserved by open orders. Deactivate instead.`,
      );
    }
  }
  if (children.length > 0) {
    const linked = await dbx
      .select({ id: orderItems.id, variantId: orderItems.variantId })
      .from(orderItems)
      .where(inArray(orderItems.variantId, children.map((c) => c.id)))
      .limit(1);
    if (linked.length > 0) {
      throw new AppError(
        409,
        ErrorCode.InvalidState,
        `Cannot delete "${group.name}": its variants have order history. Deactivate instead to keep records intact.`,
      );
    }
  }
  return { childIds: children.map((c) => c.id) };
}
