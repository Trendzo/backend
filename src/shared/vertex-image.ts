import { GoogleGenAI } from '@google/genai';
import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { withRetry } from '@/shared/retry.js';
import {
  composePrompt,
  fetchReferenceImage,
  type GenerateInput,
  type GenerateOutput,
} from '@/shared/gemini.js';

/**
 * Vertex AI provider for AI catalog image generation. Same Gemini image model
 * (`gemini-2.5-flash-image`, Nano Banana) as the direct AI Studio path, but
 * billed through Google Cloud / Vertex — used when the AI Studio + OpenRouter
 * free tiers are exhausted. Auth is Application Default Credentials: set
 * GOOGLE_APPLICATION_CREDENTIALS to a service-account key JSON with the
 * "Vertex AI User" role on GOOGLE_CLOUD_PROJECT.
 *
 * Shares composePrompt / fetchReferenceImage with the AI Studio provider so the
 * two stay identical; only the client (Vertex vs API key) differs.
 */

const MODEL = 'gemini-2.5-flash-image';

let client: GoogleGenAI | null = null;
/** Shared Vertex client (also used by the virtual try-on path). */
export function getVertexClient(): GoogleGenAI {
  if (!env.GOOGLE_CLOUD_PROJECT) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'Vertex not configured (missing GOOGLE_CLOUD_PROJECT). Also set GOOGLE_APPLICATION_CREDENTIALS.',
    );
  }
  if (!client) {
    client = new GoogleGenAI({
      vertexai: true,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.GOOGLE_CLOUD_LOCATION,
    });
  }
  return client;
}

export async function generateCatalogImageViaVertex(input: GenerateInput): Promise<GenerateOutput> {
  const ai = getVertexClient();

  const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = [];
  for (const url of input.referenceImageUrls) {
    const ref = await fetchReferenceImage(url);
    parts.push({ inlineData: { data: ref.data, mimeType: ref.mimeType } });
  }
  parts.push({ text: composePrompt(input) });

  let response;
  try {
    response = await withRetry(() =>
      ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts }],
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Vertex error';
    throw new AppError(502, ErrorCode.InternalError, `Vertex call failed: ${message}`);
  }

  const candidateParts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of candidateParts) {
    const inline = (part as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data && inline.mimeType) {
      return {
        base64: inline.data,
        mimeType: inline.mimeType,
        thirdPartyRequestId: response.responseId ?? `vertex_${Date.now()}`,
        costPaise: null,
      };
    }
  }

  throw new AppError(502, ErrorCode.InternalError, 'Vertex returned no image data.');
}
