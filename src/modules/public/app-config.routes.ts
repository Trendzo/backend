/**
 * GET /app-config — the values client apps must not hardcode.
 *
 * Two classes of bug motivated this:
 *
 *  1. Support contact. The consumer app shipped a phone number, email and
 *     opening hours as string literals. If any changes, a released build sends
 *     customers to a dead line — and the only place the real address lived was
 *     the server-rendered HTML support page, which no JSON endpoint exposed.
 *
 *  2. The try-on window. The app promised "15 min" in eight places while the
 *     backend reads `try_on_window_seconds` from platform_config and falls back
 *     to 600 in code. On any environment missing that row the courier left after
 *     ten minutes while the app had promised fifteen.
 *
 * Public and unauthenticated: it carries no per-user data, and the copy that
 * needs it renders before sign-in. Cache-friendly — the values change rarely.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { platformConfig } from '@/db/schema/index.js';
import { env } from '@/config/env.js';
import { ok } from '@/shared/http/envelope.js';

/** Mirrors door-visit.ts — keep the fallbacks identical or the copy lies again. */
const DEFAULT_TRY_ON_WINDOW_SECONDS = 600;
const DEFAULT_TRY_ON_EXTENSION_SECONDS = 300;
/** Mirrors shared/returns/open-return.ts RETURN_WINDOW_DAYS. */
const DEFAULT_RETURN_WINDOW_DAYS = 7;

async function readNumber(key: string, fallback: number): Promise<number> {
  const row = await db.query.platformConfig.findFirst({
    where: eq(platformConfig.key, key),
  });
  if (!row) return fallback;
  return typeof row.value === 'number' ? (row.value as number) : fallback;
}

const appConfigRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/', async () => {
    const [tryOnWindowSeconds, tryOnExtensionSeconds, returnWindowDays] = await Promise.all([
      readNumber('try_on_window_seconds', DEFAULT_TRY_ON_WINDOW_SECONDS),
      readNumber('try_on_extension_seconds', DEFAULT_TRY_ON_EXTENSION_SECONDS),
      readNumber('return_window_days', DEFAULT_RETURN_WINDOW_DAYS),
    ]);

    return ok({
      support: {
        email: env.PUBLIC_SUPPORT_EMAIL,
        // Optional in env — null tells the app to hide the row rather than
        // render a placeholder number that nobody answers.
        phone: env.PUBLIC_SUPPORT_PHONE ?? null,
        address: env.PUBLIC_BUSINESS_ADDRESS ?? null,
        hours: env.PUBLIC_SUPPORT_HOURS ?? null,
      },
      tryAndBuy: {
        windowSeconds: tryOnWindowSeconds,
        extensionSeconds: tryOnExtensionSeconds,
        // NOT enforced anywhere in the backend — no table, no config key, no
        // validation. Exposed as null so the app can hide the claim instead of
        // stating a rule nothing checks. Give these real values only once
        // something actually enforces them.
        maxItemsPerTrial: null as number | null,
        maxTrialsPerMonth: null as number | null,
      },
      returns: {
        windowDays: returnWindowDays,
      },
      company: {
        name: env.PUBLIC_COMPANY_NAME,
        appName: env.PUBLIC_APP_NAME,
      },
    });
  });
};

export default appConfigRoutes;
