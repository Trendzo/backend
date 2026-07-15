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
  // retries (a retry on a 429/500 can bill for an extra generated image).
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
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: { imageConfig: { aspectRatio: CATALOG_IMAGE_ASPECT_RATIO } },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Gemini error';
    throw new AppError(502, ErrorCode.InternalError, `Gemini call failed: ${message}`);
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
