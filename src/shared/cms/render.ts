/**
 * Turning CMS draft rows into the payload the app consumes, and narrowing that payload to one
 * request.
 *
 * Two separate steps on purpose:
 *
 *   renderPayload — draft rows → a complete snapshot holding EVERY gender, EVERY city and
 *                   EVERY publish window. This is what gets frozen into `cms_publications`.
 *   filterPayload — snapshot → what one device should see right now.
 *
 * Keeping the filter out of the snapshot is what lets a campaign be scheduled: publish once
 * today, and the item appears by itself when its `startsAt` passes. If filtering happened at
 * publish time, every scheduled change would need a human to press Publish again at the right
 * moment, which is exactly the failure mode a CMS is supposed to remove.
 */
import type { InferSelectModel } from 'drizzle-orm';
import type { cmsItems, cmsSections } from '@/db/schema/cms.js';
import type { CmsLink } from '@/db/schema/cms.js';

type SectionRow = InferSelectModel<typeof cmsSections>;
type ItemRow = InferSelectModel<typeof cmsItems>;

export type CmsAudience = 'her' | 'him' | 'all';

/** An item as stored in a snapshot — targeting metadata included. */
export type SnapshotItem = {
  key: string;
  gender: CmsAudience;
  sortOrder: number;
  assetKey: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  link: CmsLink | null;
  content: Record<string, unknown>;
  isEnabled: boolean;
  /** ISO strings — a snapshot is JSON, and Date does not survive the round trip. */
  startsAt: string | null;
  endsAt: string | null;
  cities: string[] | null;
};

export type SnapshotSection = {
  key: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  kicker: string | null;
  ctaLabel: string | null;
  config: Record<string, unknown>;
  isEnabled: boolean;
  sortOrder: number;
  items: SnapshotItem[];
};

export type CmsSnapshot = {
  /** Bumped when the payload SHAPE changes, so an older app can refuse a newer snapshot. */
  schemaVersion: 1;
  sections: SnapshotSection[];
};

/** What the app actually receives — targeting metadata stripped, since it has been applied. */
export type PublicItem = {
  key: string;
  assetKey: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  link: CmsLink | null;
  content: Record<string, unknown>;
};

export type PublicSection = {
  key: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  kicker: string | null;
  ctaLabel: string | null;
  config: Record<string, unknown>;
  items: PublicItem[];
};

export const CMS_SCHEMA_VERSION = 1 as const;

/** Draft rows → a full snapshot. Items are grouped by section and ordered by `sortOrder`. */
export function renderPayload(sections: SectionRow[], items: ItemRow[]): CmsSnapshot {
  const bySection = new Map<string, ItemRow[]>();
  for (const item of items) {
    const bucket = bySection.get(item.sectionId);
    if (bucket) bucket.push(item);
    else bySection.set(item.sectionId, [item]);
  }

  const rendered = sections
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
    .map<SnapshotSection>((s) => ({
      key: s.key,
      type: s.type,
      title: s.title,
      subtitle: s.subtitle,
      kicker: s.kicker,
      ctaLabel: s.ctaLabel,
      config: s.config,
      isEnabled: s.isEnabled,
      sortOrder: s.sortOrder,
      items: (bySection.get(s.id) ?? [])
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))
        .map<SnapshotItem>((i) => ({
          key: i.key,
          gender: i.gender,
          sortOrder: i.sortOrder,
          assetKey: i.assetKey,
          imageUrl: i.imageUrl,
          videoUrl: i.videoUrl,
          link: i.link ?? null,
          content: i.content,
          isEnabled: i.isEnabled,
          startsAt: i.startsAt ? i.startsAt.toISOString() : null,
          endsAt: i.endsAt ? i.endsAt.toISOString() : null,
          cities: i.cities ?? null,
        })),
    }));

  return { schemaVersion: CMS_SCHEMA_VERSION, sections: rendered };
}

export type FilterOptions = {
  /** Which rail is asking. Omit to keep every audience (used by the admin preview). */
  gender?: 'her' | 'him';
  /** Caller's city. Omit when unknown — see the city rule below. */
  city?: string | null;
  now: Date;
};

function withinWindow(item: SnapshotItem, now: Date): boolean {
  if (item.startsAt && new Date(item.startsAt).getTime() > now.getTime()) return false;
  if (item.endsAt && new Date(item.endsAt).getTime() <= now.getTime()) return false;
  return true;
}

function matchesCity(item: SnapshotItem, city: string | null | undefined): boolean {
  // NULL means "everywhere" and is the overwhelmingly common case.
  if (item.cities === null) return true;
  // A city-restricted item is hidden from a caller whose city we do not know. The alternative
  // — showing it to everyone — would leak a Mumbai-only campaign nationwide, which is the
  // strictly worse failure. An empty array therefore hides the item from everyone, which is
  // also why `cities` is nullable rather than defaulting to `[]`.
  if (!city) return false;
  const wanted = city.trim().toLowerCase();
  return item.cities.some((c) => c.trim().toLowerCase() === wanted);
}

function matchesGender(item: SnapshotItem, gender: 'her' | 'him' | undefined): boolean {
  if (!gender) return true;
  return item.gender === 'all' || item.gender === gender;
}

/** Snapshot → one device's view. Disabled sections drop out entirely. */
export function filterPayload(
  snapshot: CmsSnapshot,
  opts: FilterOptions,
): { schemaVersion: number; sections: PublicSection[] } {
  const sections = snapshot.sections
    .filter((s) => s.isEnabled)
    .map<PublicSection>((s) => ({
      key: s.key,
      type: s.type,
      title: s.title,
      subtitle: s.subtitle,
      kicker: s.kicker,
      ctaLabel: s.ctaLabel,
      config: s.config,
      items: s.items
        .filter(
          (i) =>
            i.isEnabled &&
            matchesGender(i, opts.gender) &&
            withinWindow(i, opts.now) &&
            matchesCity(i, opts.city),
        )
        .map<PublicItem>((i) => ({
          key: i.key,
          assetKey: i.assetKey,
          imageUrl: i.imageUrl,
          videoUrl: i.videoUrl,
          link: i.link,
          content: i.content,
        })),
    }));

  // A section whose every item is out of window still ships, with an empty `items`. The app
  // needs the section's copy and its own decision about what an empty rail looks like; a
  // missing section would instead read as "the app is out of date".
  return { schemaVersion: snapshot.schemaVersion, sections };
}

/** Narrow an unknown jsonb payload back to a snapshot, defensively. */
export function asSnapshot(payload: unknown): CmsSnapshot {
  const candidate = payload as Partial<CmsSnapshot> | null;
  if (!candidate || !Array.isArray(candidate.sections)) {
    return { schemaVersion: CMS_SCHEMA_VERSION, sections: [] };
  }
  return {
    schemaVersion: candidate.schemaVersion ?? CMS_SCHEMA_VERSION,
    sections: candidate.sections,
  };
}
