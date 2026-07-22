import { buildApp } from './app.js';
import { env } from './config/env.js';
import { db, pool } from './db/client.js';
import { processAcceptanceWindowSweep } from './shared/orders/routing.js';
import { processDoorWindowSweep } from './shared/orders/door-visit.js';
import { runLifecycleSweeps } from './shared/orders/lifecycle-sweeps.js';
import { processBulkMockupQueue } from './shared/bulk-mockups/worker.js';

const app = buildApp();

const ACCEPTANCE_SWEEP_INTERVAL_MS = 60_000;
const DOOR_SWEEP_INTERVAL_MS = 60_000;
const LIFECYCLE_SWEEP_INTERVAL_MS = 60_000;
// Bulk-mockup queue polls fast — jobs are user-visible and the worker processes
// one at a time (re-entrancy-guarded), so an idle tick is cheap.
const BULK_MOCKUP_INTERVAL_MS = 5_000;
let sweepHandle: ReturnType<typeof setInterval> | null = null;
let doorSweepHandle: ReturnType<typeof setInterval> | null = null;
let lifecycleSweepHandle: ReturnType<typeof setInterval> | null = null;
let bulkMockupHandle: ReturnType<typeof setInterval> | null = null;

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`ClosetX backend listening on :${env.PORT} (${env.NODE_ENV})`);
    sweepHandle = setInterval(() => {
      processAcceptanceWindowSweep()
        .then((r) => {
          if (r.swept > 0) {
            app.log.info({ swept: r.swept, cancelled: r.cancelled }, 'acceptance-sweep');
          }
        })
        .catch((e) => app.log.error({ err: e }, 'acceptance-sweep failed'));
    }, ACCEPTANCE_SWEEP_INTERVAL_MS);
    doorSweepHandle = setInterval(() => {
      processDoorWindowSweep(db)
        .then((closed) => {
          if (closed > 0) app.log.info({ closed }, 'door-window-sweep');
        })
        .catch((e) => app.log.error({ err: e }, 'door-window-sweep failed'));
    }, DOOR_SWEEP_INTERVAL_MS);
    lifecycleSweepHandle = setInterval(() => {
      runLifecycleSweeps(db)
        .then((c) => {
          if (Object.values(c).some((n) => n > 0)) app.log.info(c, 'lifecycle-sweep');
        })
        .catch((e) => app.log.error({ err: e }, 'lifecycle-sweep failed'));
    }, LIFECYCLE_SWEEP_INTERVAL_MS);
    bulkMockupHandle = setInterval(() => {
      processBulkMockupQueue(db)
        .then((id) => {
          if (id) app.log.info({ jobId: id }, 'bulk-mockup-processed');
        })
        .catch((e) => app.log.error({ err: e }, 'bulk-mockup-worker failed'));
    }, BULK_MOCKUP_INTERVAL_MS);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    if (sweepHandle) clearInterval(sweepHandle);
    if (doorSweepHandle) clearInterval(doorSweepHandle);
    if (lifecycleSweepHandle) clearInterval(lifecycleSweepHandle);
    if (bulkMockupHandle) clearInterval(bulkMockupHandle);
    await app.close();
    await pool.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
