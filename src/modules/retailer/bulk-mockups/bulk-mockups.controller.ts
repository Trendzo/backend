import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { bulkMockupJobs, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId } from '@/shared/ids.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { EnqueueBody, ListQuery } from './bulk-mockups.validators.js';

type Auth = AccessTokenPayload;

// Bound the backlog a single store can queue — protects generation cost/quota.
const MAX_ACTIVE_JOBS = 50;

async function loadStore(retailerId: string) {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
  });
  if (!retailer?.storeId) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, retailer.storeId),
  });
  if (!store) throw new AppError(404, ErrorCode.NotFound, 'Store not found');
  return store;
}

/** Enqueue one generation job (returns immediately; the worker generates async). */
export async function enqueue(input: { auth: Auth; body: z.infer<typeof EnqueueBody> }) {
  const store = await loadStore(input.auth.sub);
  const { body } = input;

  const active = await db.query.bulkMockupJobs.findMany({
    where: and(
      eq(bulkMockupJobs.storeId, store.id),
      inArray(bulkMockupJobs.status, ['queued', 'processing', 'ready']),
    ),
    columns: { id: true },
  });
  if (active.length >= MAX_ACTIVE_JOBS) {
    throw new AppError(
      429,
      ErrorCode.RateLimited,
      `Too many pending mockups (${active.length}/${MAX_ACTIVE_JOBS}). Finish or dismiss some first.`,
    );
  }

  const referenceImageUrls = [
    ...body.apparelImageUrls,
    ...(body.apparelBackImageUrl ? [body.apparelBackImageUrl] : []),
    ...(body.designImageUrl ? [body.designImageUrl] : []),
    ...(body.patternCloseupUrl ? [body.patternCloseupUrl] : []),
    ...(body.logoCloseupUrl ? [body.logoCloseupUrl] : []),
    ...(body.tagLabelUrl ? [body.tagLabelUrl] : []),
  ];

  const id = newId('bmj');
  const [row] = await db
    .insert(bulkMockupJobs)
    .values({
      id,
      storeId: store.id,
      mode: body.mode,
      prompt: body.prompt ?? null,
      request: body as Record<string, unknown>,
      referenceImageUrls,
      outputUrls: [],
      status: 'queued',
    })
    .returning();
  return ok(row);
}

/** List this store's jobs (optionally filtered by status), newest first. */
export async function list(input: { auth: Auth; query: z.infer<typeof ListQuery> }) {
  const store = await loadStore(input.auth.sub);
  const where = input.query.status
    ? and(eq(bulkMockupJobs.storeId, store.id), eq(bulkMockupJobs.status, input.query.status))
    : // Default view hides dismissed jobs.
      and(eq(bulkMockupJobs.storeId, store.id), ne(bulkMockupJobs.status, 'dismissed'));
  const rows = await db.query.bulkMockupJobs.findMany({
    where,
    orderBy: [desc(bulkMockupJobs.createdAt)],
    limit: input.query.limit,
  });
  return ok(rows);
}

/** Counts for the header badge. */
export async function summary(input: { auth: Auth }) {
  const store = await loadStore(input.auth.sub);
  const rows = await db
    .select({ status: bulkMockupJobs.status, count: sql<number>`count(*)::int` })
    .from(bulkMockupJobs)
    .where(eq(bulkMockupJobs.storeId, store.id))
    .groupBy(bulkMockupJobs.status);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const queued = by['queued'] ?? 0;
  const processing = by['processing'] ?? 0;
  const ready = by['ready'] ?? 0;
  return ok({ queued, processing, ready, pending: queued + processing });
}

async function loadOwnedJob(storeId: string, id: string) {
  const job = await db.query.bulkMockupJobs.findFirst({
    where: and(eq(bulkMockupJobs.id, id), eq(bulkMockupJobs.storeId, storeId)),
  });
  if (!job) throw new AppError(404, ErrorCode.NotFound, 'Job not found');
  return job;
}

/** Cancel a job — only while still `queued` (processing runs to completion). */
export async function cancel(input: { auth: Auth; id: string }) {
  const store = await loadStore(input.auth.sub);
  const job = await loadOwnedJob(store.id, input.id);
  if (job.status !== 'queued') {
    throw new AppError(409, ErrorCode.InvalidState, `Cannot cancel a ${job.status} job`);
  }
  // Guard on status in the UPDATE so a worker claim racing us loses cleanly.
  const [row] = await db
    .update(bulkMockupJobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(bulkMockupJobs.id, job.id), eq(bulkMockupJobs.status, 'queued')))
    .returning();
  if (!row) throw new AppError(409, ErrorCode.InvalidState, 'Job already started');
  return ok({ id: row.id, status: row.status });
}

/** Dismiss a terminal job so it drops out of the lists (manual cleanup). */
export async function dismiss(input: { auth: Auth; id: string }) {
  const store = await loadStore(input.auth.sub);
  const job = await loadOwnedJob(store.id, input.id);
  if (!['ready', 'failed', 'cancelled'].includes(job.status)) {
    throw new AppError(409, ErrorCode.InvalidState, `Cannot dismiss a ${job.status} job`);
  }
  const [row] = await db
    .update(bulkMockupJobs)
    .set({ status: 'dismissed', dismissedAt: new Date() })
    .where(eq(bulkMockupJobs.id, job.id))
    .returning();
  return ok({ id: row!.id, status: row!.status });
}
