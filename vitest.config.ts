import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Integration tests boot a throwaway embedded Postgres (test/global-setup.ts) and drive
 * the real Fastify app via `.inject`. DB-backed tests must not run in parallel against the
 * shared test DB, hence a single fork and no file parallelism.
 *
 * tsconfigPaths resolves the `@/*` → `src/*` aliases (and the TS-ESM `.js`→`.ts`
 * specifier rewrite) so tests can exercise modules that import via `@/...`.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Set before any worker loads config/env.ts; dotenv won't override an existing value,
    // so this points the app at the local test DB instead of the Neon URL in .env.
    env: {
      DATABASE_URL: 'postgresql://test:test@localhost:5434/closetx_test',
      NODE_ENV: 'test',
    },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
