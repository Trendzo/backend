import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app.js';
import { signAccessToken, verifyAccessToken } from '@/shared/auth/jwt.js';

const app = buildApp();

beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); });

describe('applicant document upload scope', () => {
  it('exchanges a verified retailer phone for a scoped upload token', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/retailer/onboarding-session',
      payload: { accessToken: `fake:919876543210:${'x'.repeat(24)}` },
    });
    expect(response.statusCode).toBe(200);
    const token = response.json().data.token as string;
    expect(verifyAccessToken(token)).toMatchObject({ kind: 'onboarding', sub: '+919876543210' });
  });

  it('returns the scoped token when OTP login finds no account', async () => {
    const phone = '+919888123456';
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/retailer/otp/login',
      payload: { accessToken: `fake:${phone}:${'x'.repeat(24)}` },
    });
    expect(response.statusCode).toBe(401);
    const token = response.json().error.details.onboardingToken as string;
    expect(verifyAccessToken(token)).toMatchObject({ kind: 'onboarding', sub: phone });
  });

  it('rejects an anonymous upload', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/uploads/onboarding' });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the applicant token only on the scoped upload route', async () => {
    const token = signAccessToken({ sub: '+919876543210', kind: 'onboarding' }, { expiresIn: '7d' });
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=test-boundary' };
    const scoped = await app.inject({
      method: 'POST', url: '/api/v1/uploads/onboarding', headers,
      payload: Buffer.from('--test-boundary--\r\n'),
    });
    expect(scoped.statusCode).toBe(422);
    expect(scoped.json().error.message).toContain('Choose a document photo');

    const general = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers });
    expect(general.statusCode).toBe(403);

    const boundary = 'document-boundary';
    const badFile = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.jpg"\r\nContent-Type: image/jpeg\r\n\r\n<html>not an image</html>\r\n--${boundary}--\r\n`,
    );
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/uploads/onboarding',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: badFile,
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.message).toContain('JPEG, PNG, or WebP');
  });
});
