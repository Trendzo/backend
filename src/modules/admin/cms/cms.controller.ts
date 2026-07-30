/**
 * Admin CMS controller.
 *
 * `cms_sections` + `cms_items` are the working draft: every write here lands immediately and is
 * invisible to customers. Only `publish` renders them into a `cms_publications` snapshot, and
 * only that snapshot is served publicly. So an editor can leave a half-finished campaign
 * overnight without anyone seeing it, and Publish is the single, auditable moment where the
 * home page changes.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { cmsAssets, cmsItems, cmsPublications, cmsSections } from '@/db/schema/cms.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';
import { recordAudit } from '@/shared/audit.js';
import { invalidateCmsPublication, latestPublication } from '@/shared/cms/published.js';
import { asSnapshot, filterPayload, renderPayload } from '@/shared/cms/render.js';
import { getSectionSpec, railsOf, schemaPayload } from '@/shared/cms/schema.js';
import {
  validateItemContent,
  validateLink,
  validateMedia,
  validateSectionConfig,
} from '@/shared/cms/validate.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { ok } from '@/shared/http/envelope.js';
import { newId, IdPrefix } from '@/shared/ids.js';
import { compact } from '@/shared/object.js';
import type {
  CreateItemInput,
  PatchItemInput,
  PatchSectionInput,
} from './cms.validators.js';

type Actor = Pick<AccessTokenPayload, 'kind' | 'sub'>;

// ─── Reads ────────────────────────────────────────────────────────────────────

/** The section catalogue. Admin builds every form from this, so it ships whole. */
export function getSchema() {
  return ok(schemaPayload());
}

export async function listSections() {
  const rows = await db.query.cmsSections.findMany({
    orderBy: [asc(cmsSections.sortOrder), asc(cmsSections.key)],
  });
  const counts = await db
    .select({ sectionId: cmsItems.sectionId, n: sql<number>`count(*)::int` })
    .from(cmsItems)
    .groupBy(cmsItems.sectionId);
  const byId = new Map(counts.map((c) => [c.sectionId, c.n]));

  return ok(
    rows.map((s) => ({
      ...s,
      itemCount: byId.get(s.id) ?? 0,
      // A section whose key has been retired from the catalogue still has rows; flag it so
      // admin can see why its form renders empty rather than assuming the page is broken.
      isKnown: getSectionSpec(s.key) !== null,
    })),
  );
}

async function loadSectionOrThrow(key: string) {
  const section = await db.query.cmsSections.findFirst({ where: eq(cmsSections.key, key) });
  if (!section) throw AppError.notFound(`No CMS section with key "${key}"`);
  return section;
}

export async function getSection(key: string) {
  const section = await loadSectionOrThrow(key);
  const items = await db.query.cmsItems.findMany({
    where: eq(cmsItems.sectionId, section.id),
    orderBy: [asc(cmsItems.sortOrder), asc(cmsItems.key)],
  });
  return ok({ section, items, spec: getSectionSpec(section.key) });
}

export async function listAssets(input: { query: { category?: string | undefined } }) {
  const rows = await db.query.cmsAssets.findMany({
    orderBy: [asc(cmsAssets.category), asc(cmsAssets.key)],
    ...(input.query.category ? { where: eq(cmsAssets.category, input.query.category) } : {}),
  });
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  return ok({ assets: rows, categories });
}

// ─── Section writes ───────────────────────────────────────────────────────────

export async function patchSection(input: {
  key: string;
  body: PatchSectionInput;
  actor: Actor;
}) {
  const section = await loadSectionOrThrow(input.key);
  const spec = getSectionSpec(section.key);

  if (input.body.config !== undefined) {
    if (!spec) {
      throw AppError.validation(
        `Section "${section.key}" is not in the catalogue, so its config cannot be validated`,
      );
    }
    validateSectionConfig(spec, input.body.config);
  }

  const [updated] = await db
    .update(cmsSections)
    .set({
      ...compact(input.body),
      updatedAt: new Date(),
      updatedByAdminId: input.actor.sub ?? null,
    })
    .where(eq(cmsSections.id, section.id))
    .returning();

  await recordAudit({
    actor: input.actor,
    action: 'cms.section.update',
    resourceKind: 'cms_section',
    resourceId: section.id,
    before: section,
    after: updated ?? null,
  });

  return ok(updated);
}

