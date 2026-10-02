/**
 * OTP provider layer: which provider a token is verified by (active / legacy / tagged),
 * the Slide and MSG91 server-side verifiers against a mocked network, and the public config
 * clients bootstrap from. No real MSG91 or Slide call is ever made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '@/config/env.js';
import { acceptedProviders, verifyOtpPhone } from '@/shared/otp/index.js';
import { getOtpConfig, resetOtpConfigCache } from '@/shared/otp/config.js';

type Mutable = Record<string, unknown>;
const e = env as unknown as Mutable;
const SAVED = { ...e };

const slideReply = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; init?: RequestInit };
let calls: Call[];
/** url-prefix -> handler. Unmatched URLs fail loudly: a test must never reach the network. */
let routes: Array<[string, (init?: RequestInit) => Response | Promise<Response>]>;

beforeEach(() => {
  calls = [];
  routes = [];
  resetOtpConfigCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const hit = routes.find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`unexpected network call: ${url}`);
      return hit[1](init);
    }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(e, SAVED);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const useSlide = (extra: Mutable = {}) =>
  Object.assign(e, {
    OTP_PROVIDER: 'slide',
    SLIDE_API_BASE_URL: 'https://slide.test/api',
    SLIDE_API_KEY: 'sk_live_test_key_123',
    SLIDE_WIDGET_ID: 'wgt-12345678',
    SLIDE_CLIENT_TOKEN: 'client-token-123',
    ...extra,
  });
const SLIDE_VERIFY = 'https://slide.test/api/otp/verify-token';
const MSG91_VERIFY = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';

