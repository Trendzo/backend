/**
 * §22 banners — admin-managed announcements + per-store/admin scoped messages.
 * Auto-derived banners (KYC overdue, store suspended, enforcement, holding expiry)
 * are computed at fetch time and merged with the stored rows.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  bannerDismissals,
  banners,
  consumers,
  kycReverifications,
  policyEnforcementActions,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';

export type BannerScope = 'all_retailers' | 'store' | 'all_admins';
export type BannerSeverity = 'info' | 'warning' | 'critical';

export interface BannerRow {
  id: string;
  source: 'admin' | 'derived';
  scope: BannerScope;
  storeId: string | null;
  severity: BannerSeverity;
  title: string;
  body: string | null;
  deepLink: string | null;
  dismissible: boolean;
  activeFrom: string;
  activeUntil: string | null;
  createdAt: string;
}

export interface CreateBannerInput {
  scope: BannerScope;
  storeId?: string | undefined;
  severity?: BannerSeverity | undefined;
  title: string;
  body?: string | undefined;
  deepLink?: string | undefined;
  dismissible?: boolean | undefined;
  activeUntil?: Date | undefined;
  createdByAdminId: string;
}

export async function createBanner(input: CreateBannerInput): Promise<string> {
  if (input.scope === 'store' && !input.storeId) {
    throw new Error("storeId required when scope = 'store'");
  }
  const id = newId(IdPrefix.Banner);
  await db.insert(banners).values({
    id,
    scope: input.scope,
    storeId: input.storeId ?? null,
    severity: input.severity ?? 'info',
    title: input.title,
    body: input.body ?? null,
    deepLink: input.deepLink ?? null,
    dismissible: input.dismissible === false ? 'false' : 'true',
    activeUntil: input.activeUntil ?? null,
    createdByAdminId: input.createdByAdminId,
  });
  return id;
}

export async function revokeBanner(id: string): Promise<boolean> {
  const existing = await db.query.banners.findFirst({ where: eq(banners.id, id) });
  if (!existing || existing.revokedAt) return false;
  await db.update(banners).set({ revokedAt: new Date() }).where(eq(banners.id, id));
  return true;
}

export async function listAdminCreatedBanners(): Promise<BannerRow[]> {
  const rows = await db
    .select()
    .from(banners)
    .where(isNull(banners.revokedAt))
    .orderBy(desc(banners.createdAt));
  return rows.map((r) => ({
    id: r.id,
    source: 'admin' as const,
    scope: r.scope,
    storeId: r.storeId,
    severity: r.severity,
    title: r.title,
    body: r.body,
    deepLink: r.deepLink,
    dismissible: r.dismissible !== 'false',
    activeFrom: r.activeFrom.toISOString(),
    activeUntil: r.activeUntil ? r.activeUntil.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function dismissBanner(input: {
  bannerId: string;
  accountKind: 'retailer' | 'admin' | 'consumer';
  accountId: string;
}): Promise<void> {
  // Insert ignore (unique constraint takes care of duplicates).
  try {
    await db.insert(bannerDismissals).values({
      id: newId(IdPrefix.BannerDismissal),
      bannerId: input.bannerId,
      accountKind: input.accountKind,
      accountId: input.accountId,
    });
  } catch {
    // Already dismissed — no-op.
  }
}

/**
 * Fetch active stored banners visible to a (accountKind, accountId).
 * Filters by scope, active window, and removes already-dismissed rows.
 */
