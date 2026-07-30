import { z } from 'zod';

/**
 * Shape-level validation only. Whether a `content` key is legal for a given section, and
 * whether a link's route exists in the app, are answered by the section catalogue in
 * `shared/cms/validate.ts` — zod cannot know either without duplicating that catalogue.
 */

export const SectionKeyParam = z.object({
  key: z.string().min(1).max(64),
});

export const IdParam = z.object({
  id: z.string().min(1),
});

export const VersionParam = z.object({
  version: z.coerce.number().int().min(1),
});

const Json = z.record(z.unknown());

const LinkSchema = z
  .object({
    route: z.string().min(1),
    params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .nullable();

export const PatchSectionBody = z
  .object({
    title: z.string().max(200).nullable().optional(),
    subtitle: z.string().max(400).nullable().optional(),
    kicker: z.string().max(200).nullable().optional(),
    ctaLabel: z.string().max(60).nullable().optional(),
    config: Json.optional(),
    isEnabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

/**
 * `cities: null` means everywhere and `[]` means nowhere — both are meaningful, so the field is
 * nullable rather than optional-with-a-default. Same for the publish window.
 */
const ItemFields = {
  key: z.string().min(1).max(80),
  gender: z.enum(['her', 'him', 'all']),
  sortOrder: z.number().int().min(0),
  assetKey: z.string().max(200).nullable(),
  imageUrl: z.string().url().max(2000).nullable(),
  videoUrl: z.string().url().max(2000).nullable(),
  link: LinkSchema,
  content: Json,
  isEnabled: z.boolean(),
  startsAt: z.coerce.date().nullable(),
  endsAt: z.coerce.date().nullable(),
  cities: z.array(z.string().min(1).max(80)).nullable(),
};

export const CreateItemBody = z.object({
  key: ItemFields.key,
  gender: ItemFields.gender.default('all'),
  sortOrder: ItemFields.sortOrder.optional(),
  assetKey: ItemFields.assetKey.optional(),
  imageUrl: ItemFields.imageUrl.optional(),
  videoUrl: ItemFields.videoUrl.optional(),
  link: ItemFields.link.optional(),
  content: ItemFields.content.default({}),
  isEnabled: ItemFields.isEnabled.default(true),
  startsAt: ItemFields.startsAt.optional(),
  endsAt: ItemFields.endsAt.optional(),
  cities: ItemFields.cities.optional(),
});

export const PatchItemBody = z
  .object({
    key: ItemFields.key.optional(),
    gender: ItemFields.gender.optional(),
    sortOrder: ItemFields.sortOrder.optional(),
    assetKey: ItemFields.assetKey.optional(),
    imageUrl: ItemFields.imageUrl.optional(),
    videoUrl: ItemFields.videoUrl.optional(),
    link: ItemFields.link.optional(),
    content: ItemFields.content.optional(),
    isEnabled: ItemFields.isEnabled.optional(),
    startsAt: ItemFields.startsAt.optional(),
    endsAt: ItemFields.endsAt.optional(),
    cities: ItemFields.cities.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const ReorderBody = z.object({
  /** Full ordered list of the section's item ids. Position in the array becomes sortOrder. */
  itemIds: z.array(z.string().min(1)).min(1),
});

export const PreviewQuery = z.object({
  gender: z.enum(['her', 'him']).optional(),
  city: z.string().min(1).max(80).optional(),
  /** `draft` (default) previews unpublished edits; `published` shows what is live now. */
  source: z.enum(['draft', 'published']).default('draft'),
});

export const PublishBody = z.object({
  note: z.string().max(280).optional(),
});

export const AssetsQuery = z.object({
  category: z.string().min(1).max(80).optional(),
});

export type CreateItemInput = z.infer<typeof CreateItemBody>;
export type PatchItemInput = z.infer<typeof PatchItemBody>;
export type PatchSectionInput = z.infer<typeof PatchSectionBody>;
