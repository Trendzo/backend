import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { db } from '@/db/client.js';
import { ok } from '@/shared/http/envelope.js';
import { currentLegalDoc, LEGAL_DOC_LABELS } from '@/shared/terms.js';

const KindParam = z.object({ kind: z.enum(['terms', 'privacy']) });

/**
 * PUBLIC legal-content API — no auth. Serves ONLY the latest published version of
 * each document (the same content the admin edits at /admin/terms), so signup
 * screens and the public HTML pages render one source of truth. Version history,
 * publish, and accept/decline all stay behind their protected routes.
 *
 *   GET /api/v1/legal/terms    → { kind, docName, version, label, shortText }
 *   GET /api/v1/legal/privacy
 */
const publicLegalApiRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/:kind', { schema: { params: KindParam } }, async (req) => {
    const doc = await currentLegalDoc(db, req.params.kind);
    return ok({
      kind: req.params.kind,
      docName: LEGAL_DOC_LABELS[req.params.kind],
      version: doc.version,
      label: doc.label,
      shortText: doc.shortText,
    });
  });
};

export default publicLegalApiRoutes;
