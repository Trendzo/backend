/**
 * Server-side cart for authenticated consumers — a thin {variantId, qty} sync so a logged-in
 * user sees the same cart across devices. Guest carts stay client-side and never reach the DB.
 *
 * One row per consumer (carts, unique on consumer_id), items embedded as a jsonb array. Item
 * mutations run inside a transaction with a `FOR UPDATE` row lock so concurrent writes from a
 * user's multiple devices can't clobber each other; the row is upserted so a first-write race
 * resolves to a single row. variantIds are NOT FK-checked here — the table is deliberately
 * churn-tolerant; validity is enforced at /consumer/checkout/validate.
 */
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { carts } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { MAX_ITEMS, MAX_QTY } from './cart.validators.js';
import type { AddItemBody, ReplaceCartBody, SetQtyBody } from './cart.validators.js';

type Auth = AccessTokenPayload;
type Item = { variantId: string; qty: number };
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const clampQty = (q: number) => Math.max(1, Math.min(MAX_QTY, Math.trunc(q)));

/**
 * Canonicalize an items array: drop blanks, merge duplicate variantIds (summing qty),
 * clamp each qty, preserve first-seen order, cap total lines.
 */
function normalizeItems(items: Item[]): Item[] {
  const byVariant = new Map<string, number>();
  for (const it of items) {
    const id = it.variantId.trim();
    if (!id) continue;
    // New variant beyond the cap is dropped; an already-present one still merges.
    if (!byVariant.has(id) && byVariant.size >= MAX_ITEMS) continue;
    byVariant.set(id, clampQty((byVariant.get(id) ?? 0) + it.qty));
  }
  return Array.from(byVariant, ([variantId, qty]) => ({ variantId, qty }));
}

function cartOut(row: { items: Item[]; updatedAt: Date } | null) {
  return ok({
    items: row?.items ?? [],
    updatedAt: row?.updatedAt ?? null,
  });
}

/** Lock + read the consumer's cart row inside a tx (null if none yet). */
async function lockCart(tx: Tx, consumerId: string) {
  const [row] = await tx
    .select()
    .from(carts)
    .where(eq(carts.consumerId, consumerId))
    .for('update');
  return row ?? null;
}

/** Upsert the single per-consumer row with a canonical items array; returns the stored row. */
async function writeItems(tx: Tx, consumerId: string, items: Item[]) {
  const normalized = normalizeItems(items);
  const [row] = await tx
    .insert(carts)
    .values({ id: newId(IdPrefix.Cart), consumerId, items: normalized, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: carts.consumerId,
      set: { items: normalized, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function getCart(input: { auth: Auth }) {
  const row = await db.query.carts.findFirst({
    where: eq(carts.consumerId, input.auth.sub),
  });
  return cartOut(row ?? null);
}

export async function replaceCart(input: { auth: Auth; body: z.infer<typeof ReplaceCartBody> }) {
  const row = await db.transaction(async (tx) => {
    await lockCart(tx, input.auth.sub);
    return writeItems(tx, input.auth.sub, input.body.items);
  });
  return cartOut(row);
}

export async function addItem(input: { auth: Auth; body: z.infer<typeof AddItemBody> }) {
  const row = await db.transaction(async (tx) => {
    const current = await lockCart(tx, input.auth.sub);
    const items = [...(current?.items ?? []), input.body]; // normalizeItems merges the dup
    return writeItems(tx, input.auth.sub, items);
  });
  return cartOut(row);
}

export async function setItemQty(input: {
  auth: Auth;
  variantId: string;
  body: z.infer<typeof SetQtyBody>;
}) {
  const row = await db.transaction(async (tx) => {
    const current = await lockCart(tx, input.auth.sub);
    const existing = current?.items ?? [];
    let items: Item[];
    if (input.body.qty <= 0) {
      items = existing.filter((it) => it.variantId !== input.variantId);
    } else if (existing.some((it) => it.variantId === input.variantId)) {
      items = existing.map((it) =>
        it.variantId === input.variantId ? { ...it, qty: input.body.qty } : it,
      );
    } else {
      items = [...existing, { variantId: input.variantId, qty: input.body.qty }];
    }
    return writeItems(tx, input.auth.sub, items);
  });
  return cartOut(row);
}

export async function removeItem(input: { auth: Auth; variantId: string }) {
  const row = await db.transaction(async (tx) => {
    const current = await lockCart(tx, input.auth.sub);
    const items = (current?.items ?? []).filter((it) => it.variantId !== input.variantId);
    return writeItems(tx, input.auth.sub, items);
  });
  return cartOut(row);
}

export async function clearCart(input: { auth: Auth }) {
  // Empty the items array but keep the row (cheap, avoids a re-insert on next add).
  const [row] = await db
    .update(carts)
    .set({ items: sql`'[]'::jsonb`, updatedAt: new Date() })
    .where(eq(carts.consumerId, input.auth.sub))
    .returning();
  return cartOut(row ?? null);
}
