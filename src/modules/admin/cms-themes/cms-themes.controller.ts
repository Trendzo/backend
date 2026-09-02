/**
 * Admin controller for festival themes.
 *
 * Same architecture as the Home CMS controller next door: `cms_themes` rows ARE the draft,
 * every write lands immediately and is invisible to phones; Publish freezes every enabled
 * row into an immutable `cms_theme_publications` snapshot; Restore copies a snapshot back
 * over the draft (and only the draft); Disable-now is the 3AM kill switch — one transaction
 * that flips the draft off AND ships a new publication with that slug subtracted from the
 * last published payload. Subtraction, not re-render, on purpose: re-rendering the draft
 * would leak other themes' unpublished edits and could fail validation on an unrelated
 * broken draft, neither of which is acceptable at 3AM.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { cmsThemePublications, cmsThemes } from '@/db/schema/index.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { recordAudit } from '@/shared/audit.js';
import {
  invalidateThemePublication,
  latestThemePublication,
} from '@/shared/cms/theme-published.js';
import {
  asThemeSnapshot,
  buildThemeResponse,
  renderThemeSnapshot,
  resolveTheme,
  type CmsThemeRow,
} from '@/shared/cms/theme-render.js';
import type { SnapshotTheme, ThemeSnapshot } from '@/shared/cms/theme-schema.js';
import {
  assertPublishableThemes,
  collectThemeFailures,
} from '@/shared/cms/theme-validate.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId, IdPrefix } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import type { CreateThemeInput, PatchThemeInput, ThemePreviewInput } from './cms-themes.validators.js';

type Actor = Pick<AccessTokenPayload, 'kind' | 'sub'>;

/** Serializes publish and disable-now so max(version)+1 cannot race. Tx-scoped. */
const PUBLICATION_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('cms_theme_publications'))`;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Draft-save validation: shape + coherence + asset hosts, but NOT contrast (publish gates that). */
function assertSaveable(row: CmsThemeRow): void {
  const failures: Parameters<typeof collectThemeFailures>[1] = [];
  collectThemeFailures(row, failures, { contrast: false });
  if (failures.length > 0) {
    throw AppError.validation('Theme failed validation', { failures });
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function listThemes() {
  const rows = await db.query.cmsThemes.findMany({ orderBy: [asc(cmsThemes.slug)] });
  const { snapshot } = await latestThemePublication();
  // Identity is the id (slug is editable); fall back to slug for pre-id snapshots.
  const publishedIds = new Set(snapshot.themes.map((t) => t.id).filter(Boolean));
  const publishedSlugs = new Set(snapshot.themes.map((t) => t.slug));
  return ok(
    rows.map((r) => ({
      ...r,
      /** Whether this theme is in the LIVE snapshot — drafts edited since may still differ. */
      inLatestPublication: publishedIds.has(r.id) || publishedSlugs.has(r.slug),
    })),
  );
}

export async function getTheme(id: string) {
  const row = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, id) });
  if (!row) throw AppError.notFound('Theme not found');
  return ok(row);
}

export async function listThemePublications() {
  const rows = await db.query.cmsThemePublications.findMany({
    orderBy: [sql`${cmsThemePublications.version} desc`],
    limit: 50,
    columns: { id: true, version: true, note: true, publishedAt: true, publishedByAdminId: true },
  });
  return ok(rows);
}

/**
 * Run the PRODUCTION resolver against the draft or the live snapshot, at any instant, for
 * any caller context. `winner` carries name/priority/targeting for the simulator card;
 * `response` is byte-shaped like what a phone would receive.
 */
export async function preview(input: { query: ThemePreviewInput }) {
  const { source, at, city, platform, appVersion } = input.query;

  let version: number | null;
  let snapshot: ThemeSnapshot;
  if (source === 'published') {
    ({ version, snapshot } = await latestThemePublication());
  } else {
    const rows = await db.query.cmsThemes.findMany({ orderBy: [asc(cmsThemes.slug)] });
    version = null;
    snapshot = renderThemeSnapshot(rows);
  }

  const winner = resolveTheme(snapshot, {
    now: at ?? new Date(),
    city: city ?? null,
    platform: platform ?? null,
    appVersion: appVersion ?? null,
  });

  return ok({ source, version, winner, response: buildThemeResponse(version, winner) });
}

// ─── Draft writes ─────────────────────────────────────────────────────────────

export async function createTheme(input: { body: CreateThemeInput; actor: Actor }) {
  const b = input.body;
  const values = {
    id: newId(IdPrefix.CmsTheme),
    slug: b.slug,
    name: b.name,
    description: b.description ?? null,
    isEnabled: b.isEnabled,
    priority: b.priority,
    startsAt: b.startsAt ?? null,
    endsAt: b.endsAt ?? null,
    cities: b.cities ?? null,
    platforms: b.platforms ?? null,
    minAppVersion: b.minAppVersion ?? null,
    tokens: b.tokens,
    chrome: b.chrome,
    decor: b.decor,
    copy: b.copy,
    createdByAdminId: input.actor.sub ?? null,
    updatedByAdminId: input.actor.sub ?? null,
  };

  // Validate what WOULD be stored before touching the db (asserts coherence + asset hosts).
  assertSaveable({ ...values, createdAt: new Date(), updatedAt: new Date() } as CmsThemeRow);

  try {
    const [row] = await db.insert(cmsThemes).values(values).returning();
    await recordAudit({
      actor: input.actor,
      action: 'cms.theme.create',
      resourceKind: 'cms_theme',
      resourceId: row?.id ?? null,
      after: { slug: b.slug, name: b.name },
    });
    return ok(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(ErrorCode.InvalidState, `Slug "${b.slug}" is already in use`);
    }
    throw err;
  }
}

export async function patchTheme(input: { id: string; body: PatchThemeInput; actor: Actor }) {
  const existing = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, input.id) });
  if (!existing) throw AppError.notFound('Theme not found');

  const b = input.body;
  // Validate the POST-patch merged state, not the patch — a patch that leaves the row
  // incoherent is the thing to reject (same reasoning as the CMS item path).
  const merged: CmsThemeRow = {
    ...existing,
    ...compact({
      slug: b.slug,
      name: b.name,
      isEnabled: b.isEnabled,
      priority: b.priority,
      tokens: b.tokens,
      chrome: b.chrome,
      decor: b.decor,
      copy: b.copy,
    }),
    ...(b.description !== undefined ? { description: b.description } : {}),
    ...(b.startsAt !== undefined ? { startsAt: b.startsAt } : {}),
    ...(b.endsAt !== undefined ? { endsAt: b.endsAt } : {}),
    ...(b.cities !== undefined ? { cities: b.cities } : {}),
    ...(b.platforms !== undefined ? { platforms: b.platforms } : {}),
    ...(b.minAppVersion !== undefined ? { minAppVersion: b.minAppVersion } : {}),
  };
  assertSaveable(merged);

  try {
    const [row] = await db
      .update(cmsThemes)
      .set({
        slug: merged.slug,
        name: merged.name,
        description: merged.description,
        isEnabled: merged.isEnabled,
        priority: merged.priority,
        startsAt: merged.startsAt,
        endsAt: merged.endsAt,
        cities: merged.cities,
        platforms: merged.platforms,
        minAppVersion: merged.minAppVersion,
        tokens: merged.tokens,
        chrome: merged.chrome,
        decor: merged.decor,
        copy: merged.copy,
        updatedAt: new Date(),
        updatedByAdminId: input.actor.sub ?? null,
      })
      .where(eq(cmsThemes.id, input.id))
      .returning();

    await recordAudit({
      actor: input.actor,
      action: 'cms.theme.update',
      resourceKind: 'cms_theme',
      resourceId: input.id,
      before: { slug: existing.slug, isEnabled: existing.isEnabled, priority: existing.priority },
      after: { slug: merged.slug, isEnabled: merged.isEnabled, priority: merged.priority },
    });
    return ok(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(ErrorCode.InvalidState, `Slug "${merged.slug}" is already in use`);
    }
    throw err;
  }
}

/** Draft-only: the live snapshot keeps serving this theme until the next publish. */
export async function deleteTheme(input: { id: string; actor: Actor }) {
  const existing = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, input.id) });
  if (!existing) throw AppError.notFound('Theme not found');

  await db.delete(cmsThemes).where(eq(cmsThemes.id, input.id));
  await recordAudit({
    actor: input.actor,
    action: 'cms.theme.delete',
    resourceKind: 'cms_theme',
    resourceId: input.id,
    before: { slug: existing.slug, name: existing.name },
  });
  return ok({ deleted: true });
}

/** Copy is created DISABLED — a clone going straight into the next publish is never intended. */
export async function cloneTheme(input: { id: string; body: { slug: string; name: string }; actor: Actor }) {
  const source = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, input.id) });
  if (!source) throw AppError.notFound('Theme not found');

  try {
    const [row] = await db
      .insert(cmsThemes)
      .values({
        id: newId(IdPrefix.CmsTheme),
        slug: input.body.slug,
        name: input.body.name,
        description: source.description,
        isEnabled: false,
        priority: source.priority,
        startsAt: source.startsAt,
        endsAt: source.endsAt,
        cities: source.cities,
        platforms: source.platforms,
        minAppVersion: source.minAppVersion,
        tokens: source.tokens,
        chrome: source.chrome,
        decor: source.decor,
        copy: source.copy,
        createdByAdminId: input.actor.sub ?? null,
        updatedByAdminId: input.actor.sub ?? null,
      })
      .returning();

    await recordAudit({
      actor: input.actor,
      action: 'cms.theme.clone',
      resourceKind: 'cms_theme',
      resourceId: row?.id ?? null,
      before: { sourceId: input.id, sourceSlug: source.slug },
      after: { slug: input.body.slug },
    });
    return ok(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict(ErrorCode.InvalidState, `Slug "${input.body.slug}" is already in use`);
    }
    throw err;
  }
}

// ─── Publish lifecycle ────────────────────────────────────────────────────────

export async function publishThemes(input: { note?: string | undefined; actor: Actor }) {
  // Everything — the draft READ, validation and the render — happens inside the
  // lock. Reading drafts outside it leaves a window where a concurrent
  // disable-now commits its kill publication first and this publish then ships a
  // snapshot built from the pre-kill drafts, silently resurrecting the theme it
  // just killed. The lock is what makes "what I validated is what I publish" true.
  const { created, snapshot } = await db.transaction(async (tx) => {
    await tx.execute(PUBLICATION_LOCK);

    const rows = await tx.query.cmsThemes.findMany({ orderBy: [asc(cmsThemes.slug)] });
    const enabled = rows.filter((r) => r.isEnabled);
    // The full gate — every failure across every enabled theme in one 422. Throwing
    // here rolls the transaction back and releases the lock.
    assertPublishableThemes(enabled);
    const rendered = renderThemeSnapshot(enabled);

    const maxRows = await tx
      .select({ max: sql<number | null>`max(${cmsThemePublications.version})` })
      .from(cmsThemePublications);
    const nextVersion = (maxRows[0]?.max ?? 0) + 1;

    const [row] = await tx
      .insert(cmsThemePublications)
      .values({
        id: newId(IdPrefix.CmsThemePublication),
        version: nextVersion,
        payload: rendered,
        ...compact({ note: input.note }),
        publishedByAdminId: input.actor.sub ?? null,
      })
      .returning();
    return { created: row, snapshot: rendered };
  });

  invalidateThemePublication();
  await recordAudit({
    actor: input.actor,
    action: 'cms.theme.publish',
    resourceKind: 'cms_theme_publication',
    resourceId: created?.id ?? null,
    after: { version: created?.version ?? null, themeCount: snapshot.themes.length, note: input.note ?? null },
  });

  return ok({
    id: created?.id ?? null,
    version: created?.version ?? null,
    publishedAt: created?.publishedAt ?? null,
    themeCount: snapshot.themes.length,
  });
}

/**
 * Copy a published snapshot back over the DRAFT. Nothing goes live: publish afterwards to
 * make it so. Drafts absent from the snapshot are disabled (never deleted), so a follow-up
 * publish reproduces version N exactly.
 */
export async function restoreThemePublication(input: { version: number; actor: Actor }) {
  const pub = await db.query.cmsThemePublications.findFirst({
    where: eq(cmsThemePublications.version, input.version),
  });
  if (!pub) throw AppError.notFound(`No theme publication with version ${input.version}`);

  const snapshot = asThemeSnapshot(pub.payload);

  await db.transaction(async (tx) => {
    const drafts = await tx.query.cmsThemes.findMany();
    const draftsBySlug = new Map(drafts.map((d) => [d.slug, d]));
    const snapshotSlugs = new Set(snapshot.themes.map((t) => t.slug));

    for (const t of snapshot.themes) {
      const fields = {
        name: t.name,
        priority: t.priority,
        isEnabled: true,
        startsAt: t.startsAt ? new Date(t.startsAt) : null,
        endsAt: t.endsAt ? new Date(t.endsAt) : null,
        cities: t.cities,
        platforms: t.platforms,
        minAppVersion: t.minAppVersion,
        tokens: t.tokens,
        chrome: t.chrome,
        decor: t.decor,
        copy: t.copy,
        // The snapshot's own stamp, not now(): updatedAt is the resolver's recency
        // tiebreak, so stamping restore-time would make a follow-up publish pick a
        // different winner than the version being restored actually served.
        updatedAt: new Date(t.updatedAt),
        updatedByAdminId: input.actor.sub ?? null,
      };
      const existing = draftsBySlug.get(t.slug);
      if (existing) {
        await tx.update(cmsThemes).set(fields).where(eq(cmsThemes.id, existing.id));
      } else {
        await tx.insert(cmsThemes).values({
          id: newId(IdPrefix.CmsTheme),
          slug: t.slug,
          createdByAdminId: input.actor.sub ?? null,
          ...fields,
        });
      }
    }

    for (const d of drafts) {
      if (!snapshotSlugs.has(d.slug) && d.isEnabled) {
        await tx
          .update(cmsThemes)
          .set({ isEnabled: false, updatedAt: new Date(), updatedByAdminId: input.actor.sub ?? null })
          .where(eq(cmsThemes.id, d.id));
      }
    }
  });

  invalidateThemePublication();
  await recordAudit({
    actor: input.actor,
    action: 'cms.theme.restore',
    resourceKind: 'cms_theme_publication',
    resourceId: pub.id,
    after: { restoredVersion: input.version },
  });

  return ok({ restoredVersion: input.version, published: false });
}

/**
 * The kill switch: flip the draft off AND ship a publication with this slug removed from
 * the LAST PUBLISHED payload — no draft re-render, no validation, nothing that can fail on
 * an unrelated broken draft. Phones see the change on their next refresh (<=60s for
 * sibling-process cache TTL + the client's refresh cadence).
 */
export async function disableNow(input: { id: string; actor: Actor }) {
  const theme = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, input.id) });
  if (!theme) throw AppError.notFound('Theme not found');

  const result = await db.transaction(async (tx) => {
    await tx.execute(PUBLICATION_LOCK);

    await tx
      .update(cmsThemes)
      .set({ isEnabled: false, updatedAt: new Date(), updatedByAdminId: input.actor.sub ?? null })
      .where(eq(cmsThemes.id, input.id));

    const latest = await tx.query.cmsThemePublications.findFirst({
      orderBy: [sql`${cmsThemePublications.version} desc`],
    });
    if (!latest) return { version: null as number | null }; // never published: flag flip is enough

    const snapshot = asThemeSnapshot(latest.payload);
    // Subtract by ID: slug is editable, so a theme renamed since it was published
    // would survive a slug-based filter and the kill switch would silently no-op.
    // (Older snapshots predate the id field — fall back to the slug for those.)
    const remaining: SnapshotTheme[] = snapshot.themes.filter((t) =>
      t.id ? t.id !== theme.id : t.slug !== theme.slug,
    );
    // Publish even when the slug was absent — the version bump is what busts client caches.
    const nextVersion = latest.version + 1;
    await tx.insert(cmsThemePublications).values({
      id: newId(IdPrefix.CmsThemePublication),
      version: nextVersion,
      payload: { schemaVersion: snapshot.schemaVersion, themes: remaining } satisfies ThemeSnapshot,
      note: `disable-now: ${theme.slug}`,
      publishedByAdminId: input.actor.sub ?? null,
    });
    return { version: nextVersion as number | null };
  });

  invalidateThemePublication();
  await recordAudit({
    actor: input.actor,
    action: 'cms.theme.disable_now',
    resourceKind: 'cms_theme',
    resourceId: input.id,
    before: { slug: theme.slug, isEnabled: theme.isEnabled },
    after: { isEnabled: false, publishedVersion: result.version },
  });

  return ok({ slug: theme.slug, disabled: true, version: result.version });
}
