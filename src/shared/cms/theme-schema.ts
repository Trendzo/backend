/**
 * Festival theme contract — the single source of truth for what a theme MAY say.
 *
 * A theme is a bounded remote skin: a handful of allowlisted color tokens, header/tab-bar
 * chrome, one decoration, and two copy strings. It is deliberately NOT a general style
 * sheet — the app's structural palette (bg/ink/dim/...) and every semantic status color
 * (ok/warn/err/green) are locked, because an error must stay red in every season and the
 * savings green is money to a customer. `LOCKED_TOKENS` exists so the publish gate can name
 * the offender; the zod schemas are `.strict()`, so unknown keys are rejected at write time
 * regardless.
 *
 * Three shapes live here, mirroring shared/cms/render.ts's Snapshot/Public split:
 *   - draft payload schemas   — what admin writes (validated on create/patch and re-checked
 *                               at publish),
 *   - SnapshotTheme           — one theme frozen into a publication, targeting included,
 *   - PublicTheme / ThemeResponse — what a phone receives from GET /cms/theme (targeting
 *                               stripped; the resolver already applied it).
 *
 * The admin portal keeps hand-mirrored copies (`web-portal/src/lib/{types,schemas}.ts`) and
 * the consumer app validates against this shape in `src/theme/remoteTheme.ts` — change all
 * three together, and bump THEME_SCHEMA_VERSION when the SHAPE changes so older apps refuse
 * a payload they cannot render.
 *
 * Header `kind: 'image'` reuses `overlayUrl` as the full-bleed header image — there is no
 * separate imageUrl field.
 */

import { z } from 'zod';

export const THEME_SCHEMA_VERSION = 1 as const;

/** How long a client should trust a response before revalidating. */
export const THEME_REFRESH_AFTER_SECONDS = 1800 as const;

/** The only palette keys a theme may override. Everything else is client-owned or locked. */
export const REMOTE_THEME_TOKENS = ['accent', 'accentInk', 'accentSoft', 'surfaceAlt', 'hairline'] as const;

/** Never remotely writable. Named so the publish gate can produce a pointed error. */
export const LOCKED_TOKENS = ['bg', 'ink', 'inkSoft', 'dim', 'faint', 'white', 'ok', 'warn', 'err', 'green'] as const;

/** 6-digit only — contrast validation needs full channels, and one canonical form beats two. */
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a 6-digit hex color like #C1121F');

export const ThemeTokensSchema = z
  .object({
    accent: HexColor.optional(),
    accentInk: HexColor.optional(),
    accentSoft: HexColor.optional(),
    surfaceAlt: HexColor.optional(),
    hairline: HexColor.optional(),
  })
  .strict();

export const ThemeHeaderSchema = z
  .object({
    kind: z.enum(['default', 'solid', 'gradient', 'image']),
    color: HexColor.optional(),
    gradient: z.tuple([HexColor, HexColor]).optional(),
    ink: HexColor.optional(),
    wordmarkUrl: z.string().url().max(2000).optional(),
    /** Doubles as the full-bleed header image when kind === 'image'. */
    overlayUrl: z.string().url().max(2000).optional(),
    overlayHeight: z.number().int().min(1).max(300).optional(),
  })
  .strict();

export const ThemeChromeSchema = z
  .object({
    statusBarStyle: z.enum(['light', 'dark']),
    header: ThemeHeaderSchema,
    tabBar: z
      .object({
        activeInk: HexColor.optional(),
        badgeBg: HexColor.optional(),
      })
      .strict(),
  })
  .strict();

export const ThemeDecorSchema = z
  .object({
    kind: z.enum(['none', 'image', 'lottie']),
    url: z.string().url().max(2000).optional(),
    placement: z.literal('header').optional(),
    loop: z.boolean().optional(),
    maxPlays: z.number().int().min(1).max(10).optional(),
    /** Always true — a decoration that ignores the OS reduce-motion setting is not shippable. */
    respectReduceMotion: z.literal(true),
  })
  .strict();

export const ThemeCopySchema = z
  .object({
    greeting: z.string().max(80).optional(),
    searchPlaceholder: z.string().max(60).optional(),
  })
  .strict();

export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type ThemeChrome = z.infer<typeof ThemeChromeSchema>;
export type ThemeHeader = z.infer<typeof ThemeHeaderSchema>;
export type ThemeDecor = z.infer<typeof ThemeDecorSchema>;
export type ThemeCopy = z.infer<typeof ThemeCopySchema>;

export type ThemePlatform = 'ios' | 'android';

/**
 * One theme frozen into a publication. Targeting rides along because eligibility is decided
 * at READ time (the render/filter split from shared/cms/render.ts) — that is what lets a
 * theme published today go live at midnight on its own. `updatedAt` is the draft's stamp
 * frozen at publish; the resolver uses it as the recency tiebreak.
 */
export type SnapshotTheme = {
  /** The draft row id, frozen at publish. Slug is editable, so identity is the id. */
  id: string;
  slug: string;
  name: string;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
  cities: string[] | null;
  platforms: ThemePlatform[] | null;
  minAppVersion: string | null;
  updatedAt: string;
  tokens: ThemeTokens;
  chrome: ThemeChrome;
  decor: ThemeDecor;
  copy: ThemeCopy;
};

export type ThemeSnapshot = { schemaVersion: typeof THEME_SCHEMA_VERSION; themes: SnapshotTheme[] };

/** What a phone receives: the winner with its targeting stripped (the server already applied it). */
export type PublicTheme = Pick<
  SnapshotTheme,
  'slug' | 'startsAt' | 'endsAt' | 'tokens' | 'chrome' | 'decor' | 'copy'
>;

export type ThemeResponse = {
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  /** 0 when nothing has ever been published. */
  publicationVersion: number;
  generatedAt: string;
  refreshAfterSeconds: typeof THEME_REFRESH_AFTER_SECONDS;
  theme: PublicTheme | null;
};
