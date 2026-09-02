/**
 * Publish-time semantic validation for festival themes.
 *
 * Zod (theme-schema.ts) guarantees SHAPE at write time; this module guards MEANING at
 * publish: locked tokens, header/decor coherence, WCAG contrast, trusted asset hosts and
 * window sanity. Publish is the authoritative gate — drafts may hold work-in-progress
 * colors that fail contrast, but nothing below 4.5:1 ever reaches a phone.
 *
 * All failures across all enabled themes are COLLECTED (not first-aborted) so the portal
 * can show the editor the full damage in one 422: `details.failures` is
 * `[{ slug, field?, message }]`.
 */

import { env } from '@/config/env.js';
import { AppError } from '@/shared/errors/app-error.js';
import { parseAppVersion } from '@/shared/semver.js';
import { contrastRatio, WCAG_AA_MIN } from './contrast.js';
import type { CmsThemeRow } from './theme-render.js';
import {
  LOCKED_TOKENS,
  REMOTE_THEME_TOKENS,
  ThemeChromeSchema,
  ThemeCopySchema,
  ThemeDecorSchema,
  ThemeTokensSchema,
} from './theme-schema.js';

export type ThemeValidationFailure = { slug: string; field?: string; message: string };

/**
 * Hosts a theme asset URL may point at — our own media infrastructure only. Derived from
 * env so tests (STORAGE_DRIVER=memory -> memory.test) need no special-casing, and so a
 * pasted https://random-site.xyz/sparkles.json can never ship to every phone.
 */
export function trustedAssetHosts(): Set<string> {
  const hosts = new Set<string>();
  if (env.S3_PUBLIC_BASE_URL) hosts.add(new URL(env.S3_PUBLIC_BASE_URL).host);
  if (env.STORAGE_DRIVER === 'cloudinary' || env.CLOUDINARY_CLOUD_NAME) hosts.add('res.cloudinary.com');
  if (env.STORAGE_DRIVER === 'memory') hosts.add('memory.test');
  return hosts;
}

function checkAssetUrl(url: string, field: string, slug: string, out: ThemeValidationFailure[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    out.push({ slug, field, message: `${field} is not a valid URL` });
    return;
  }
  if (parsed.protocol !== 'https:') {
    out.push({ slug, field, message: `${field} must be https` });
    return;
  }
  const hosts = trustedAssetHosts();
  if (!hosts.has(parsed.host)) {
    out.push({
      slug,
      field,
      message: `${field} must point at our media CDN (${[...hosts].join(', ')}) - upload it via the portal`,
    });
  }
}

function checkContrast(a: string, b: string, label: string, slug: string, out: ThemeValidationFailure[]): void {
  const ratio = contrastRatio(a, b);
  if (ratio === null) return; // malformed hex is reported by the zod pass
  if (ratio < WCAG_AA_MIN) {
    out.push({
      slug,
      field: label,
      message: `${label} contrast is ${ratio.toFixed(2)}:1 - minimum is ${WCAG_AA_MIN}:1`,
    });
  }
}

/**
 * Every check for one theme row, appended into `out`. Saves pass `{ contrast: false }` so a
 * work-in-progress draft can hold failing colors; publish runs the full set.
 */
