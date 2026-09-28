/**
 * Backfill: convert plain-text `product_listings.description_long` values to HTML.
 *
 * The column is rendered as HTML everywhere (dashboard RichTextView, consumer app RichText,
 * the TipTap editor), but the retailer app used to save its plain multiline input verbatim,
 * so those rows render as one run-on paragraph. Writes are now normalized on the way in
 * (listings.controller → sanitizeLongDescription → plainTextToHtml); this fixes rows saved
 * before that. CLI: scripts/backfill-long-description-html.ts.
 *
 * Uses the exact write-path functions, so a backfilled row is byte-identical to what a fresh
 * save would store. Idempotent: converted rows contain tags and are skipped on a re-run. Each
 * update is guarded on the value it read, so a listing edited mid-run is left alone.
 */
import { and, asc, eq, gt, isNotNull } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { productListings } from '@/db/schema/index.js';
import { looksLikeHtml, plainTextToHtml, sanitizeRichText } from '@/shared/sanitize/rich-text.js';

export type BackfillResult = {
  scanned: number;
  converted: number;
  skippedConcurrent: number;
  samples: Array<{ id: string; before: string; after: string | null }>;
};

export async function backfillLongDescriptionHtml(
  database: typeof Db,
  opts: { apply: boolean; batchSize?: number },
): Promise<BackfillResult> {
  const batchSize = opts.batchSize ?? 500;
  const result: BackfillResult = { scanned: 0, converted: 0, skippedConcurrent: 0, samples: [] };
  let cursor = '';

  for (;;) {
    const rows = await database
      .select({ id: productListings.id, descriptionLong: productListings.descriptionLong })
      .from(productListings)
      .where(and(isNotNull(productListings.descriptionLong), gt(productListings.id, cursor)))
      .orderBy(asc(productListings.id))
      .limit(batchSize);
    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = last.id;
    result.scanned += rows.length;

    for (const row of rows) {
      const before = row.descriptionLong;
      if (before === null || looksLikeHtml(before)) continue;
      // A content-free value normalizes to null, same as a fresh save would store.
      const after = sanitizeRichText(plainTextToHtml(before));
      result.converted += 1;
      if (result.samples.length < 3) result.samples.push({ id: row.id, before, after });
      if (!opts.apply) continue;
      const updated = await database
        .update(productListings)
        .set({ descriptionLong: after })
        .where(and(eq(productListings.id, row.id), eq(productListings.descriptionLong, before)))
        .returning({ id: productListings.id });
      if (!updated.length) result.skippedConcurrent += 1;
    }
  }
  return result;
}
