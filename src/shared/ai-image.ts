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

export type { GenerateInput, GenerateOutput };