describe('provider selection', () => {
  it('accepts the active provider, plus MSG91 while legacy is on', () => {
    Object.assign(e, { OTP_PROVIDER: 'msg91' });
    expect(acceptedProviders()).toEqual(['msg91']);
    useSlide({ OTP_ACCEPT_LEGACY_MSG91: 'true' });
    expect(acceptedProviders()).toEqual(['slide', 'msg91']);
    useSlide({ OTP_ACCEPT_LEGACY_MSG91: 'false' });
    expect(acceptedProviders()).toEqual(['slide']);
  });

  it('an untagged token (shipped build) is MSG91 while legacy is on, else the active provider', async () => {
    useSlide({ OTP_ACCEPT_LEGACY_MSG91: 'true', MSG91_AUTH_KEY: 'msg91-consumer-key' });
    routes.push([MSG91_VERIFY, () => slideReply({ type: 'success', message: '919800000001' })]);
    routes.push([SLIDE_VERIFY, () => slideReply({ valid: true, identifier: '+919800000002' })]);

    const legacy = await verifyOtpPhone('t'.repeat(30), {
      audience: 'consumer',
      format: 'national',
    });
    expect(legacy).toBe('9800000001');
    expect(calls.at(-1)?.url).toBe(MSG91_VERIFY);

    e.OTP_ACCEPT_LEGACY_MSG91 = 'false';
    const strict = await verifyOtpPhone('t'.repeat(30), {
      audience: 'consumer',
      format: 'national',
    });
    expect(strict).toBe('9800000002');
    expect(calls.at(-1)?.url).toBe(SLIDE_VERIFY);
  });

  it('a tagged token goes to that provider; a provider the server does not accept is a 422', async () => {
    useSlide({ OTP_ACCEPT_LEGACY_MSG91: 'false' });
    routes.push([SLIDE_VERIFY, () => slideReply({ valid: true, identifier: '+919800000003' })]);
    expect(
      await verifyOtpPhone('t'.repeat(30), {
        audience: 'retailer',
        format: 'e164',
        provider: 'slide',
      }),
    ).toBe('+919800000003');
    await expect(
      verifyOtpPhone('t'.repeat(30), { audience: 'retailer', format: 'e164', provider: 'msg91' }),
    ).rejects.toMatchObject({ httpStatus: 422 });

    Object.assign(e, { OTP_PROVIDER: 'msg91' });
    await expect(
      verifyOtpPhone('t'.repeat(30), { audience: 'retailer', format: 'e164', provider: 'slide' }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('formats the verified phone per login: e164 keeps the country code, national is 10 digits', async () => {
    useSlide();
    routes.push([SLIDE_VERIFY, () => slideReply({ verified: true, identifier: '+971501234567' })]);
    expect(
      await verifyOtpPhone('t'.repeat(30), {
        audience: 'retailer',
        format: 'e164',
        provider: 'slide',
      }),
    ).toBe('+971501234567');
    expect(
      await verifyOtpPhone('t'.repeat(30), {
        audience: 'consumer',
        format: 'national',
        provider: 'slide',
      }),
    ).toBe('1501234567');
  });
});

describe('slide provider', () => {
  const verify = () =>
    verifyOtpPhone('jwt-'.padEnd(40, 'x'), {
      audience: 'driver',
      format: 'e164',
      provider: 'slide',
    });

  it('sends the secret key as Bearer with the token, to the configured base URL', async () => {
    useSlide({ SLIDE_API_BASE_URL: 'https://slide.test/api///' });
    routes.push([SLIDE_VERIFY, () => slideReply({ valid: true, identifier: '+919876543210' })]);
    expect(await verify()).toBe('+919876543210');
    const init = calls[0]?.init as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_live_test_key_123',
    );
    expect(JSON.parse(init.body as string)).toEqual({ accessToken: 'jwt-'.padEnd(40, 'x') });
  });

  it('accepts both reply spellings (`valid` and `verified`)', async () => {
    useSlide();
    routes.push([SLIDE_VERIFY, () => slideReply({ verified: true, identifier: '+919876543210' })]);
    expect(await verify()).toBe('+919876543210');
  });

  it.each([
    ['valid:false', { valid: false, identifier: '+919876543210' }, 200],
    ['no identifier', { valid: true }, 200],
    ['HTTP 400 used/expired', { message: 'Token already used', statusCode: 400 }, 400],
    ['HTTP 404', { message: 'not found', statusCode: 404 }, 404],
  ])('rejects an invalid token with 401: %s', async (_n, body, status) => {
    useSlide();
    routes.push([SLIDE_VERIFY, () => slideReply(body, status)]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('rejects a valid token that another widget issued', async () => {
    useSlide();
    routes.push([
      SLIDE_VERIFY,
      () =>
        slideReply({ valid: true, identifier: '+919876543210', widgetId: 'someone-elses-widget' }),
    ]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 401 });
  });

  it('accepts the token when the reply names OUR widget', async () => {
    useSlide();
    routes.push([
      SLIDE_VERIFY,
      () => slideReply({ valid: true, identifier: '+919876543210', widgetId: 'wgt-12345678' }),
    ]);
    expect(await verify()).toBe('+919876543210');
  });

  it('reports our own rejected API key as 503, not as a wrong code', async () => {
    useSlide();
    routes.push([
      SLIDE_VERIFY,
      () => slideReply({ message: 'Invalid API key', httpStatus: 401 }, 401),
    ]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 503 });
  });

  it('maps provider outages and network failures to 502', async () => {
    useSlide();
    routes.push([SLIDE_VERIFY, () => slideReply({ message: 'boom' }, 500)]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 502 });
    routes.length = 0;
    routes.push([SLIDE_VERIFY, () => Promise.reject(new Error('ECONNRESET'))]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 502 });
    routes.length = 0;
    routes.push([SLIDE_VERIFY, () => new Response('<html>', { status: 200 })]);
    await expect(verify()).rejects.toMatchObject({ httpStatus: 502 });
  });

  it('is 503 without an API key, before any network call', async () => {
    useSlide({ SLIDE_API_KEY: undefined });
    await expect(verify()).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls).toHaveLength(0);
  });
});

describe('msg91 provider keeps its per-audience accounts', () => {
  const authkeyOf = (i: number) => (calls[i]?.init?.headers as Record<string, string>).authkey;
  beforeEach(() => {
    Object.assign(e, {
      OTP_PROVIDER: 'msg91',
      MSG91_AUTH_KEY: 'consumer-authkey-0000',
      MSG91_RETAILER_AUTH_KEY: 'retailer-authkey-0000',
      MSG91_DRIVER_AUTH_KEY: undefined,
    });
    routes.push([MSG91_VERIFY, () => slideReply({ type: 'success', message: '919876543210' })]);
  });

  it('consumer -> consumer key; retailer and CRM -> retailer key; driver -> retailer key unless a driver key is set', async () => {
    const tok = 't'.repeat(30);
    await verifyOtpPhone(tok, { audience: 'consumer', format: 'national' });
    await verifyOtpPhone(tok, { audience: 'retailer', format: 'e164' });
    await verifyOtpPhone(tok, { audience: 'crm', format: 'national' });
    await verifyOtpPhone(tok, { audience: 'driver', format: 'e164' });
    e.MSG91_DRIVER_AUTH_KEY = 'driver-authkey-00000';
    await verifyOtpPhone(tok, { audience: 'driver', format: 'e164' });
    expect([0, 1, 2, 3, 4].map(authkeyOf)).toEqual([
      'consumer-authkey-0000',
      'retailer-authkey-0000',
      'retailer-authkey-0000',
      'retailer-authkey-0000',
      'driver-authkey-00000',
    ]);
  });

  it('never falls back to the consumer key for retailer/CRM/driver: 503 instead', async () => {
    e.MSG91_RETAILER_AUTH_KEY = undefined;
    for (const audience of ['retailer', 'crm', 'driver'] as const) {
      await expect(
        verifyOtpPhone('t'.repeat(30), { audience, format: 'e164' }),
      ).rejects.toMatchObject({ httpStatus: 503 });
    }
    expect(calls).toHaveLength(0);
  });

  it('a failed verification is a 401, an unreachable MSG91 is a 502', async () => {
    routes.length = 0;
    routes.push([MSG91_VERIFY, () => slideReply({ type: 'error', message: 'Invalid token' })]);
    await expect(
      verifyOtpPhone('t'.repeat(30), { audience: 'consumer', format: 'national' }),
    ).rejects.toMatchObject({ httpStatus: 401 });
    routes.length = 0;
    routes.push([MSG91_VERIFY, () => Promise.reject(new Error('down'))]);
    await expect(
      verifyOtpPhone('t'.repeat(30), { audience: 'consumer', format: 'national' }),
    ).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe('public otp config', () => {
  it('msg91: 4-digit code, no Slide section', async () => {
    Object.assign(e, { OTP_PROVIDER: 'msg91' });
    expect(await getOtpConfig()).toEqual({
      provider: 'msg91',
      accepts: ['msg91'],
      otpLength: 4,
      resendSeconds: 30,
    });
  });

  it('slide: serves the PUBLIC pair and Slide-reported length/resend, never the API key', async () => {
    useSlide({ OTP_ACCEPT_LEGACY_MSG91: 'true' });
    routes.push([
      'https://slide.test/api/otp/public/widget-config/wgt-12345678?tokenAuth=client-token-123',
      () =>
        slideReply({ widgetId: 'wgt-12345678', settings: { otpLength: 5, resendAfterSec: 45 } }),
    ]);
    const cfg = await getOtpConfig();
    expect(cfg).toMatchObject({
      provider: 'slide',
      accepts: ['slide', 'msg91'],
      otpLength: 5,
      resendSeconds: 45,
      slide: {
        baseUrl: 'https://slide.test/api',
        widgetId: 'wgt-12345678',
        tokenAuth: 'client-token-123',
      },
    });
    expect(JSON.stringify(cfg)).not.toContain('sk_live');
  });

  it('slide: falls back to env defaults when widget-config is unreadable, and does not hammer it', async () => {
    useSlide({ SLIDE_OTP_LENGTH: 6, SLIDE_RESEND_SECONDS: 30 });
    routes.push([
      'https://slide.test/api/otp/public/widget-config/',
      () => slideReply({ message: 'nope' }, 401),
    ]);
    expect(await getOtpConfig()).toMatchObject({ otpLength: 6, resendSeconds: 30 });
    await getOtpConfig();
    expect(calls).toHaveLength(1); // failure is cached briefly
  });
});
