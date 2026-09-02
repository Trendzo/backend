/**
 * Zod for the theme admin API. Shape only — semantic validity (locked tokens, contrast,
 * coherence, trusted hosts) lives in shared/cms/theme-validate.ts, and publish is the
 * authoritative gate. Nullable-not-optional on cities/platforms/window/minAppVersion:
 * `null` clears a field, absence leaves it unchanged, and the difference matters.
 */
import { z } from 'zod';
import {
  ThemeChromeSchema,
  ThemeCopySchema,
  ThemeDecorSchema,
  ThemeTokensSchema,
} from '@/shared/cms/theme-schema.js';

export const ThemeIdParam = z.object({
  id: z.string().min(1).max(80),
});

export const VersionParam = z.object({
  version: z.coerce.number().int().min(1),
});

/** Lowercase kebab, 2-80 chars — it is a public identifier and a stable analytics key. */
const SlugField = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,79}$/, 'Slug must be lowercase kebab-case, 2-80 chars');

const CitiesField = z.array(z.string().trim().min(1).max(80)).max(50);
const PlatformsField = z.array(z.enum(['ios', 'android'])).max(2);
const MinAppVersionField = z.string().trim().min(1).max(32);

export const CreateThemeBody = z.object({
  slug: SlugField,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  isEnabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10_000).default(0),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  cities: CitiesField.nullable().optional(),
  platforms: PlatformsField.nullable().optional(),
  minAppVersion: MinAppVersionField.nullable().optional(),
  tokens: ThemeTokensSchema.default({}),
  chrome: ThemeChromeSchema.default({ statusBarStyle: 'dark', header: { kind: 'default' }, tabBar: {} }),
  decor: ThemeDecorSchema.default({ kind: 'none', respectReduceMotion: true }),
  copy: ThemeCopySchema.default({}),
});

export const PatchThemeBody = z
  .object({
    slug: SlugField.optional(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    isEnabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
    cities: CitiesField.nullable().optional(),
    platforms: PlatformsField.nullable().optional(),
    minAppVersion: MinAppVersionField.nullable().optional(),
    tokens: ThemeTokensSchema.optional(),
    chrome: ThemeChromeSchema.optional(),
    decor: ThemeDecorSchema.optional(),
    copy: ThemeCopySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const CloneThemeBody = z.object({
  slug: SlugField,
  name: z.string().trim().min(1).max(120),
});

export const PublishThemesBody = z.object({
  note: z.string().trim().min(1).max(280).optional(),
});

export const ThemePreviewQuery = z.object({
  source: z.enum(['draft', 'published']).default('draft'),
  /** Resolve as-of this instant — how "publishes today, goes live Friday" is demonstrated. */
  at: z.coerce.date().optional(),
  city: z.string().min(1).max(80).optional(),
  platform: z.enum(['ios', 'android']).optional(),
  appVersion: z.string().min(1).max(32).optional(),
});

export type CreateThemeInput = z.infer<typeof CreateThemeBody>;
export type PatchThemeInput = z.infer<typeof PatchThemeBody>;
export type ThemePreviewInput = z.infer<typeof ThemePreviewQuery>;
