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
import { ok } from '@/shared/http/envelope.js';

const HomeQuery = z.object({
  /** Which rail. Omitted keeps every audience, which is what a gender-less client gets. */
  gender: z.enum(['her', 'him']).optional(),
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
};

export default publicCmsRoutes;
