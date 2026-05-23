import { env } from '@/config/env.js';
import { AppError, ErrorCode } from '@/shared/errors/app-error.js';
import type { GenerateInput, GenerateOutput } from '@/shared/gemini.js';

/**
 * OpenRouter image-generation provider. Uses the OpenAI-compatible
 * `/chat/completions` endpoint with `modalities: ['image', 'text']`. Targets
 * `google/gemini-2.5-flash-image-preview` by default (the same Nano Banana
 * model the direct Gemini provider uses), so retailers see equivalent output
 * regardless of which backend the platform is wired to.
 *
 * Why this exists: the direct Gemini AI Studio path requires a billing card
 * on file even for the free tier; OpenRouter bills against an existing
 * OpenRouter balance and removes that friction.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function composePrompt(input: GenerateInput): string {
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

async function fetchAsDataUri(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new AppError(
      502,
      ErrorCode.InternalError,
      `Failed to fetch reference image (${res.status}): ${url}`,
    );
  }
  const mime = res.headers.get('content-type') ?? 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
}

type OpenRouterImagePart = { type: 'image_url'; image_url: { url: string } };
type OpenRouterTextPart = { type: 'text'; text: string };
type OpenRouterResponse = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      images?: Array<{ type?: string; image_url?: { url?: string } }>;
    };
  }>;
  error?: { code?: number | string; message?: string };
};

export async function generateCatalogImageViaOpenRouter(
  input: GenerateInput,
): Promise<GenerateOutput> {
  if (!env.OPENROUTER_API_KEY) {
    throw new AppError(
      503,
      ErrorCode.InternalError,
      'AI provider not configured (missing OPENROUTER_API_KEY).',
    );
  }

  const content: Array<OpenRouterTextPart | OpenRouterImagePart> = [
    { type: 'text', text: composePrompt(input) },
  ];
  for (const url of input.referenceImageUrls) {
    const dataUri = await fetchAsDataUri(url);
    content.push({ type: 'image_url', image_url: { url: dataUri } });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': env.OPENROUTER_APP_NAME,
  };
  if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        // Required for image-output models on OpenRouter — without this, the
        // model returns an empty message with content=null because OpenRouter
        // defaults to text-only modality.
        modalities: ['image', 'text'],
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown OpenRouter error';
    throw new AppError(502, ErrorCode.InternalError, `OpenRouter call failed: ${message}`);
  }

  let json: OpenRouterResponse;
  try {
    json = (await res.json()) as OpenRouterResponse;
  } catch {
    throw new AppError(
      502,
      ErrorCode.InternalError,
      `OpenRouter returned non-JSON response (HTTP ${res.status}).`,
    );
  }

  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new AppError(502, ErrorCode.InternalError, `OpenRouter error: ${msg}`);
  }

  const images = json.choices?.[0]?.message?.images ?? [];
  const dataUri = images[0]?.image_url?.url;
  if (!dataUri || !dataUri.startsWith('data:')) {
    // eslint-disable-next-line no-console
    console.error('[openrouter] no image in response. Raw:', JSON.stringify(json).slice(0, 2000));
    const textOut = json.choices?.[0]?.message?.content;
    const hint = typeof textOut === 'string' && textOut.length > 0 ? ` Model said: "${textOut.slice(0, 200)}"` : '';
    throw new AppError(502, ErrorCode.InternalError, `OpenRouter returned no image data.${hint}`);
  }

  // dataUri format: data:image/png;base64,<base64>
  const commaIdx = dataUri.indexOf(',');
  const header = dataUri.slice(5, commaIdx); // e.g. "image/png;base64"
  const mimeType = header.split(';')[0] ?? 'image/png';
  const base64 = dataUri.slice(commaIdx + 1);

  return {
    base64,
    mimeType,
    thirdPartyRequestId: json.id ?? `openrouter_${Date.now()}`,
    costPaise: null,
  };
}
