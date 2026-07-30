/**
 * Write-time validation for the CMS jsonb columns.
 *
 * `cms_items.content` and `cms_sections.config` are free-form jsonb, which is what lets one
 * table hold twenty different widget shapes. The section catalogue in `schema.ts` is what keeps
 * that from becoming a junk drawer: every write is checked against the declared field list, so
 * a typo'd key is a 422 at the API rather than a silently missing headline in production.
 *
 * Unknown keys are rejected rather than dropped. Dropping them would let an admin save a form,
 * see their text vanish, and have no idea why.
 */

import { AppError } from '@/shared/errors/app-error.js';
import { CMS_ROUTES, type CmsFieldSpec, type CmsSectionSpec } from './schema.js';

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ROUTE_SET = new Set<string>(CMS_ROUTES);

function checkField(spec: CmsFieldSpec, value: unknown, where: string): void {
  const label = `${where}.${spec.key}`;

  switch (spec.kind) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') {
        throw AppError.validation(`"${label}" must be a string`);
      }
      if (spec.maxLength !== undefined && value.length > spec.maxLength) {
        throw AppError.validation(
          `"${label}" is ${value.length} characters; the limit is ${spec.maxLength}`,
        );
      }
      return;
    }
    case 'color': {
      if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
        throw AppError.validation(`"${label}" must be a hex colour like #F2E63C`);
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw AppError.validation(`"${label}" must be a finite number`);
      }
      return;
    }
    case 'string_list': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw AppError.validation(`"${label}" must be an array of strings`);
      }
      return;
    }
  }
}

function checkObject(
  fields: readonly CmsFieldSpec[],
  value: Record<string, unknown>,
  where: string,
): void {
  const allowed = new Map(fields.map((f) => [f.key, f]));

  for (const [key, raw] of Object.entries(value)) {
    const spec = allowed.get(key);
    if (!spec) {
      const known = fields.map((f) => f.key).join(', ') || '(none)';
      throw AppError.validation(
        `"${where}.${key}" is not a field of this section. Allowed: ${known}`,
      );
    }
    // An explicit null is how the UI clears an optional field.
    if (raw === null || raw === undefined) {
      if (spec.required) throw AppError.validation(`"${where}.${spec.key}" is required`);
      continue;
    }
    checkField(spec, raw, where);
  }

  for (const spec of fields) {
    if (!spec.required) continue;
    const present = value[spec.key];
    if (present === undefined || present === null || present === '') {
      throw AppError.validation(`"${where}.${spec.key}" is required`);
    }
  }
}

/** Validate an item's `content` against its section's declared item fields. */
export function validateItemContent(
  spec: CmsSectionSpec,
  content: Record<string, unknown>,
): void {
  checkObject(spec.itemFields, content, 'content');
}

/** Validate a section's `config` against its declared config fields. */
export function validateSectionConfig(
  spec: CmsSectionSpec,
  config: Record<string, unknown>,
): void {
  checkObject(spec.configFields, config, 'config');
}

/**
 * Validate a link. The route must exist in the app's navigation stack — otherwise the tap
 * throws at runtime on a device, far away from whoever typed it.
 */
export function validateLink(link: unknown): void {
  if (link === null || link === undefined) return;
  if (typeof link !== 'object' || Array.isArray(link)) {
    throw AppError.validation('"link" must be an object like { route, params }');
  }
  const { route, params } = link as { route?: unknown; params?: unknown };
  if (typeof route !== 'string' || !ROUTE_SET.has(route)) {
    throw AppError.validation(
      `"link.route" must be one of the app's registered routes; got ${JSON.stringify(route)}`,
    );
  }
  if (params === undefined || params === null) return;
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw AppError.validation('"link.params" must be an object');
  }
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    const kind = typeof value;
    if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw AppError.validation(
        `"link.params.${key}" must be a string, number or boolean — nested params are not supported`,
      );
    }
  }
}

/** A section that renders images needs one; a copy-only section must not carry any. */
export function validateMedia(
  spec: CmsSectionSpec,
  media: {
    assetKey?: string | null | undefined;
    imageUrl?: string | null | undefined;
    videoUrl?: string | null | undefined;
  },
): void {
  const hasImage = Boolean(media.assetKey || media.imageUrl);
  const hasVideo = Boolean(media.videoUrl);

  if (spec.media === 'none') {
    if (hasImage || hasVideo) {
      throw AppError.validation(`"${spec.label}" items do not carry media`);
    }
    return;
  }
  if (spec.media === 'image' && !hasImage) {
    throw AppError.validation(
      `"${spec.label}" items need an image — set either an asset key or an image URL`,
    );
  }
  if (spec.media === 'video' && !hasVideo && !hasImage) {
    throw AppError.validation(
      `"${spec.label}" items need a video, or a poster image while the clip is being produced`,
    );
  }
}