async function fetchStoredBanners(input: {
  accountKind: 'retailer' | 'admin';
  accountId: string;
  storeId?: string | null;
}): Promise<BannerRow[]> {
  const now = new Date();
  const scopeMatch =
    input.accountKind === 'admin'
      ? eq(banners.scope, 'all_admins')
      : or(
          eq(banners.scope, 'all_retailers'),
          and(eq(banners.scope, 'store'), input.storeId ? eq(banners.storeId, input.storeId) : sql`false`)!,
        )!;
  const rows = await db
    .select()
    .from(banners)
    .where(
      and(
        isNull(banners.revokedAt),
        lt(banners.activeFrom, now),
        or(isNull(banners.activeUntil), gt(banners.activeUntil, now))!,
        scopeMatch,
      ),
    )
    .orderBy(desc(banners.createdAt));

  const dismissals = await db
    .select({ bannerId: bannerDismissals.bannerId })
    .from(bannerDismissals)
    .where(
      and(
        eq(bannerDismissals.accountKind, input.accountKind),
        eq(bannerDismissals.accountId, input.accountId),
      ),
    );
  const dismissedIds = new Set(dismissals.map((d) => d.bannerId));

  return rows
    .filter((r) => !dismissedIds.has(r.id))
    .map((r) => ({
      id: r.id,
      source: 'admin' as const,
      scope: r.scope,
      storeId: r.storeId,
      severity: r.severity,
      title: r.title,
      body: r.body,
      deepLink: r.deepLink,
      dismissible: r.dismissible !== 'false',
      activeFrom: r.activeFrom.toISOString(),
      activeUntil: r.activeUntil ? r.activeUntil.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
}

/**
 * Compute derived (non-stored) banners for a retailer: KYC overdue, store suspended/paused,
 * active enforcement step, holding-window expiring soon.
 */
async function fetchDerivedRetailerBanners(storeId: string): Promise<BannerRow[]> {
  const now = new Date();
  const derived: BannerRow[] = [];

  // KYC overdue
  const overdueKyc = await db.query.kycReverifications.findFirst({
    where: and(eq(kycReverifications.storeId, storeId), eq(kycReverifications.status, 'overdue')),
  });
  if (overdueKyc) {
    derived.push({
      id: `derived:kyc:${overdueKyc.id}`,
      source: 'derived',
      scope: 'store',
      storeId,
      severity: 'critical',
      title: 'KYC re-verification overdue',
      body: `Please submit your documents — your store may be paused.`,
      deepLink: `/retailer/compliance`,
      dismissible: false,
      activeFrom: overdueKyc.dueAt.toISOString(),
      activeUntil: null,
      createdAt: overdueKyc.dueAt.toISOString(),
    });
  }

  // Store paused/suspended
  const store = await db.query.retailerStores.findFirst({
    where: eq(retailerStores.id, storeId),
    columns: { id: true, status: true, pauseReason: true },
  });
  if (store) {
    if (store.status === 'suspended' || store.status === 'terminated') {
      derived.push({
        id: `derived:store-status:${storeId}`,
        source: 'derived',
        scope: 'store',
        storeId,
        severity: 'critical',
        title: `Store ${store.status}`,
        body: 'Operations are halted. Contact support to restore.',
        deepLink: `/retailer/profile`,
        dismissible: false,
        activeFrom: now.toISOString(),
        activeUntil: null,
        createdAt: now.toISOString(),
      });
    } else if (store.status === 'paused') {
      derived.push({
        id: `derived:store-status:${storeId}`,
        source: 'derived',
        scope: 'store',
        storeId,
        severity: 'warning',
        title: 'Store paused',
        body: store.pauseReason ?? 'You paused the store. Resume from Settings.',
        deepLink: `/retailer/profile`,
        dismissible: false,
        activeFrom: now.toISOString(),
        activeUntil: null,
        createdAt: now.toISOString(),
      });
    }
  }

  // Active enforcement step
  const enforce = await db
    .select()
    .from(policyEnforcementActions)
    .where(eq(policyEnforcementActions.storeId, storeId))
    .orderBy(desc(policyEnforcementActions.actedAt))
    .limit(1);
  if (enforce.length > 0 && enforce[0]!.step !== 'lifted') {
    const e = enforce[0]!;
    derived.push({
      id: `derived:enforcement:${e.id}`,
      source: 'derived',
      scope: 'store',
      storeId,
      severity: e.step === 'suspension' || e.step === 'termination' ? 'critical' : 'warning',
      title: `Compliance: ${e.step.replaceAll('_', ' ')}`,
      body: e.reason ?? `Breach: ${e.breachKind.replaceAll('_', ' ')}`,
      deepLink: `/retailer/compliance`,
      dismissible: false,
      activeFrom: e.actedAt.toISOString(),
      activeUntil: null,
      createdAt: e.actedAt.toISOString(),
    });
  }

  // (Held-item holding-window banners removed: the retailer keeps the returned
  // goods regardless of outcome, and disposition is set automatically when the
  // dispute is decided — there's nothing for the store to act on.)

  return derived;
}

export async function getBannersForRetailer(retailerId: string): Promise<BannerRow[]> {
  const retailer = await db.query.retailerAccounts.findFirst({
    where: eq(retailerAccounts.id, retailerId),
    columns: { storeId: true },
  });
  const storeId = retailer?.storeId ?? null;
  const stored = await fetchStoredBanners({
    accountKind: 'retailer',
    accountId: retailerId,
    storeId,
  });
  const derived = storeId ? await fetchDerivedRetailerBanners(storeId) : [];
  return [...derived, ...stored];
}

export async function getBannersForAdmin(adminId: string): Promise<BannerRow[]> {
  return fetchStoredBanners({ accountKind: 'admin', accountId: adminId });
}

export async function getBannersForConsumer(consumerId: string): Promise<BannerRow[]> {
  // Consumers see no derived banners today; only admin-pushed announcements scoped consumer-side
  // (no scope yet — return empty).
  void inArray; // silence lint until used
  void consumers; // ditto
  void consumerId;
  return [];
}
