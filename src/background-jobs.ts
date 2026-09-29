/**
 * Background loops started alongside the HTTP server: order acceptance-window
 * sweep, door-visit window sweep, the lifecycle sweeps (cancellations, refunds,
 * store pauses, notifications) and the bulk-mockup worker.
 *
 * They act on real orders and money, so a non-primary deployment (a mirror or
 * standby pointed at a copy of production data) must not run them:
 * BACKGROUND_JOBS_ENABLED=false starts none of them. Default is on.
 */
import type { FastifyBaseLogger } from 'fastify';
import { env } from './config/env.js';
import { db } from './db/client.js';
import { processAcceptanceWindowSweep } from './shared/orders/routing.js';
import { processDoorWindowSweep } from './shared/orders/door-visit.js';
import { runLifecycleSweeps } from './shared/orders/lifecycle-sweeps.js';
import { processBulkMockupQueue } from './shared/bulk-mockups/worker.js';

const ACCEPTANCE_SWEEP_INTERVAL_MS = 60_000;
const DOOR_SWEEP_INTERVAL_MS = 60_000;
const LIFECYCLE_SWEEP_INTERVAL_MS = 60_000;
// Bulk-mockup queue polls fast — jobs are user-visible and the worker processes
// one at a time (re-entrancy-guarded), so an idle tick is cheap.
const BULK_MOCKUP_INTERVAL_MS = 5_000;

type JobLogger = Pick<FastifyBaseLogger, 'info' | 'error'>;

/** Start every background loop (unless disabled). Returns a stop function. */
export function startBackgroundJobs(
  log: JobLogger,
  enabled: boolean = env.BACKGROUND_JOBS_ENABLED === 'true',
): () => void {
  if (!enabled) {
    log.info('background jobs disabled (BACKGROUND_JOBS_ENABLED=false)');
    return () => {};
  }

  const handles = [
    setInterval(() => {
      processAcceptanceWindowSweep()
        .then((r) => {
          if (r.swept > 0) log.info({ swept: r.swept, cancelled: r.cancelled }, 'acceptance-sweep');
        })
        .catch((e) => log.error({ err: e }, 'acceptance-sweep failed'));
    }, ACCEPTANCE_SWEEP_INTERVAL_MS),
    setInterval(() => {
      processDoorWindowSweep(db)
        .then((closed) => {
          if (closed > 0) log.info({ closed }, 'door-window-sweep');
        })
        .catch((e) => log.error({ err: e }, 'door-window-sweep failed'));
    }, DOOR_SWEEP_INTERVAL_MS),
    setInterval(() => {
      runLifecycleSweeps(db)
        .then((c) => {
          if (Object.values(c).some((n) => n > 0)) log.info(c, 'lifecycle-sweep');
        })
        .catch((e) => log.error({ err: e }, 'lifecycle-sweep failed'));
    }, LIFECYCLE_SWEEP_INTERVAL_MS),
    setInterval(() => {
      processBulkMockupQueue(db)
        .then((id) => {
          if (id) log.info({ jobId: id }, 'bulk-mockup-processed');
        })
        .catch((e) => log.error({ err: e }, 'bulk-mockup-worker failed'));
    }, BULK_MOCKUP_INTERVAL_MS),
  ];
  return () => handles.forEach((h) => clearInterval(h));
}