// ─── Item writes ──────────────────────────────────────────────────────────────

/**
 * Everything an item write must satisfy beyond its zod shape: the section has to be in the
 * catalogue, the copy has to match its declared fields, the media has to be the kind the
 * widget renders, and the link has to name a real app route.
 */
function assertItemValid(
  sectionKey: string,
  candidate: {
    assetKey?: string | null | undefined;
    imageUrl?: string | null | undefined;
    videoUrl?: string | null | undefined;
    link?: unknown;
    content: Record<string, unknown>;
  },
) {
  const spec = getSectionSpec(sectionKey);
  if (!spec) {
    throw AppError.validation(`Section "${sectionKey}" is not in the CMS catalogue`);
  }
  validateItemContent(spec, candidate.content);
  validateMedia(spec, candidate);
  if (spec.link) validateLink(candidate.link);
  else if (candidate.link) {
    throw AppError.validation(`"${spec.label}" items are not tappable`);
  }
  return spec;
}

export async function createItem(input: {
  sectionKey: string;
  body: CreateItemInput;
  actor: Actor;
}) {
  const section = await loadSectionOrThrow(input.sectionKey);
  const spec = assertItemValid(section.key, input.body);

  // Caps are PER RAIL. A gender-split section keeps HER and HIM items in one row set, and only
  // one rail ever renders, so counting them together would cap the Steals bento at three tiles
  // shared across both genders instead of three each. An item marked `all` renders on both
  // rails and therefore counts against both.
  const existing = await db.query.cmsItems.findMany({
    where: eq(cmsItems.sectionId, section.id),
    columns: { gender: true },
  });
  for (const rail of railsOf(input.body.gender)) {
    const onRail = existing.filter((i) => i.gender === rail || i.gender === 'all').length;
    if (onRail >= spec.maxItems) {
      throw AppError.validation(
        `"${spec.label}" holds at most ${spec.maxItems} item${spec.maxItems === 1 ? '' : 's'}` +
          `${spec.genderSplit ? ` per rail (${rail.toUpperCase()} is full)` : ''}`,
      );
    }
  }

  const values = {
    id: newId(IdPrefix.CmsItem),
    sectionId: section.id,
    key: input.body.key,
    gender: input.body.gender,
    // Append by default. Uses the section-wide count, not the rail count, because sortOrder is
    // a single ordering over the whole section — the rails are interleaved in it.
    sortOrder: input.body.sortOrder ?? existing.length,
    content: input.body.content,
    isEnabled: input.body.isEnabled,
    ...compact({
      assetKey: input.body.assetKey,
      imageUrl: input.body.imageUrl,
      videoUrl: input.body.videoUrl,
      link: input.body.link,
      startsAt: input.body.startsAt,
      endsAt: input.body.endsAt,
      cities: input.body.cities,
    }),
  };

  let created;
  try {
    [created] = await db.insert(cmsItems).values(values).returning();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw AppError.conflict(
        ErrorCode.InvalidState,
        `"${input.body.key}" already exists in this section — item keys must be unique within a section`,
      );
    }
    throw err;
  }

  await recordAudit({
    actor: input.actor,
    action: 'cms.item.create',
    resourceKind: 'cms_item',
    resourceId: created?.id ?? null,
    after: created ?? null,
  });

  return ok(created);
}

