import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { processAcceptanceWindowSweep } from './shared/orders/routing.js';
import { processHeldItemExpiryWarningSweep } from './shared/held-items/expiry-warning-sweep.js';

const app = buildApp();

const ACCEPTANCE_SWEEP_INTERVAL_MS = 60_000;
const WARNING_SWEEP_INTERVAL_MS = 15 * 60_000;
let sweepHandle: ReturnType<typeof setInterval> | null = null;
let warningSweepHandle: ReturnType<typeof setInterval> | null = null;

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
    warningSweepHandle = setInterval(() => {
      processHeldItemExpiryWarningSweep()
        .then((r) => {
          if (r.warned > 0) {
            app.log.info({ warned: r.warned }, 'held-item-warning-sweep');
          }
        })
        .catch((e) => app.log.error({ err: e }, 'held-item-warning-sweep failed'));
    }, WARNING_SWEEP_INTERVAL_MS);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    if (sweepHandle) clearInterval(sweepHandle);
    if (warningSweepHandle) clearInterval(warningSweepHandle);
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