export function collectThemeFailures(
  row: CmsThemeRow,
  out: ThemeValidationFailure[],
  opts: { contrast?: boolean } = {},
): void {
  const withContrast = opts.contrast !== false;
  const slug = row.slug;

  // 1. Shape re-parse — defends against rows written before validation existed or by hand.
  const parses: Array<[string, { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } }]> = [
    ['tokens', ThemeTokensSchema.safeParse(row.tokens)],
    ['chrome', ThemeChromeSchema.safeParse(row.chrome)],
    ['decor', ThemeDecorSchema.safeParse(row.decor)],
    ['copy', ThemeCopySchema.safeParse(row.copy)],
  ];
  let shapeOk = true;
  for (const [field, result] of parses) {
    if (!result.success) {
      shapeOk = false;
      for (const issue of result.error?.issues ?? []) {
        out.push({ slug, field: [field, ...issue.path].join('.'), message: issue.message });
      }
    }
  }

  // 2. Locked/unknown tokens — zod's .strict() already rejects them, but name the offense
  // precisely when it happens (REMOTE_TOKEN_NOT_ALLOWED is the admin-facing contract).
  const remoteSet = new Set<string>(REMOTE_THEME_TOKENS);
  const lockedSet = new Set<string>(LOCKED_TOKENS);
  for (const key of Object.keys(row.tokens ?? {})) {
    if (lockedSet.has(key)) {
      out.push({ slug, field: `tokens.${key}`, message: `token "${key}" is locked and cannot be set remotely (REMOTE_TOKEN_NOT_ALLOWED)` });
    } else if (!remoteSet.has(key)) {
      out.push({ slug, field: `tokens.${key}`, message: `token "${key}" is not a remote-safe token (REMOTE_TOKEN_NOT_ALLOWED)` });
    }
  }

  if (!shapeOk) return; // coherence/contrast on malformed shapes would double-report

  // 3. Header/decor coherence.
  const header = row.chrome.header;
  if (header.kind === 'solid' && !header.color) {
    out.push({ slug, field: 'chrome.header.color', message: 'header kind "solid" requires a color' });
  }
  if (header.kind === 'gradient' && !header.gradient) {
    out.push({ slug, field: 'chrome.header.gradient', message: 'header kind "gradient" requires gradient stops' });
  }
  if (header.kind === 'image' && !header.overlayUrl) {
    out.push({ slug, field: 'chrome.header.overlayUrl', message: 'header kind "image" requires overlayUrl (it is the header image)' });
  }
  if (header.kind === 'default' && (header.color || header.gradient)) {
    out.push({ slug, field: 'chrome.header.kind', message: 'header kind "default" must not carry color or gradient' });
  }
  const decor = row.decor;
  if ((decor.kind === 'image' || decor.kind === 'lottie') && !decor.url) {
    out.push({ slug, field: 'decor.url', message: `decor kind "${decor.kind}" requires a url` });
  }
  if (decor.kind === 'none' && decor.url) {
    out.push({ slug, field: 'decor.url', message: 'decor kind "none" must not carry a url' });
  }
  // Deliberately NO .json suffix requirement: the URL shape differs per storage
  // driver (a Cloudinary raw upload need not keep the extension), and a suffix
  // proves nothing about content anyway. The real guard is the upload-time Lottie
  // shape check (shared/uploads/limits.ts assertLottieJson) plus the trusted-host
  // check below.

  // 4. Contrast — the pairs a phone actually renders as ink-on-surface.
  if (withContrast && row.tokens.accent && row.tokens.accentInk) {
    checkContrast(row.tokens.accentInk, row.tokens.accent, 'accentInk on accent', slug, out);
  }
  if (withContrast && header.ink) {
    if (header.kind === 'solid' && header.color) {
      checkContrast(header.ink, header.color, 'header ink on header color', slug, out);
    }
    if (header.kind === 'gradient' && header.gradient) {
      for (const stop of header.gradient) {
        checkContrast(header.ink, stop, `header ink on gradient stop ${stop}`, slug, out);
      }
    }
  }

  // 5. Trusted asset hosts.
  if (header.wordmarkUrl) checkAssetUrl(header.wordmarkUrl, 'chrome.header.wordmarkUrl', slug, out);
  if (header.overlayUrl) checkAssetUrl(header.overlayUrl, 'chrome.header.overlayUrl', slug, out);
  if (decor.url) checkAssetUrl(decor.url, 'decor.url', slug, out);

  // 6. Targeting sanity. (endsAt > startsAt is also a DB CHECK; minAppVersion is free text.)
  if (row.startsAt && row.endsAt && row.endsAt.getTime() <= row.startsAt.getTime()) {
    out.push({ slug, field: 'endsAt', message: 'endsAt must be after startsAt' });
  }
  if (row.minAppVersion !== null && parseAppVersion(row.minAppVersion) === null) {
    out.push({ slug, field: 'minAppVersion', message: `"${row.minAppVersion}" is not a valid version (use x.y.z)` });
  }
}

/** Throws a single 422 naming every failure across every row. */
export function assertPublishableThemes(rows: CmsThemeRow[]): void {
  const failures: ThemeValidationFailure[] = [];
  for (const row of rows) collectThemeFailures(row, failures);
  if (failures.length > 0) {
    throw AppError.validation('Themes failed validation', { failures });
  }
}
