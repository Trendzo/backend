import { buildApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './db/client.js';
import { startBackgroundJobs } from './background-jobs.js';
import { closeCrmDb } from './crm/db/client.js';

const app = buildApp();

let stopBackgroundJobs: () => void = () => {};

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`ClosetX backend listening on :${env.PORT} (${env.NODE_ENV})`);
    stopBackgroundJobs = startBackgroundJobs(app.log);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  try {
    stopBackgroundJobs();
    await app.close();
    await pool.end();
    // The CRM's Mongo pool is lazy — this is a no-op when no CRM route was ever hit.
    await closeCrmDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
    process.exit(1);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

void start();
