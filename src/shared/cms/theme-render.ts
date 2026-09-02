/**
 * Snapshot rendering and the one-winner resolver.
 *
 * Same split as ./render.ts, for the same reason: RENDER freezes every enabled theme —
 * targeting included — into the publication at publish time; RESOLVE applies windows,
 * city, platform and app-version gates at READ time and picks exactly one winner. That is
 * what lets a theme published on Monday go live at midnight Friday with nobody touching
 * Publish, and expire on its own a week later.
 *
 * The resolver is deliberately a pure function of (snapshot, context): no clock reads, no
 * db, no randomness — the same inputs always name the same winner, on the public endpoint,
 * in the admin simulator, and in tests.
 */

import type { InferSelectModel } from 'drizzle-orm';
import { cmsThemes } from '@/db/schema/index.js';
import { meetsMinVersion } from '@/shared/semver.js';
import {
  THEME_REFRESH_AFTER_SECONDS,
  THEME_SCHEMA_VERSION,
  type PublicTheme,
  type SnapshotTheme,
  type ThemePlatform,
  type ThemeResponse,
  type ThemeSnapshot,
} from './theme-schema.js';

export type CmsThemeRow = InferSelectModel<typeof cmsThemes>;

/** Enabled rows only, dates to ISO, slug-ASC so identical drafts produce identical payloads. */
export function renderThemeSnapshot(rows: CmsThemeRow[]): ThemeSnapshot {
  const themes = rows
    .filter((r) => r.isEnabled)
    .map(
      (r): SnapshotTheme => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        priority: r.priority,
        startsAt: r.startsAt ? r.startsAt.toISOString() : null,
        endsAt: r.endsAt ? r.endsAt.toISOString() : null,
        cities: r.cities ?? null,
        platforms: r.platforms ?? null,
        minAppVersion: r.minAppVersion ?? null,
        updatedAt: r.updatedAt.toISOString(),
        tokens: r.tokens,
        chrome: r.chrome,
        decor: r.decor,
        copy: r.copy,
      }),
    )
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { schemaVersion: THEME_SCHEMA_VERSION, themes };
}

export type ThemeResolveContext = {
  now: Date;
  city?: string | null;
  platform?: ThemePlatform | null;
  appVersion?: string | null;
};

/** startsAt <= now < endsAt, either bound open. Same end-exclusive rule as render.ts. */
function withinThemeWindow(t: SnapshotTheme, now: Date): boolean {
  const ms = now.getTime();
  if (t.startsAt && Date.parse(t.startsAt) > ms) return false;
  if (t.endsAt && Date.parse(t.endsAt) <= ms) return false;
  return true;
}

/**
 * NULL = everywhere; [] = nowhere; a caller with no known city sees only unrestricted
 * themes. Lowercase/trim compare, copied from render.ts matchesCity — showing a
 * Mumbai-only skin nationwide is worse than not showing it.
 */
function matchesThemeCity(t: SnapshotTheme, city: string | null | undefined): boolean {
  if (t.cities === null) return true;
  if (!city) return false;
  const needle = city.trim().toLowerCase();
  return t.cities.some((c) => c.trim().toLowerCase() === needle);
}

/** NULL = both platforms; a request without x-app-platform fails closed on restricted themes. */
function matchesPlatform(t: SnapshotTheme, platform: ThemePlatform | null | undefined): boolean {
  if (t.platforms === null) return true;
  if (!platform) return false;
  return t.platforms.includes(platform);
}

/** NULL = no gate; unparseable/missing client versions fail closed (see shared/semver.ts). */
function meetsVersionGate(t: SnapshotTheme, appVersion: string | null | undefined): boolean {
  if (t.minAppVersion === null) return true;
  return meetsMinVersion(appVersion, t.minAppVersion);
}

/** City-restricted beats national at equal priority — the more deliberate targeting wins. */
function specificity(t: SnapshotTheme): number {
  return t.cities !== null ? 1 : 0;
}

/**
 * Precedence: eligible -> priority DESC -> specificity DESC -> updatedAt DESC -> slug ASC.
 * The final slug tiebreak makes the order total; there is no nondeterministic outcome.
 */
export function resolveTheme(snapshot: ThemeSnapshot, ctx: ThemeResolveContext): SnapshotTheme | null {
  const eligible = snapshot.themes.filter(
    (t) =>
      withinThemeWindow(t, ctx.now) &&
      matchesThemeCity(t, ctx.city) &&
      matchesPlatform(t, ctx.platform) &&
      meetsVersionGate(t, ctx.appVersion),
  );
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort(
    (a, b) =>
      b.priority - a.priority ||
      specificity(b) - specificity(a) ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
      a.slug.localeCompare(b.slug),
  );
  return sorted[0] ?? null;
}

/** Strip targeting for the wire — the server already applied it. */
export function publicThemeOf(t: SnapshotTheme): PublicTheme {
  return {
    slug: t.slug,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    tokens: t.tokens,
    chrome: t.chrome,
    decor: t.decor,
    copy: t.copy,
  };
}

export function buildThemeResponse(version: number | null, winner: SnapshotTheme | null): ThemeResponse {
  return {
    schemaVersion: THEME_SCHEMA_VERSION,
    publicationVersion: version ?? 0,
    generatedAt: new Date().toISOString(),
    refreshAfterSeconds: THEME_REFRESH_AFTER_SECONDS,
    theme: winner ? publicThemeOf(winner) : null,
  };
}

/**
 * Defensive narrowing of the publication jsonb — a snapshot written by a future (or
 * corrupted) build degrades to "no themes", never to a crash. Mirrors render.ts asSnapshot.
 */
export function asThemeSnapshot(payload: unknown): ThemeSnapshot {
  const empty: ThemeSnapshot = { schemaVersion: THEME_SCHEMA_VERSION, themes: [] };
  if (typeof payload !== 'object' || payload === null) return empty;
  const p = payload as Partial<ThemeSnapshot>;
  if (p.schemaVersion !== THEME_SCHEMA_VERSION || !Array.isArray(p.themes)) return empty;
  return { schemaVersion: THEME_SCHEMA_VERSION, themes: p.themes };
}
