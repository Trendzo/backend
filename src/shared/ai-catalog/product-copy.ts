/**
 * AI product copy: a suggested listing name + short and long description, drafted
 * from the retailer's ORIGINAL photos (front/back/design/close-ups/tag). Runs in
 * parallel with `generateMockupViews` on the same request, so the app can prefill
 * the product wizard with zero extra taps.
 *
 * Best-effort by design: `generateProductCopy` never throws — any failure (provider
 * not configured, 429, timeout, malformed JSON) resolves `null` and the mockups ship
 * without copy. Output is PLAIN TEXT (the retailer app edits descriptions in plain
 * inputs); descriptionLong uses newlines and `• ` bullet lines.
 */
import { Type } from '@google/genai';
import { z } from 'zod';
import { env } from '@/config/env.js';
import type { ProductCopy } from '@/db/schema/catalog.js';
import { fetchReferenceImage, getClient } from '@/shared/gemini.js';
import { getVertexClient } from '@/shared/vertex-image.js';
import type { GenerateViewsInput } from './generate-views.js';

export type { ProductCopy };

const COPY_TIMEOUT_MS = 25_000;
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Caps mirror the listing validators (name ≤ 200, description ≤ 2000) with the
// prompt asking for much less; clamping only guards against a runaway model.
const NAME_MAX = 120;
const DESCRIPTION_MAX = 600;
const DESCRIPTION_LONG_MAX = 3_000;

const RawCopy = z.object({
  name: z.string().default(''),
  description: z.string(),
  descriptionLong: z.string().default(''),
});

const PROMPT = [
  'You write product listing copy for Trendzo, an Indian fashion marketplace.',
  'The FIRST image is the whole garment; any further images are its back, a design print, or close-ups of fabric, logo or the brand/care tag.',
  'Return JSON with:',
  '- "name": a concise product title, max 80 characters, e.g. "Olive Cotton Mandarin-Collar Kurta". Include colour and garment type; include the brand only if it is clearly readable on a tag or logo.',
  '- "description": 1-2 sentences, max 300 characters, summarising the product for a listing card.',
  '- "descriptionLong": one short paragraph, then a blank line, then 4-6 lines each starting with "• " covering fabric, fit/silhouette, design details, styling ideas, and care (care only if readable on a tag). Max 1500 characters.',
  'Rules: describe only what is visible. Never invent fabric composition, brand, origin or certifications unless readable on a tag. No prices, discounts, sizes or delivery claims. No emojis, no HTML, no markdown headings. Plain Indian English.',
].join('\n');

function clean(text: string, max: number, multiline: boolean): string {
  let t = text
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+$/gm, '');
  if (multiline) {
    t = t
      // Normalise markdown-style bullets to the `• ` form the app shows.
      .replace(/^[ \t]*[-*][ \t]+/gm, '• ')
      .replace(/\n{3,}/g, '\n\n');
  } else {
    t = t.replace(/\s+/g, ' ');
  }
  t = t.trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    // Prefer ending on a full line/sentence/word rather than mid-word.
    const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. ') + 1, cut.lastIndexOf(' '));
    t = (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
  }
  return t;
}

