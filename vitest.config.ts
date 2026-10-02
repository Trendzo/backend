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
      // Force the mock gateway: a developer's .env may carry live Razorpay keys,
      // and tests must never hit the network. env.ts treats '' as unset.
      RAZORPAY_KEY_ID: '',
      RAZORPAY_KEY_SECRET: '',
      RAZORPAY_WEBHOOK_SECRET: '',
      // In-process storage: uploads exercise the real key derivation, sniffing and guards
      // without touching Cloudinary or S3. A developer's .env may carry live credentials.
      STORAGE_DRIVER: 'memory',
      // AI listing copy is best-effort network I/O to Gemini/OpenRouter — off in tests.
      AI_PRODUCT_COPY_ENABLED: 'false',
      // Login tests mint `fake:<phone>` OTP tokens instead of calling MSG91/Slide, and a
      // developer's .env must not change which provider the suite exercises.
      OTP_PROVIDER: 'fake',
      OTP_ACCEPT_LEGACY_MSG91: 'false',
      MSG91_AUTH_KEY: '',
      MSG91_RETAILER_AUTH_KEY: '',
      MSG91_DRIVER_AUTH_KEY: '',
      SLIDE_API_KEY: '',
      SLIDE_APP_WIDGET_ID: '',
      SLIDE_WEB_WIDGET_ID: '',
      SLIDE_CLIENT_TOKEN: '',
    },
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
