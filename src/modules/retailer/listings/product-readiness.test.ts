import { describe, expect, it } from 'vitest';
import { evaluateProductReadiness } from './product-readiness.js';

const completeListing = {
  name: 'Linen shirt', categoryId: 'cat_shirts', gender: 'her',
  description: 'Soft linen shirt', descriptionLong: '<p>Soft linen shirt for warm days.</p>',
  galleryUrls: ['https://example.com/shirt.jpg'], listingPolicy: 'return',
};
const completeVariant = {
  pricePaise: 129900, sku: 'LINEN-01', stock: 0,
  imageUrls: [], isActive: true,
};

describe('product readiness', () => {
  it('allows an unfinished draft while explaining every publish requirement', () => {
    const result = evaluateProductReadiness({}, []);
    expect(result.canSaveDraft).toBe(true);
    expect(result.canPublish).toBe(false);
    expect(result.publishIssues.map(issue => issue.field)).toEqual([
      'name', 'categoryId', 'gender', 'description', 'descriptionLong',
      'galleryUrls', 'listingPolicy', 'variants',
    ]);
  });

  it('accepts a complete product with zero stock', () => {
    const result = evaluateProductReadiness(completeListing, [completeVariant]);
    expect(result.canPublish).toBe(true);
    expect(result.publishIssues).toEqual([]);
  });

  it('holds a product in draft while unfinished variant input is staged', () => {
    const result = evaluateProductReadiness(
      { ...completeListing, draftVariantData: { single: { size: 'M' } } },
      [completeVariant],
    );
    expect(result.canPublish).toBe(false);
    expect(result.publishIssues).toContainEqual(expect.objectContaining({ code: 'unfinished_variants' }));
  });

  it('requires an effectively active variant', () => {
    const result = evaluateProductReadiness(completeListing, [{ ...completeVariant, isActive: false }]);
    expect(result.canPublish).toBe(false);
    expect(result.publishIssues).toContainEqual(expect.objectContaining({ code: 'variant_required' }));
  });

  it('does not let a retailer republish a taken-down product', () => {
    const result = evaluateProductReadiness(
      { ...completeListing, status: 'taken_down' }, [completeVariant],
    );
    expect(result.canPublish).toBe(false);
    expect(result.publishIssues).toContainEqual(expect.objectContaining({ code: 'moderation_blocked' }));
  });
});