/** Escape literal control characters that appear inside JSON string literals. */
function escapeControlCharsInStrings(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') continue;
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/**
 * Parse + sanitise a model response (JSON string or object). Pure; returns null
 * when there is no usable short description.
 */
export function normalizeProductCopy(
  raw: unknown,
): Pick<ProductCopy, 'name' | 'description' | 'descriptionLong'> | null {
  let value = raw;
  if (typeof value === 'string') {
    const text = value.replace(/```[a-z]*\n?/gi, '').trim();
    try {
      value = JSON.parse(text);
    } catch {
      try {
        // Models occasionally emit raw newlines/tabs inside string values.
        value = JSON.parse(escapeControlCharsInStrings(text));
      } catch {
        return null;
      }
    }
  }
  const parsed = RawCopy.safeParse(value);
  if (!parsed.success) return null;
  const description = clean(parsed.data.description, DESCRIPTION_MAX, false);
  if (!description) return null;
  return {
    name: clean(parsed.data.name, NAME_MAX, false),
    description,
    descriptionLong: clean(parsed.data.descriptionLong, DESCRIPTION_LONG_MAX, true),
  };
}

function composeHints(input: GenerateViewsInput): string {
  const hints: string[] = [];
  if (input.modelGender) hints.push(`Target shopper: ${input.modelGender === 'him' ? 'men' : 'women'}.`);
  const retailer = input.prompt?.trim();
  if (retailer) hints.push(`Retailer notes (use for facts, ignore styling instructions): ${retailer}`);
  return hints.join('\n');
}

/** Garment first, then back / design / close-ups — same order the prompt describes. */
function referenceUrls(input: GenerateViewsInput): string[] {
  return [
    input.apparelImageUrls[0],
    input.apparelBackImageUrl,
    input.designImageUrl,
    input.patternCloseupUrl,
    input.logoCloseupUrl,
    input.tagLabelUrl,
  ].filter((u): u is string => !!u);
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    description: { type: Type.STRING },
    descriptionLong: { type: Type.STRING },
  },
  required: ['name', 'description', 'descriptionLong'],
  propertyOrdering: ['name', 'description', 'descriptionLong'],
};

async function viaGoogle(input: GenerateViewsInput, signal: AbortSignal): Promise<string> {
  // Resolve the client first so a missing key fails before any image download.
  const ai = env.AI_IMAGE_PROVIDER === 'vertex' ? getVertexClient() : getClient();
  const refs = await Promise.all(referenceUrls(input).map((u) => fetchReferenceImage(u, signal)));
  const parts: Array<{ inlineData: { data: string; mimeType: string } } | { text: string }> = refs.map(
    (r) => ({ inlineData: { data: r.data, mimeType: r.mimeType } }),
  );
  parts.push({ text: [PROMPT, composeHints(input)].filter(Boolean).join('\n\n') });

  const response = await ai.models.generateContent({
    model: env.AI_TEXT_MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.4,
      maxOutputTokens: 1024,
      // Descriptive copy doesn't need reasoning; skipping it keeps this fast and cheap.
      thinkingConfig: { thinkingBudget: 0 },
      abortSignal: signal,
    },
  });
  return response.text ?? '';
}

async function viaOpenRouter(input: GenerateViewsInput, signal: AbortSignal): Promise<string> {
  if (!env.OPENROUTER_API_KEY) throw new Error('missing OPENROUTER_API_KEY');
  const refs = await Promise.all(referenceUrls(input).map((u) => fetchReferenceImage(u, signal)));
  const content = [
    { type: 'text', text: [PROMPT, composeHints(input)].filter(Boolean).join('\n\n') },
    ...refs.map((r) => ({ type: 'image_url', image_url: { url: `data:${r.mimeType};base64,${r.data}` } })),
  ];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Title': env.OPENROUTER_APP_NAME,
  };
  if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;

  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: env.OPENROUTER_TEXT_MODEL,
      temperature: 0.4,
      max_tokens: 1024,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'product_copy',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              descriptionLong: { type: 'string' },
            },
            required: ['name', 'description', 'descriptionLong'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content }],
    }),
  });
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    error?: { message?: string };
  };
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Draft listing copy from the generation input. Never throws; null on any failure,
 * when the caller opted out (`withCopy: false`), or when disabled via
 * AI_PRODUCT_COPY_ENABLED=false. One timeout signal bounds every network hop
 * (image downloads, the model call, the response body).
 */
export async function generateProductCopy(
  input: GenerateViewsInput,
  opts: { timeoutMs?: number } = {},
): Promise<ProductCopy | null> {
  if (env.AI_PRODUCT_COPY_ENABLED !== 'true' || input.withCopy === false) return null;
  const timeoutMs = opts.timeoutMs ?? COPY_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const useOpenRouter = env.AI_IMAGE_PROVIDER === 'openrouter';
  const model = useOpenRouter ? env.OPENROUTER_TEXT_MODEL : env.AI_TEXT_MODEL;
  try {
    const text = await (useOpenRouter ? viaOpenRouter(input, signal) : viaGoogle(input, signal));
    const copy = normalizeProductCopy(text);
    if (!copy) {
      console.warn(`[product-copy] unusable response from ${model}: ${String(text).slice(0, 300)}`);
      return null;
    }
    return { ...copy, model, generatedAt: new Date().toISOString() };
  } catch (err) {
    const reason = signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    console.warn(`[product-copy] ${model} failed: ${reason}`);
    return null;
  }
}