export async function patchItem(input: { id: string; body: PatchItemInput; actor: Actor }) {
  const item = await db.query.cmsItems.findFirst({ where: eq(cmsItems.id, input.id) });
  if (!item) throw AppError.notFound('No such CMS item');
  const section = await db.query.cmsSections.findFirst({
    where: eq(cmsSections.id, item.sectionId),
  });
  if (!section) throw AppError.notFound('No such CMS section');

  // Validate the POST-PATCH state, not the patch: clearing `imageUrl` on an item that has no
  // assetKey either would otherwise pass field-by-field and leave a tile with no art.
  const merged = {
    assetKey: input.body.assetKey !== undefined ? input.body.assetKey : item.assetKey,
    imageUrl: input.body.imageUrl !== undefined ? input.body.imageUrl : item.imageUrl,
    videoUrl: input.body.videoUrl !== undefined ? input.body.videoUrl : item.videoUrl,
    link: input.body.link !== undefined ? input.body.link : item.link,
    content: input.body.content !== undefined ? input.body.content : item.content,
  };
  assertItemValid(section.key, merged);

  let updated;
  try {
    [updated] = await db
      .update(cmsItems)
      .set({ ...compact(input.body), updatedAt: new Date() })
      .where(eq(cmsItems.id, item.id))
      .returning();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw AppError.conflict(
        ErrorCode.InvalidState,
        'Another item in this section already uses that key',
      );
    }
    throw err;
  }

  await recordAudit({
    actor: input.actor,
    action: 'cms.item.update',
    resourceKind: 'cms_item',
    resourceId: item.id,
    before: item,
    after: updated ?? null,
  });

  return ok(updated);
}

export async function deleteItem(input: { id: string; actor: Actor }) {
  const item = await db.query.cmsItems.findFirst({ where: eq(cmsItems.id, input.id) });
  if (!item) throw AppError.notFound('No such CMS item');

  await db.delete(cmsItems).where(eq(cmsItems.id, item.id));
  await recordAudit({
    actor: input.actor,
    action: 'cms.item.delete',
    resourceKind: 'cms_item',
    resourceId: item.id,
    before: item,
  });

  return ok({ id: item.id, deleted: true });
}

export async function reorderItems(input: {
  sectionKey: string;
  itemIds: string[];
  actor: Actor;
}) {
  const section = await loadSectionOrThrow(input.sectionKey);
  const existing = await db.query.cmsItems.findMany({
    where: eq(cmsItems.sectionId, section.id),
    columns: { id: true },
  });

  const known = new Set(existing.map((r) => r.id));
  if (input.itemIds.length !== known.size || input.itemIds.some((id) => !known.has(id))) {
    // A partial list would silently leave the omitted items at a stale sortOrder, producing an
    // order nobody chose. Demand the full list instead.
    throw AppError.validation(
      `Reorder must list every item in the section exactly once (${known.size} expected)`,
    );
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of input.itemIds.entries()) {
      await tx
        .update(cmsItems)
        .set({ sortOrder: index, updatedAt: new Date() })
        .where(eq(cmsItems.id, id));
    }
  });

  await recordAudit({
    actor: input.actor,
    action: 'cms.section.reorder',
    resourceKind: 'cms_section',
    resourceId: section.id,
    after: { itemIds: input.itemIds },
  });

  const items = await db.query.cmsItems.findMany({
    where: eq(cmsItems.sectionId, section.id),
    orderBy: [asc(cmsItems.sortOrder)],
  });
  return ok(items);
}

// ─── Preview / publish ────────────────────────────────────────────────────────

async function renderDraft() {
  const [sections, items] = await Promise.all([
    db.query.cmsSections.findMany(),
    db.query.cmsItems.findMany(),
  ]);
  return renderPayload(sections, items);
}

/**
 * What a device would receive. `draft` answers "what will publishing do?"; `published` answers
 * "what are customers seeing right now?" — the two differ exactly by the unpublished edits,
 * which is the thing an editor needs to see before pressing the button.
 */
export async function preview(input: {
  query: {
    gender?: 'her' | 'him' | undefined;
    city?: string | undefined;
    source: 'draft' | 'published';
  };
}) {
  const now = new Date();
  if (input.query.source === 'published') {
    const { version, snapshot } = await latestPublication();
    return ok({
      source: 'published' as const,
      version,
      ...filterPayload(snapshot, {
        ...compact({ gender: input.query.gender, city: input.query.city }),
        now,
      }),
    });
  }

  const snapshot = await renderDraft();
  return ok({
    source: 'draft' as const,
    version: null,
    ...filterPayload(snapshot, {
      ...compact({ gender: input.query.gender, city: input.query.city }),
      now,
    }),
  });
}

