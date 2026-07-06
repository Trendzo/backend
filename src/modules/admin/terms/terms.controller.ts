import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '@/db/client.js';
import {
  retailerAccounts,
  retailerStores,
  retailerTerms,
  retailerTermsAcceptances,
} from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { currentTerms } from '@/shared/terms.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import type { PublishTermsBody, VersionParam } from './terms.validators.js';

type Auth = AccessTokenPayload;

/** Current terms + full version history with accept/decline counts. */
export async function listTerms() {
  const ct = await currentTerms(db);
  const versions = await db.query.retailerTerms.findMany({
    orderBy: [desc(retailerTerms.createdAt)],
  });
  const counts = await db
    .select({
      version: retailerTermsAcceptances.termsVersion,
      decision: retailerTermsAcceptances.decision,
      n: sql<number>`count(*)::int`,
    })
    .from(retailerTermsAcceptances)
    .groupBy(retailerTermsAcceptances.termsVersion, retailerTermsAcceptances.decision);
  const countFor = (v: string, d: string) =>
    counts.find((c) => c.version === v && c.decision === d)?.n ?? 0;

  return ok({
    current: { version: ct.version, label: ct.label, shortText: ct.shortText },
    versions: versions.map((v) => ({
      id: v.id,
      label: v.label,
      shortText: v.shortText,
      createdAt: v.createdAt.toISOString(),
      createdByAdminId: v.createdByAdminId,
      isCurrent: v.id === ct.version,
      acceptedCount: countFor(v.id, 'accepted'),
      declinedCount: countFor(v.id, 'declined'),
    })),
  });
}

/** Publish a new terms version — becomes current, re-flagging every retailer to re-accept. */
export async function publishTerms(input: { auth: Auth; body: z.infer<typeof PublishTermsBody> }) {
  const countRows = await db.select({ n: sql<number>`count(*)::int` }).from(retailerTerms);
  const label = input.body.label?.trim() || `v${(countRows[0]?.n ?? 0) + 1}`;
  const [row] = await db
    .insert(retailerTerms)
    .values({
      id: newId(IdPrefix.TermsVersion),
      label,
      shortText: input.body.shortText,
      createdByAdminId: input.auth.sub,
    })
    .returning();
  return ok({ id: row!.id, label: row!.label, createdAt: row!.createdAt.toISOString() });
}

/** Audit — who accepted or declined a given version. */
export async function versionDecisions(input: { params: z.infer<typeof VersionParam> }) {
  const rows = await db
    .select({
      id: retailerTermsAcceptances.id,
      storeId: retailerTermsAcceptances.storeId,
      accountId: retailerTermsAcceptances.acceptedByAccountId,
      accountName: retailerAccounts.legalName,
      storeName: retailerStores.legalName,
      decision: retailerTermsAcceptances.decision,
      at: retailerTermsAcceptances.acceptedAt,
      ip: retailerTermsAcceptances.ipAddress,
    })
    .from(retailerTermsAcceptances)
    .leftJoin(retailerAccounts, eq(retailerAccounts.id, retailerTermsAcceptances.acceptedByAccountId))
    .leftJoin(retailerStores, eq(retailerStores.id, retailerTermsAcceptances.storeId))
    .where(eq(retailerTermsAcceptances.termsVersion, input.params.version))
    .orderBy(desc(retailerTermsAcceptances.acceptedAt));
  return ok({ decisions: rows.map((r) => ({ ...r, at: r.at.toISOString() })) });
}
