/**
 * Shared multi-angle mockup generation. Extracted from the ai-catalog-beta
 * controller so BOTH the synchronous submission flow and the async bulk-mockup
 * queue worker generate identically. Output is unchanged from the original.
 *
 * Optional design-print phase, then one shot per angle preset (with real-back-
 * photo handling). Stateless.
 */
import { generateCatalogImage } from '@/shared/ai-image.js';
import { uploadObject } from '@/shared/storage/index.js';
import { mapLimit } from '@/shared/concurrency.js';
import { MODEL_POSES, PRODUCT_ANGLES } from './angles.js';

// Max image-gen calls in flight per job. Vertex Dynamic Shared Quota 429s on
// bursts, so cap the angle fan-out instead of firing every view at once.
export const IMAGE_GEN_CONCURRENCY = 2;

/** Everything `generateMockupViews` needs — a subset of the beta SubmissionBody,
 *  declared locally so this shared helper doesn't depend on any module's zod. */
export interface GenerateViewsInput {
  mode: 'with_model' | 'without_model';
  prompt?: string | undefined;
  apparelImageUrls: string[];
  apparelBackImageUrl?: string | undefined;
  designImageUrl?: string | undefined;
  patternCloseupUrl?: string | undefined;
  logoCloseupUrl?: string | undefined;
  tagLabelUrl?: string | undefined;
  modelGender?: 'him' | 'her' | undefined;
  only?: string[] | undefined;
}

/** Generate one image and store it in object storage; returns the URL. */
export async function genAndUpload(
  input: {
    prompt: string;
    mode: 'with_model' | 'without_model';
    referenceImageUrls: string[];
    posePreferences?: string[];
  },
  folder: string,
): Promise<string> {
  const gen = await generateCatalogImage(input);
  const buffer = Buffer.from(gen.base64, 'base64');
  const uploaded = await uploadObject(buffer, {
    folder,
    resourceType: 'image',
    contentType: 'image/png',
  });
  return uploaded.url;
}

export async function generateMockupViews(
  body: GenerateViewsInput,
  folder: string,
): Promise<{ printedUrl: string | null; views: { name: string; url: string }[] }> {
  const basePrompt = body.prompt?.trim() ?? '';

  // Optional close-up references (fabric pattern, logo, brand tag). Appended to
  // every view's reference set so the model reproduces those exact details.
  const detailRefs: string[] = [];
  const detailWhat: string[] = [];
  if (body.patternCloseupUrl) {
    detailRefs.push(body.patternCloseupUrl);
    detailWhat.push('fabric pattern/texture');
  }
  if (body.logoCloseupUrl) {
    detailRefs.push(body.logoCloseupUrl);
    detailWhat.push('logo/monogram');
  }
  if (body.tagLabelUrl) {
    detailRefs.push(body.tagLabelUrl);
    detailWhat.push('brand tag/label');
  }
  const detailNote = detailWhat.length
    ? ` The additional close-up reference image(s) show the garment's ${detailWhat.join(', ')} — reproduce those details faithfully; the FIRST reference is the whole garment.`
    : '';

  // Model gender note — only meaningful for on-model shots.
  const modelNote =
    body.mode === 'with_model' && body.modelGender
      ? ` The model is a ${body.modelGender === 'him' ? 'man' : 'woman'}.`
      : '';

  // Optional design-print phase: composite the design onto the plain apparel,
  // then shoot every angle off that printed product for consistency.
  let printedUrl: string | null = null;
  let baseRefs = body.apparelImageUrls;
  if (body.designImageUrl) {
    printedUrl = await genAndUpload(
      {
        prompt: [
          'Print the graphic in the LAST reference image realistically onto the front of',
          'the plain garment in the FIRST reference image, following the fabric folds and',
          'lighting so it looks physically applied. Keep the garment colour, shape and',
          `fabric unchanged. ${basePrompt}`,
        ]
          .join(' ')
          .trim(),
        mode: body.mode,
        referenceImageUrls: [...body.apparelImageUrls, body.designImageUrl],
      },
      folder,
    );
    baseRefs = [printedUrl];
  }

  const angles = (body.mode === 'without_model' ? PRODUCT_ANGLES : MODEL_POSES).filter(
    (a) => !body.only || body.only.length === 0 || body.only.includes(a.name),
  );
  // Back views render from the real back photo when one was supplied and no
  // design was printed — otherwise the model just echoes the front image. The
  // preset back poses assume "the back is blank" (right for the front-only
  // design case); when a real back photo IS the reference, override that pose.
  const backPose = (name: string) =>
    name === 'model-back'
      ? 'full-body view from BEHIND showing the back of the garment, neutral seamless studio backdrop, professional fashion lighting; reproduce the garment back exactly as in the reference image — colour, fabric, cut, seams, and any back graphic'
      : 'back view, ghost-mannequin / invisible-mannequin, centered, clean seamless white background, soft even studio lighting; reproduce the garment back exactly as in the reference image — colour, fabric, cut, seams, and any back graphic';

  const views = await mapLimit(angles, IMAGE_GEN_CONCURRENCY, async (a) => {
    const isBackView = a.name === 'back' || a.name === 'model-back';
    const useBack = isBackView && !!body.apparelBackImageUrl && !body.designImageUrl;
    const mainRef = useBack ? [body.apparelBackImageUrl as string] : baseRefs;
    const url = await genAndUpload(
      {
        prompt: `${basePrompt || 'Polished, listing-ready product photograph.'}${detailNote}${modelNote}`.trim(),
        mode: body.mode,
        referenceImageUrls: [...mainRef, ...detailRefs],
        posePreferences: [useBack ? backPose(a.name) : a.pose],
      },
      folder,
    );
    return { name: a.name, url };
  });

  return { printedUrl, views };
}
