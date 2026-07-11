import { env } from '@/config/env.js';
import {
  generateCatalogImage as generateViaGemini,
  type GenerateInput,
  type GenerateOutput,
} from '@/shared/gemini.js';
import { generateCatalogImageViaOpenRouter } from '@/shared/openrouter.js';
import { generateCatalogImageViaVertex } from '@/shared/vertex-image.js';

/**
 * Provider-agnostic entry point for AI catalog image generation. Routes to
 * whichever backend `env.AI_IMAGE_PROVIDER` selects. Both providers run the
 * same Gemini image model under the hood (direct AI Studio vs. via OpenRouter),
 * so output quality should be identical — the switch is only about how we pay
 * and authenticate.
 *
 * Adding a new provider: implement a function with the same shape, branch on
 * the env value here.
 */
export async function generateCatalogImage(input: GenerateInput): Promise<GenerateOutput> {
  switch (env.AI_IMAGE_PROVIDER) {
    case 'vertex':
      return generateCatalogImageViaVertex(input);
    case 'openrouter':
      return generateCatalogImageViaOpenRouter(input);
    case 'gemini':
    default:
      return generateViaGemini(input);
  }
}

/**
 * The image provider + model generateCatalogImage() uses right now, derived from
 * env.AI_IMAGE_PROVIDER. Exposed for per-request logging so you can see whether a
 * given generation hit gemini (AI Studio), vertex, or openrouter.
 */
export function activeImageProvider(): {
  provider: 'gemini' | 'vertex' | 'openrouter';
  model: string;
} {
  switch (env.AI_IMAGE_PROVIDER) {
    case 'vertex':
      return { provider: 'vertex', model: 'gemini-2.5-flash-image' };
    case 'openrouter':
      return { provider: 'openrouter', model: env.OPENROUTER_MODEL };
    case 'gemini':
    default:
      return { provider: 'gemini', model: 'gemini-2.5-flash-image' };
  }
}

export type { GenerateInput, GenerateOutput };