export async function publish(input: { note?: string | undefined; actor: Actor }) {
  const snapshot = await renderDraft();

  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ max: sql<number | null>`max(${cmsPublications.version})` })
      .from(cmsPublications);
    const nextVersion = (rows[0]?.max ?? 0) + 1;

    const [row] = await tx
      .insert(cmsPublications)
      .values({
        id: newId(IdPrefix.CmsPublication),
        version: nextVersion,
        payload: snapshot,
        ...compact({ note: input.note }),
        publishedByAdminId: input.actor.sub ?? null,
      })
      .returning();
    return row;
  });

  invalidateCmsPublication();
  await recordAudit({
    actor: input.actor,
    action: 'cms.publish',
    resourceKind: 'cms_publication',
    resourceId: created?.id ?? null,
    after: { version: created?.version ?? null, note: input.note ?? null },
  });

  return ok({
    id: created?.id ?? null,
    version: created?.version ?? null,
    publishedAt: created?.publishedAt ?? null,
    sectionCount: snapshot.sections.length,
    itemCount: snapshot.sections.reduce((n, s) => n + s.items.length, 0),
  });
}

export async function listPublications() {
  const rows = await db
    .select({
      id: cmsPublications.id,
      version: cmsPublications.version,
      note: cmsPublications.note,
      publishedAt: cmsPublications.publishedAt,
      publishedByAdminId: cmsPublications.publishedByAdminId,
    })
    .from(cmsPublications)
    .orderBy(sql`${cmsPublications.version} desc`)
    .limit(50);
  return ok(rows);
}

/**
 * Copy an old snapshot back over the draft tables. Publications themselves are never deleted —
 * restoring is followed by a normal Publish, so the history reads as a forward-only log rather
 * than as something that silently rewrote itself.
 */
export async function restorePublication(input: { version: number; actor: Actor }) {
  const publication = await db.query.cmsPublications.findFirst({
    where: eq(cmsPublications.version, input.version),
  });
  if (!publication) throw AppError.notFound(`No CMS publication with version ${input.version}`);

  const snapshot = asSnapshot(publication.payload);

  await db.transaction(async (tx) => {
    for (const section of snapshot.sections) {
      const existing = await tx.query.cmsSections.findFirst({
        where: eq(cmsSections.key, section.key),
      });
      // A section key that no longer exists in this build is skipped rather than recreated:
      // resurrecting a retired slot would put content back on a screen that cannot render it.
      if (!existing) continue;

      await tx
        .update(cmsSections)
        .set({
          title: section.title,
          subtitle: section.subtitle,
          kicker: section.kicker,
          ctaLabel: section.ctaLabel,
          config: section.config,
          isEnabled: section.isEnabled,
          sortOrder: section.sortOrder,
          updatedAt: new Date(),
          updatedByAdminId: input.actor.sub ?? null,
        })
        .where(eq(cmsSections.id, existing.id));

      await tx.delete(cmsItems).where(eq(cmsItems.sectionId, existing.id));
      if (section.items.length === 0) continue;

      await tx.insert(cmsItems).values(
        section.items.map((i) => ({
          id: newId(IdPrefix.CmsItem),
          sectionId: existing.id,
          key: i.key,
          gender: i.gender,
          sortOrder: i.sortOrder,
          assetKey: i.assetKey,
          imageUrl: i.imageUrl,
          videoUrl: i.videoUrl,
          link: i.link,
          content: i.content,
          isEnabled: i.isEnabled,
          startsAt: i.startsAt ? new Date(i.startsAt) : null,
          endsAt: i.endsAt ? new Date(i.endsAt) : null,
          cities: i.cities,
        })),
      );
    }
  });

  invalidateCmsPublication();
  await recordAudit({
    actor: input.actor,
    action: 'cms.restore',
    resourceKind: 'cms_publication',
    resourceId: publication.id,
    after: { version: publication.version },
  });

  return ok({
    restoredVersion: publication.version,
    // Restoring changes the DRAFT only. Nothing customers see moves until Publish runs.
    published: false,
  });
}
