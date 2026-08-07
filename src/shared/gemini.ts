import { GoogleGenAI } from '@google/genai';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';

/**
 * Google Gemini provider for AI catalog image generation. Uses
 * `gemini-2.5-flash-image` (Nano Banana), AI Studio free tier — natively
 * accepts image parts + text in a single `generateContent` call.
 *
 * One submission = one call here. The route layer manages status transitions,
 * uploads the returned image to Cloudinary, and records the third-party
 * request id for the audit trail.
 */

const MODEL = 'gemini-2.5-flash-image';

// Rate-limit (429) retry. Gemini's low/free image tiers throttle easily,
// especially when a submission fans out several image calls at once
// (IMAGE_GEN_CONCURRENCY). A single transient 429 otherwise fails the whole
// submission ("Gemini call failed: ... Too Many Requests"). Retrying is safe:
// a 429 means the call was rejected — no image generated, no billing. Delays
// are bounded so total time stays inside the app's 120s request timeout.
const RATE_LIMIT_MAX_ATTEMPTS = 2;
const RATE_LIMIT_BASE_DELAY_MS = 1200;
const RATE_LIMIT_MAX_DELAY_MS = 8000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True when a thrown Gemini SDK error is a 429 / rate-limit / quota rejection. */
function isRateLimitError(err: unknown): boolean {
  const anyErr = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 429 || status === '429') return true;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit')
  );
}

/**
 * Server-suggested retry delay from a 429 body (RetryInfo.retryDelay, e.g.
 * "34s"), in ms. Null when the SDK wrapper stripped the body.
 */
function parseRetryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(msg);
  const secs = m?.[1];
  return secs ? Math.round(parseFloat(secs) * 1000) : null;
}

/**
 * True when the 429 names a PER-DAY quota (QuotaFailure violation id contains
 * "PerDay"). Retrying inside one request is pointless then — the bucket resets
 * at midnight PT, not within our timeout.
 */
function isDailyQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('perday') || msg.includes('per day');
}

/**
 * The wrapper text ("Retryable HTTP Error: Too Many Requests") hides which
 * quota tripped and on which project. Dump every field the SDK error carries so
 * a production 429 names its cause in one log line.
 */
function logGeminiErrorDetail(err: unknown, attempt: number): void {
  const anyErr = err as {
    status?: unknown;
    code?: unknown;
    message?: string;
    cause?: unknown;
  };
  // eslint-disable-next-line no-console
  console.error('[gemini] error detail', {
    attempt,
    status: anyErr?.status ?? anyErr?.code,
    message: anyErr?.message,
    cause:
      anyErr?.cause instanceof Error
        ? { message: anyErr.cause.message, cause: String((anyErr.cause as Error & { cause?: unknown }).cause ?? '') }
        : anyErr?.cause,
  });
}

/**
 * All catalog mockups are generated 3:4 portrait (Instagram feed format).
 * Must be set via the API's imageConfig — prompt-text hints alone are ignored
 * when reference images are attached (the model then mirrors the reference
 * photo's aspect ratio, e.g. 9:16 phone shots).
 */
export const CATALOG_IMAGE_ASPECT_RATIO = '3:4';

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'AI provider not configured (missing GEMINI_API_KEY).',
    );
  }
  // httpOptions.retryOptions.attempts = 1 → single attempt, NO automatic SDK
  // retries. We control retries ourselves (429-only, see generateCatalogImage):
  // the SDK would also retry 5xx/ambiguous responses, which could bill for an
  // extra generated image. A 429 is safe to retry — the request was rejected,
  // so no image was produced and nothing was billed.
  if (!client)
    client = new GoogleGenAI({
      apiKey: env.GEMINI_API_KEY,
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  return client;
}

export type GenerateInput = {
  prompt: string;
  mode: 'with_model' | 'without_model';
  referenceImageUrls: string[];
  posePreferences?: string[];
  revisionNotes?: string | null;
};

export type GenerateOutput = {
  base64: string;
  mimeType: string;
  thirdPartyRequestId: string;
  costPaise: number | null;
};

export function composePrompt(input: GenerateInput): string {
  const modeLine =
    input.mode === 'with_model'
      ? 'Place the garment on a synthetic human model in a studio setting.'
      : 'Show the product on its own — flat-lay or invisible-mannequin — on a clean studio background.';

  const poseLine =
    input.posePreferences && input.posePreferences.length > 0
      ? `Pose / framing preferences: ${input.posePreferences.join(', ')}.`
      : '';

  const revisionLine = input.revisionNotes
    ? `Revision instructions (override conflicting earlier choices): ${input.revisionNotes}`
    : '';

  return [
    'You are generating a polished, listing-ready product photograph for an apparel marketplace.',
    modeLine,
    poseLine,
    `Retailer instructions: ${input.prompt}`,
    revisionLine,
    'Return a single high-resolution image (3:4 portrait). Output must be an original artistic composition with a clean uncluttered frame, no text, no overlays.',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function fetchReferenceImage(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError(
      502,
      ErrorCode.InternalError,
      `Failed to fetch reference image (${res.status}): ${url}`,
    );
  }
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString('base64'), mimeType };
}

export async function generateCatalogImage(input: GenerateInput): Promise<GenerateOutput> {
  const ai = getClient();

  const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];
  for (const url of input.referenceImageUrls) {
    const ref = await fetchReferenceImage(url);
    parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType } });
  }
  parts.push({ text: composePrompt(input) });

  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts }],
        config: { imageConfig: { aspectRatio: CATALOG_IMAGE_ASPECT_RATIO } },
      });
      break;
    } catch (err) {
      logGeminiErrorDetail(err, attempt);
      // Retry only on rate limits (safe: nothing generated/billed). Everything
      // else fails fast — including per-day quota exhaustion, where any retry
      // inside this request is guaranteed to fail again.
      if (isRateLimitError(err)) {
        if (isDailyQuotaError(err)) {
          throw new AppError(
            502,
            ErrorCode.InternalError,
            'Gemini daily image quota exhausted for this API key — switch AI_IMAGE_PROVIDER (openrouter/vertex) or use a key from a paid-tier project.',
          );
        }
        if (attempt < RATE_LIMIT_MAX_ATTEMPTS) {
          // Prefer the server's suggested delay when the body survived the SDK
          // wrapper; cap it so the whole submission stays inside the request
          // timeout.
          const backoff =
            RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
          const delay = Math.min(parseRetryDelayMs(err) ?? backoff, RATE_LIMIT_MAX_DELAY_MS);
          console.warn(
            `[gemini] 429 rate limit (attempt ${attempt}/${RATE_LIMIT_MAX_ATTEMPTS}) — retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
      }
      const message = err instanceof Error ? err.message : 'Unknown Gemini error';
      throw new AppError(502, ErrorCode.InternalError, `Gemini call failed: ${message}`);
    }
  }

  const candidate = response.candidates?.[0];
  const candidateParts = candidate?.content?.parts ?? [];

  for (const part of candidateParts) {
    const inline = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data && inline.mimeType) {
      return {
        base64: inline.data,
        mimeType: inline.mimeType,
        thirdPartyRequestId: response.responseId ?? `gemini_${Date.now()}`,
        costPaise: null,
      };
    }
  }

  throw new AppError(502, ErrorCode.InternalError, 'Gemini returned no image data.');
}
