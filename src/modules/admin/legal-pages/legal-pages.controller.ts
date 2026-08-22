import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import { appPrivacyPolicies, PRIVACY_APPS, type PrivacyApp } from '@/db/schema/legal-pages.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { AppError } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { sanitizeRichText } from '@/shared/sanitize/rich-text.js';
import {
  defaultPolicy,
  defaultPolicyHtml,
  PRIVACY_APP_LABELS,
} from '@/shared/app-privacy-content.js';
import type { UpdatePolicyBody } from './legal-pages.validators.js';

type Auth = AccessTokenPayload;

type PolicyRow = typeof appPrivacyPolicies.$inferSelect;

/** The effective policy for an app: the DB override if present, else the built-in default. */
async function resolvePolicy(app: PrivacyApp): Promise<{
  app: PrivacyApp;
  title: string;
  effectiveDate: string;
  bodyHtml: string;
  source: 'custom' | 'default';
  updatedAt: Date | null;
}> {
  // Tolerate the table not existing yet (migration not applied) — fall back to default.
  let row: PolicyRow | undefined;
  try {
    row = await db.query.appPrivacyPolicies.findFirst({
      where: eq(appPrivacyPolicies.app, app),
    });
  } catch {
    row = undefined;
  }
  if (row) {
    return {
      app,
      title: row.title,
      effectiveDate: row.effectiveDate,
      bodyHtml: row.bodyHtml,
      source: 'custom',
      updatedAt: row.updatedAt,
    };
  }
  const def = defaultPolicy(app);
  return {
    app,
    title: def.title,
    effectiveDate: def.effectiveDate,
    bodyHtml: defaultPolicyHtml(app),
    source: 'default',
    updatedAt: null,
  };
}

/** List all apps' policies (metadata only — no body) for the CMS index. */
export async function listPolicies() {
  const items = await Promise.all(
    PRIVACY_APPS.map(async (app) => {
      const p = await resolvePolicy(app);
      return {
        app,
        label: PRIVACY_APP_LABELS[app],
        title: p.title,
        effectiveDate: p.effectiveDate,
        source: p.source,
        updatedAt: p.updatedAt,
        publicPath: `/privacy/${app}`,
      };
    }),
  );
  return ok({ items });
}

/** Full policy for one app (with body) for the CMS editor. */
export async function getPolicy(input: { app: PrivacyApp }) {
  const p = await resolvePolicy(input.app);
  return ok({ ...p, label: PRIVACY_APP_LABELS[input.app], publicPath: `/privacy/${input.app}` });
}

/** Create or replace the policy override for one app. */
export async function updatePolicy(input: {
  auth: Auth;
  app: PrivacyApp;
  body: z.infer<typeof UpdatePolicyBody>;
}) {
  const clean = sanitizeRichText(input.body.bodyHtml);
  if (!clean) {
    throw AppError.validation('Policy body is empty after sanitization.');
  }
  const now = new Date();
  await db
    .insert(appPrivacyPolicies)
    .values({
      id: newId(IdPrefix.LegalPage),
      app: input.app,
      title: input.body.title,
      bodyHtml: clean,
      effectiveDate: input.body.effectiveDate,
      updatedByAdminId: input.auth.sub,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: appPrivacyPolicies.app,
      set: {
        title: input.body.title,
        bodyHtml: clean,
        effectiveDate: input.body.effectiveDate,
        updatedByAdminId: input.auth.sub,
        updatedAt: now,
      },
    });
  return getPolicy({ app: input.app });
}
