import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { getVertexClient } from '@/shared/vertex-image.js';
import { fetchReferenceImage } from '@/shared/gemini.js';
import { withRetry } from '@/shared/retry.js';

/**
 * Customer virtual try-on via Vertex AI's dedicated model `virtual-try-on-001`
 * (recontextImage): given a person photo and one garment product photo, returns
 * an image of that person wearing the garment. One garment per call — layering
 * (top then bottom) is done by the caller feeding each result back in as the
 * new "person". Auth = the shared Vertex client (see vertex-image.ts).
 */

const VTO_MODEL = 'virtual-try-on-001';

export async function virtualTryOn(
  personImageUrl: string,
  garmentImageUrl: string,
): Promise<{ base64: string; mimeType: string }> {
  const ai = getVertexClient();
  const person = await fetchReferenceImage(personImageUrl);
  const garment = await fetchReferenceImage(garmentImageUrl);

  let response;
  try {
    response = await withRetry(() =>
      ai.models.recontextImage({
        model: VTO_MODEL,
        source: {
          personImage: { imageBytes: person.data, mimeType: person.mimeType },
          productImages: [
            { productImage: { imageBytes: garment.data, mimeType: garment.mimeType } },
          ],
        },
        config: { numberOfImages: 1, outputMimeType: 'image/png' },
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Vertex VTO error';
    throw new AppError(502, ErrorCode.InternalError, `Virtual try-on failed: ${message}`);
  }

  const img = response.generatedImages?.[0]?.image;
  if (!img?.imageBytes) {
    throw new AppError(502, ErrorCode.InternalError, 'Virtual try-on returned no image.');
  }
  return { base64: img.imageBytes, mimeType: img.mimeType ?? 'image/png' };
}
