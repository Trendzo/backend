export type ReadinessIssue = {
  code: string;
  field: string;
  message: string;
};

export type ReadinessResult = {
  canSaveDraft: boolean;
  canPublish: boolean;
  draftIssues: ReadinessIssue[];
  publishIssues: ReadinessIssue[];
};

type ListingInput = {
  status?: string | null;
  name?: string | null;
  categoryId?: string | null;
  gender?: string | null;
  description?: string | null;
  descriptionLong?: string | null;
  galleryUrls?: string[] | null;
  listingPolicy?: string | null;
  draftVariantData?: Record<string, unknown> | null;
};

type VariantInput = {
  pricePaise: number;
  sku: string | null;
  stock: number | null;
  imageUrls: string[];
  isActive: boolean;
};

/** Shared product readiness calculation. Write endpoints remain the final authority. */
export function evaluateProductReadiness(
  listing: ListingInput,
  variants: VariantInput[],
): ReadinessResult {
  const draftIssues: ReadinessIssue[] = [];
  const publishIssues: ReadinessIssue[] = [];
  const add = (code: string, field: string, message: string) =>
    publishIssues.push({ code, field, message });

  if (listing.status === 'taken_down')
    add('moderation_blocked', 'status', 'This product was taken down. Contact support before publishing it again');

  if (!listing.name?.trim()) add('name_required', 'name', 'Add a product name');
  if (!listing.categoryId) add('category_required', 'categoryId', 'Choose a category');
  if (!listing.gender) add('gender_required', 'gender', 'Choose who this product is for');
  if (!listing.description?.trim()) add('description_required', 'description', 'Add a short description');
  if (!listing.descriptionLong?.trim()) add('full_description_required', 'descriptionLong', 'Add a full description');
  if (!listing.galleryUrls?.length) add('gallery_required', 'galleryUrls', 'Add at least one product image');
  if (!listing.listingPolicy) add('policy_required', 'listingPolicy', 'Choose a return policy');
  const completeVariant = variants.some((v) =>
    v.isActive && v.pricePaise > 0 && !!v.sku && v.stock !== null &&
    (v.imageUrls.length > 0 || !!listing.galleryUrls?.length),
  );
  if (!completeVariant)
    add('variant_required', 'variants', 'Add one active variant with a price, SKU, stock and image');
  if (listing.draftVariantData && Object.keys(listing.draftVariantData).length > 0)
    add('unfinished_variants', 'variants', 'Finish or remove incomplete variant details');

  return { canSaveDraft: draftIssues.length === 0, canPublish: publishIssues.length === 0, draftIssues, publishIssues };
}
