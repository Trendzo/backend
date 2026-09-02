/**
 * GET /cms/home — the merchandising content the consumer app renders above its product feed.
 *
 * Public and unauthenticated, like /app-config: none of it is per-user, and all of it renders
 * before sign-in. It serves the latest PUBLISHED snapshot only, never the draft, so an editor
 * mid-campaign is never visible to customers.
 *
 * Three things are deliberately not here. There is no auth, so no personalisation. There is no
 * pagination — the payload is a few dozen items and the app wants all of it in one round trip
 * on a cold start. And there is no Cache-Control header: `@fastify/etag` gives this route a
 * strong revalidation story, and the app's `cachedGet` already holds its own TTL and sends
 * `If-None-Match`, so an unchanged snapshot costs a 304 with no body.
 *
 * `city` is optional and shapes targeting: a city-restricted item is hidden from a caller whose
 * city we do not know, which is the safe direction — showing a Mumbai-only campaign nationwide
 * is worse than not showing it at all.
 */
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { latestPublication } from '@/shared/cms/published.js';
import { filterPayload } from '@/shared/cms/render.js';
import { buildThemeResponse, resolveTheme } from '@/shared/cms/theme-render.js';
import { latestThemePublication } from '@/shared/cms/theme-published.js';
import type { ThemePlatform } from '@/shared/cms/theme-schema.js';
import { ok } from '@/shared/http/envelope.js';

const HomeQuery = z.object({
  /** Which rail. Omitted keeps every audience, which is what a gender-less client gets. */
  gender: z.enum(['her', 'him']).optional(),
  city: z.string().min(1).max(80).optional(),
});

const ThemeQuery = z.object({
  city: z.string().min(1).max(80).optional(),
});

const publicCmsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/home', { schema: { querystring: HomeQuery } }, async (req) => {
    const { version, snapshot } = await latestPublication();
    const filtered = filterPayload(snapshot, {
      ...(req.query.gender ? { gender: req.query.gender } : {}),
      ...(req.query.city ? { city: req.query.city } : {}),
      now: new Date(),
    });

    // `version: null` means nothing has ever been published here. The app treats that the same
    // as an empty section list and renders its own shipped content file.
    return ok({ version, ...filtered });
  });

  /**
   * GET /cms/theme — the active festival theme, resolved to exactly ONE winner (or null).
   *
   * Unauthenticated like /home: chrome renders before sign-in. The app does no date or
   * priority math — windows, city, platform (x-app-platform) and min-app-version
   * (x-app-version) gates are all applied here, and `theme: null` is the normal answer for
   * most of the year, meaning "render the bundled LIGHT look".
   *
   * ETag is SEMANTIC, set before the body: the payload embeds `generatedAt`, so the etag
   * plugin's body hash would change on every request and never 304. A pre-set etag makes
   * the plugin skip hashing while still honoring If-None-Match (verified against
   * @fastify/etag). A 304 leaves the client with an older generatedAt, which is fine — the
   * winner is byte-identical and refreshAfterSeconds bounds staleness.
   */
  app.get('/theme', { schema: { querystring: ThemeQuery } }, async (req, reply) => {
    const { version, snapshot } = await latestThemePublication();

    const rawPlatform = req.headers['x-app-platform'];
    const platform: ThemePlatform | null =
      rawPlatform === 'ios' || rawPlatform === 'android' ? rawPlatform : null;
    const rawVersion = req.headers['x-app-version'];
    const appVersion = typeof rawVersion === 'string' ? rawVersion : null;

    const winner = resolveTheme(snapshot, {
      now: new Date(),
      city: req.query.city ?? null,
      platform,
      appVersion,
    });

    reply.header('etag', `W/"theme:${version ?? 0}:${winner?.slug ?? 'none'}"`);
    reply.header('vary', 'x-app-version, x-app-platform');
    // Unlike /home, this response is TIME-varying: a window opens at midnight and
    // the kill switch must land within minutes. Without an explicit max-age an
    // intermediary may apply a heuristic TTL and serve a killed theme long past
    // every bound this system documents. 60s matches the server-side snapshot cache.
    reply.header('cache-control', 'public, max-age=60, must-revalidate');

    return ok(buildThemeResponse(version, winner));
  });
};

export default publicCmsRoutes;
