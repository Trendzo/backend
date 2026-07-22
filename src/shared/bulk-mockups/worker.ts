/**
 * Bulk-mockup queue worker (beta). Claims one `queued` job at a time using the
 * canonical durable-queue primitive — `SELECT ... FOR UPDATE SKIP LOCKED` inside
 * a transaction — flips it to `processing`, generates the multi-angle set via the
 * SHARED AI pipeline (identical output to the synchronous submission flow), and
 * writes the URLs back. Re-entrancy-guarded so a long job never stacks ticks.
 *
 * Wired as a `setInterval` in server.ts alongside the lifecycle sweeps.
 */
import { asc, eq } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import { bulkMockupJobs } from '@/db/schema/index.js';
import {
  generateMockupViews,
  type GenerateViewsInput,
} from '@/shared/ai-catalog/generate-views.js';

const BULK_FOLDER = 'closetx/bulk-mockups';
const MAX_ATTEMPTS = 3;

let running = false;

/**
 * Process at most one queued job. Returns the claimed job id (or null when the
 * queue was empty / a prior tick is still draining).
 */
export async function processBulkMockupQueue(database: typeof Db): Promise<string | null> {
  if (running) return null;
  running = true;
  try {
    // Atomically claim the oldest queued job and mark it processing. SKIP LOCKED
    // means concurrent workers/instances never grab the same row.
    const claimed = await database.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(bulkMockupJobs)
        .where(eq(bulkMockupJobs.status, 'queued'))
        .orderBy(asc(bulkMockupJobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const job = rows[0];
      if (!job) return null;
      await tx
        .update(bulkMockupJobs)
        .set({ status: 'processing', startedAt: new Date(), attempts: job.attempts + 1 })
        .where(eq(bulkMockupJobs.id, job.id));
      return job;
    });

    if (!claimed) return null;

    try {
      const input = claimed.request as unknown as GenerateViewsInput;
      const { printedUrl, views } = await generateMockupViews(input, BULK_FOLDER);
      const outputUrls = [...(printedUrl ? [printedUrl] : []), ...views.map((v) => v.url)];
      await database
        .update(bulkMockupJobs)
        .set({ status: 'ready', outputUrls, finishedAt: new Date(), errorMessage: null })
        .where(eq(bulkMockupJobs.id, claimed.id));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      // attempts was already incremented at claim time. Requeue until the ceiling,
      // then park as failed. Guard the requeue on status so a cancel/dismiss that
      // landed mid-generation wins (only overwrite while still `processing`).
      const attempts = claimed.attempts + 1;
      const next = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
      await database
        .update(bulkMockupJobs)
        .set({
          status: next,
          errorMessage: message,
          ...(next === 'failed' ? { finishedAt: new Date() } : { startedAt: null }),
        })
        .where(eq(bulkMockupJobs.id, claimed.id));
      console.error(`[bulk-mockup] job ${claimed.id} failed (attempt ${attempts}): ${message}`);
    }

    return claimed.id;
  } catch (e) {
    console.error(`[bulk-mockup] worker tick failed: ${(e as Error).message}`);
    return null;
  } finally {
    running = false;
  }
}
