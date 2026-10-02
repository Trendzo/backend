import { env } from '@/config/env.js';
import { acceptedProviders, type OtpProviderName } from './index.js';

/**
 * What a client needs to run OTP login: which provider, how long the code is, and (for
 * Slide) the PUBLIC widget id + client token plus where to call. Served unauthenticated
 * by GET /auth/otp-config and GET /crm/auth/config. Never includes SLIDE_API_KEY.
 *
 * Slide's public endpoints (what the Slide widget script itself calls; CORS-open, JSON):
 *   GET  {baseUrl}/otp/public/widget-config/{widgetId}?tokenAuth=…
 *   POST {baseUrl}/otp/public/send   {widgetId, tokenAuth, identifier:"+<dial><national>"} -> {requestId}
 *   POST {baseUrl}/otp/public/retry  {requestId, channel?}                                 -> {requestId}
 *   POST {baseUrl}/otp/public/verify {requestId, otp}                                      -> {accessToken}
 */
/** Which Slide widget a client uses: the mobile apps, or the web portal + sales CRM. */
export type OtpClientKind = 'app' | 'web';

export type OtpConfig = {
  provider: OtpProviderName;
  /** Providers whose tokens this server verifies right now (active + legacy MSG91). */
  accepts: OtpProviderName[];
  otpLength: number;
  resendSeconds: number;
  slide?: { baseUrl: string; widgetId: string; tokenAuth: string };
};

const MSG91_LENGTH = 4; // every MSG91 widget in use is configured for 4 digits
const MSG91_RESEND_SECONDS = 30;
const CACHE_OK_MS = 10 * 60_000;
const CACHE_FAIL_MS = 30_000;
const FETCH_TIMEOUT_MS = 4_000;

type SlideSettings = { otpLength: number; resendSeconds: number };
const cache = new Map<string, { at: number; ttl: number; value: SlideSettings }>();

/** Depth-limited search for a numeric setting whose key matches `re` (field names are undocumented). */
export function findNumber(
  obj: unknown,
  re: RegExp,
  min: number,
  max: number,
  depth = 0,
): number | null {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    if (re.test(k) && Number.isInteger(n) && n >= min && n <= max) return n;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const n = findNumber(v, re, min, max, depth + 1);
    if (n !== null) return n;
  }
  return null;
}

const widgetIdFor = (client: OtpClientKind): string =>
  (client === 'web' ? env.SLIDE_WEB_WIDGET_ID : env.SLIDE_APP_WIDGET_ID) ?? '';

async function slideSettings(widgetId: string): Promise<SlideSettings> {
  const fallback = { otpLength: env.SLIDE_OTP_LENGTH, resendSeconds: env.SLIDE_RESEND_SECONDS };
  const hit = cache.get(widgetId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  try {
    const url =
      `${env.SLIDE_API_BASE_URL.replace(/\/+$/, '')}/otp/public/widget-config/` +
      `${encodeURIComponent(widgetId)}?tokenAuth=${encodeURIComponent(env.SLIDE_CLIENT_TOKEN ?? '')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const value = {
      otpLength:
        findNumber(body, /(otp|code).*(length|digits)|^(length|digits)$/i, 4, 8) ??
        fallback.otpLength,
      resendSeconds:
        findNumber(body, /resend.*(sec|cooldown|after|delay)|cooldown/i, 10, 300) ??
        fallback.resendSeconds,
    };
    cache.set(widgetId, { at: Date.now(), ttl: CACHE_OK_MS, value });
    return value;
  } catch (err) {
    console.error(
      `[otp-config] Slide widget-config unavailable, using env defaults: ${String(err)}`,
    );
    cache.set(widgetId, { at: Date.now(), ttl: CACHE_FAIL_MS, value: fallback });
    return fallback;
  }
}

/** Test hook: forget the cached Slide settings. */
export function resetOtpConfigCache(): void {
  cache.clear();
}

export async function getOtpConfig(client: OtpClientKind = 'app'): Promise<OtpConfig> {
  const base = { provider: env.OTP_PROVIDER, accepts: acceptedProviders() };
  if (env.OTP_PROVIDER !== 'slide') {
    return { ...base, otpLength: MSG91_LENGTH, resendSeconds: MSG91_RESEND_SECONDS };
  }
  const widgetId = widgetIdFor(client);
  const settings = await slideSettings(widgetId);
  return {
    ...base,
    ...settings,
    slide: {
      baseUrl: env.SLIDE_API_BASE_URL.replace(/\/+$/, ''),
      widgetId,
      tokenAuth: env.SLIDE_CLIENT_TOKEN ?? '',
    },
  };
}
