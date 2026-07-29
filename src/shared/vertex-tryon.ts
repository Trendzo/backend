import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import { getVertexClient } from '@/shared/vertex-image.js';
import { fetchReferenceImage } from '@/shared/gemini.js';

/**
 * Customer virtual try-on via Vertex AI's dedicated model `virtual-try-on-001`
 * (recontextImage): given a person photo and one garment product photo, returns
 * an image of that person wearing the garment. One garment per call — layering
 * (top then bottom) is done by the caller feeding each result back in as the
 * new "person". Auth = the shared Vertex client (see vertex-image.ts).
 */

/**
 * KNOWN GAP — a blocked garment is reported to the shopper as a retryable error.
 *
 * Vertex runs a safety filter over BOTH input images and rejects the whole call
 * with a 400 when either one trips it. Observed on a live swimwear listing
 * (2026-07-29, `lst_b21f426733804b9098f8dc28c1a807d8`); isolating the two inputs
 * showed the person photo was fine and the garment alone was the trigger:
 *
 *     person  + garment  -> 400 safety filter
 *     person  + person   -> 200
 *     garment + garment  -> 400 safety filter
 *
 * The body Vertex returns says exactly that:
 *
 *     HTTP 400 INVALID_ARGUMENT
 *     "Image editing failed with the following error: The input image contains
 *      content that has been blocked by your current safety filter threshold.
 *      Support codes: 43188360;"
 *
 * WE NEVER SEE IT. `@google/genai` collapses any non-2xx inside `runFetch` into
 * the string "Non-retryable exception Bad Request sending request" and discards
 * the response body — `Object.getOwnPropertyNames(err)` is just
 * `['stack', 'message']`. So the catch below cannot tell a blocked garment from
 * a transient provider fault, and the route maps both to the 502
 * "Try-on failed — please try again."
 *
 * That message is wrong for this case and expensive: the shopper is invited to
 * retry something that can never succeed, and every retry is a billable call.
 *
 * TO FIX: issue this request over raw REST (google-auth-library for an ADC
 * access token, then POST
 * `{location}-aiplatform.googleapis.com/v1/projects/{p}/locations/{l}/publishers/google/models/virtual-try-on-001:predict`
 * with `instances[0].personImage.image.bytesBase64Encoded` +
 * `instances[0].productImages[0].image.bytesBase64Encoded`). That surfaces the
 * body, after which /safety filter|blocked/i can map to a TERMINAL
 * 422 InvalidState ("this item's photo can't be used for try-on") while 429 /
 * RESOURCE_EXHAUSTED keeps its retryable 503. Switching transport is not a
 * preference here — the SDK structurally cannot carry the reason.
 *
 * Worth pairing with a check at publish time so the RETAILER learns their photo
 * will not support try-on when they upload it, not the shopper mid-try-on.
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
    response = await ai.models.recontextImage({
      model: VTO_MODEL,
      source: {
        personImage: { imageBytes: person.data, mimeType: person.mimeType },
        productImages: [
          { productImage: { imageBytes: garment.data, mimeType: garment.mimeType } },
        ],
      },
      config: { numberOfImages: 1, outputMimeType: 'image/png' },
    });
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
