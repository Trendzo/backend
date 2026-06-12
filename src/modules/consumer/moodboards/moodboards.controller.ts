/**
 * Consumer moodboards. Owner-scoped (auth.sub) for every read/write; a board read
 * always asserts ownership. Public reads live in the separate public.routes plugin.
 * Items reference products at listing level and join the live listing on read
 * (so a delisted product surfaces its status rather than freezing a snapshot).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { moodboardItems, moodboards, productListings } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { AddItemBody, CreateBoardBody, PatchBoardBody } from './moodboards.validators.js';

type Auth = AccessTokenPayload;

// ── shared shaping ──

type ItemWithListing = typeof moodboardItems.$inferSelect & {
  listing: Pick<typeof productListings.$inferSelect, 'id' | 'name' | 'galleryUrls' | 'status'>;
};

function shapeItem(it: ItemWithListing) {
  return {
    id: it.id,
    listingId: it.listingId,
    sortOrder: it.sortOrder,
    addedAt: it.addedAt,
    listing: {
      id: it.listing.id,
      name: it.listing.name,
      image: it.listing.galleryUrls[0] ?? null,
      status: it.listing.status,
    },
  };
}

function shapeBoardDetail(board: typeof moodboards.$inferSelect & { items: ItemWithListing[] }) {
  const items = [...board.items].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    id: board.id,
    name: board.name,
    note: board.note,
    isPublic: board.isPublic,
    status: board.status,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    itemCount: items.length,
    coverImageUrl: items[0]?.listing.galleryUrls[0] ?? null,
    items: items.map(shapeItem),
  };
}

const itemWith = {
  items: {
    with: {
      listing: { columns: { id: true, name: true, galleryUrls: true, status: true } },
    },
  },
} as const;

// ── owner endpoints ──

export async function createBoard(input: { auth: Auth; body: z.infer<typeof CreateBoardBody> }) {
  const { auth, body } = input;
  const [row] = await db
    .insert(moodboards)
    .values({
      id: newId(IdPrefix.Moodboard),
      consumerId: auth.sub,
      name: body.name,
      note: body.note ?? null,
      isPublic: body.isPublic ?? false,
    })
    .returning();
  return ok({
    id: row!.id,
    name: row!.name,
    note: row!.note,
    isPublic: row!.isPublic,
    status: row!.status,
    createdAt: row!.createdAt,
    updatedAt: row!.updatedAt,
    itemCount: 0,
    coverImageUrl: null,
  });
}

export async function listBoards(input: { auth: Auth }) {
  const boards = await db.query.moodboards.findMany({
    where: eq(moodboards.consumerId, input.auth.sub),
    orderBy: [desc(moodboards.updatedAt)],
    with: itemWith,
  });
  return ok(
    boards.map((b) => {
      const detail = shapeBoardDetail(b as typeof b & { items: ItemWithListing[] });
      // List view: summary only (count + cover), drop the full item array.
      const { items: _items, ...summary } = detail;
      return summary;
    }),
  );
}

async function loadOwnedBoard(consumerId: string, id: string) {
  const board = await db.query.moodboards.findFirst({
    where: and(eq(moodboards.id, id), eq(moodboards.consumerId, consumerId)),
    with: itemWith,
  });
  if (!board) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  return board as typeof board & { items: ItemWithListing[] };
}

export async function getBoard(input: { auth: Auth; id: string }) {
  const board = await loadOwnedBoard(input.auth.sub, input.id);
  return ok(shapeBoardDetail(board));
}

export async function patchBoard(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof PatchBoardBody>;
}) {
  const { auth, id, body } = input;
  const updates: Partial<typeof moodboards.$inferInsert> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.note !== undefined) updates.note = body.note;
  if (body.isPublic !== undefined) updates.isPublic = body.isPublic;
  const [updated] = await db
    .update(moodboards)
    .set(updates)
    .where(and(eq(moodboards.id, id), eq(moodboards.consumerId, auth.sub)))
    .returning({ id: moodboards.id });
  if (!updated) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  const board = await loadOwnedBoard(auth.sub, id);
  return ok(shapeBoardDetail(board));
}

export async function deleteBoard(input: { auth: Auth; id: string }) {
  const [deleted] = await db
    .delete(moodboards)
    .where(and(eq(moodboards.id, input.id), eq(moodboards.consumerId, input.auth.sub)))
    .returning({ id: moodboards.id });
  if (!deleted) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  return ok({ deleted: true });
}

export async function addItem(input: {
  auth: Auth;
  id: string;
  body: z.infer<typeof AddItemBody>;
}) {
  const { auth, id, body } = input;
  // Assert board ownership.
  const board = await db.query.moodboards.findFirst({
    where: and(eq(moodboards.id, id), eq(moodboards.consumerId, auth.sub)),
    columns: { id: true },
  });
  if (!board) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  // Validate the listing exists.
  const listing = await db.query.productListings.findFirst({
    where: eq(productListings.id, body.listingId),
    columns: { id: true },
  });
  if (!listing) throw new AppError(404, ErrorCode.NotFound, 'Product not found');

  try {
    const [item] = await db
      .insert(moodboardItems)
      .values({ id: newId(IdPrefix.MoodboardItem), moodboardId: id, listingId: body.listingId })
      .returning();
    await db.update(moodboards).set({ updatedAt: new Date() }).where(eq(moodboards.id, id));
    return ok({ id: item!.id, listingId: item!.listingId, addedAt: item!.addedAt });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, ErrorCode.InvalidState, 'Product already in this board');
    }
    throw err;
  }
}

export async function removeItem(input: { auth: Auth; id: string; itemId: string }) {
  const { auth, id, itemId } = input;
  const board = await db.query.moodboards.findFirst({
    where: and(eq(moodboards.id, id), eq(moodboards.consumerId, auth.sub)),
    columns: { id: true },
  });
  if (!board) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  const [removed] = await db
    .delete(moodboardItems)
    .where(and(eq(moodboardItems.id, itemId), eq(moodboardItems.moodboardId, id)))
    .returning({ id: moodboardItems.id });
  if (!removed) throw new AppError(404, ErrorCode.NotFound, 'Item not found');
  await db.update(moodboards).set({ updatedAt: new Date() }).where(eq(moodboards.id, id));
  return ok({ deleted: true });
}

// ── public share read (unauthenticated) ──

export async function getPublicBoard(input: { id: string }) {
  const board = await db.query.moodboards.findFirst({
    where: and(
      eq(moodboards.id, input.id),
      eq(moodboards.isPublic, true),
      eq(moodboards.status, 'active'),
    ),
    with: itemWith,
  });
  if (!board) throw new AppError(404, ErrorCode.NotFound, 'Moodboard not found');
  const detail = shapeBoardDetail(board as typeof board & { items: ItemWithListing[] });
  // Public payload omits the owner-only `status` flag.
  const { status: _status, ...pub } = detail;
  return ok(pub);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
