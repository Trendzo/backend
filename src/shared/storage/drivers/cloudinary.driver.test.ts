import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/env.js', () => ({
  env: {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
  },
}));

const { cloudinarySignedDownloadUrl } = await import('./cloudinary.driver.js');

const params = (url: string | null) => {
  expect(url).not.toBeNull();
  const u = new URL(url as string);
  return { path: u.origin + u.pathname, q: Object.fromEntries(u.searchParams) };
};

describe('cloudinarySignedDownloadUrl', () => {
  it('maps a versioned image delivery URL to a signed download of the original', () => {
    const { path, q } = params(
      cloudinarySignedDownloadUrl(
        'https://res.cloudinary.com/demo/image/upload/v1786530890/closetx/applications/ctpq.pdf',
      ),
    );
    expect(path).toBe('https://api.cloudinary.com/v1_1/demo/image/download');
    expect(q).toMatchObject({
      public_id: 'closetx/applications/ctpq',
      format: 'pdf',
      type: 'upload',
      api_key: 'key',
    });
    expect(q.signature).toMatch(/^[0-9a-f]{40}$/);
    expect(Number(q.expires_at)).toBeGreaterThan(Date.now() / 1000);
  });

  it('keeps the extension in the public id of raw assets', () => {
    const { path, q } = params(
      cloudinarySignedDownloadUrl(
        'https://res.cloudinary.com/demo/raw/upload/v1/closetx/docs/a.zip',
      ),
    );
    expect(path).toBe('https://api.cloudinary.com/v1_1/demo/raw/download');
    expect(q.public_id).toBe('closetx/docs/a.zip');
    expect(q.format).toBeUndefined();
  });

  it('accepts an unversioned URL whose first segment is a folder', () => {
    const { q } = params(
      cloudinarySignedDownloadUrl('https://res.cloudinary.com/demo/image/upload/closetx/x%20y.png'),
    );
    expect(q).toMatchObject({ public_id: 'closetx/x y', format: 'png' });
  });

  it('declines URLs it cannot sign faithfully', () => {
    for (const url of [
      'https://res.cloudinary.com/other/image/upload/v1/closetx/a.png', // another cloud
      'https://res.cloudinary.com/demo/image/upload/c_fill,w_200/v1/closetx/a.png', // transformed
      'https://res.cloudinary.com/demo/image/upload/f_auto/closetx/a.png', // transformed
      'https://res.cloudinary.com/demo/image/upload/v1', // no public id
      'https://dgwf2q4dx1fzq.cloudfront.net/uploads/a.png', // not Cloudinary
      'not a url',
    ]) {
      expect(cloudinarySignedDownloadUrl(url), url).toBeNull();
    }
  });
});
