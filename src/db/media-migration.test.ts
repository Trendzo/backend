import { describe, expect, it } from 'vitest';
import {
  findSourceUrls,
  isSourceUrl,
  mediaKeyFor,
  rewriteUrls,
  splitKey,
} from './media-migration.js';

const CLD =
  'https://res.cloudinary.com/dwroh4zkk/image/upload/v1780580209/closetx/applications/q0y.png';
const CF = 'https://dgwf2q4dx1fzq.cloudfront.net/uploads/2026/08/med_abc.jpg';

describe('isSourceUrl', () => {
  it('matches Cloudinary, the CloudFront host and the old bucket host only', () => {
    expect(isSourceUrl(CLD)).toBe(true);
    expect(isSourceUrl(CF)).toBe(true);
    expect(isSourceUrl('https://trendzo-media.s3.ap-south-1.amazonaws.com/uploads/a.png')).toBe(
      true,
    );
    expect(isSourceUrl('https://images.unsplash.com/photo-1?w=900')).toBe(false);
    expect(isSourceUrl('https://other.s3.amazonaws.com/a.png')).toBe(false);
    expect(isSourceUrl('not a url')).toBe(false);
  });
});

describe('findSourceUrls', () => {
  it('extracts from text, jsonb text and array literals, de-duplicated', () => {
    const json = JSON.stringify({ a: [CLD, CF, 'https://images.unsplash.com/x'], b: CLD });
    expect(findSourceUrls(json)).toEqual([CLD, CF]);
    expect(findSourceUrls(`{${CLD},${CF}}`)).toEqual([CLD, CF]);
    expect(findSourceUrls(`<img src="${CF}"> and ${CLD}.`)).toEqual([CF, `${CLD}.`.slice(0, -1)]);
  });
});

describe('mediaKeyFor', () => {
  it('keeps the S3 key for CloudFront / old-bucket URLs', () => {
    expect(mediaKeyFor(CF)).toBe('uploads/2026/08/med_abc.jpg');
    expect(
      mediaKeyFor('https://trendzo-media.s3.ap-south-1.amazonaws.com/ai-catalog-beta/x.png?v=1'),
    ).toBe('ai-catalog-beta/x.png');
  });

  it('namespaces Cloudinary paths, keeping transformations so URLs never collide', () => {
    expect(mediaKeyFor(CLD)).toBe(
      'legacy/cloudinary/dwroh4zkk/image/upload/v1780580209/closetx/applications/q0y.png',
    );
    const t = 'https://res.cloudinary.com/c/image/upload/w_512,q_auto/v1/a.png';
    expect(mediaKeyFor(t)).toBe('legacy/cloudinary/c/image/upload/w_512,q_auto/v1/a.png');
  });

  it('decodes escapes and rejects traversal or empty paths', () => {
    expect(mediaKeyFor('https://res.cloudinary.com/c/image/upload/v1/my%20file.png')).toBe(
      'legacy/cloudinary/c/image/upload/v1/my file.png',
    );
    expect(mediaKeyFor('https://dgwf2q4dx1fzq.cloudfront.net/')).toBeNull();
    // The URL parser resolves dot segments (even %2e%2e) itself, exactly as fetch will…
    expect(mediaKeyFor('https://dgwf2q4dx1fzq.cloudfront.net/a/%2e%2e/b.png')).toBe('b.png');
    // …but an encoded slash survives parsing and only becomes `..` once decoded.
    expect(mediaKeyFor('https://dgwf2q4dx1fzq.cloudfront.net/a%2f..%2fb.png')).toBeNull();
  });
});

describe('splitKey', () => {
  it('splits folder and last segment', () => {
    expect(splitKey('uploads/2026/08/med.jpg')).toEqual({
      folder: 'uploads/2026/08',
      publicId: 'med.jpg',
    });
    expect(splitKey('a.png')).toEqual({ folder: '', publicId: 'a.png' });
  });
});

describe('rewriteUrls', () => {
  it('replaces every occurrence, longest source first', () => {
    const map = new Map([
      [CF, 'https://m.test/b/uploads/2026/08/med_abc.jpg'],
      [`${CF}?w=1`, 'https://m.test/b/q.jpg'],
    ]);
    const text = JSON.stringify([CF, `${CF}?w=1`, CF]);
    expect(rewriteUrls(text, map)).toBe(
      JSON.stringify([
        'https://m.test/b/uploads/2026/08/med_abc.jpg',
        'https://m.test/b/q.jpg',
        'https://m.test/b/uploads/2026/08/med_abc.jpg',
      ]),
    );
    expect(rewriteUrls('no media here', map)).toBe('no media here');
  });
});
