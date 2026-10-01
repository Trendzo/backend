import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Gemini from '@/shared/gemini.js';

const { generateContent, fetchReferenceImage } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  fetchReferenceImage: vi.fn(async (_url: string, _signal?: AbortSignal) => ({
    data: 'eA==',
    mimeType: 'image/jpeg',
  })),
}));
vi.mock('@/shared/gemini.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Gemini>()),
  getClient: () => ({ models: { generateContent } }),
  fetchReferenceImage,
}));

import { env } from '@/config/env.js';
import { generateProductCopy, normalizeProductCopy } from './product-copy.js';

describe('normalizeProductCopy', () => {
  it('parses a JSON string and keeps bullet lines', () => {
    const out = normalizeProductCopy(
      JSON.stringify({
        name: 'Olive Cotton Kurta',
        description: 'A relaxed olive kurta.',
        descriptionLong: 'Easy everyday kurta.\n\n• Soft cotton\n• Straight fit',
      }),
    );
    expect(out).toEqual({
      name: 'Olive Cotton Kurta',
      description: 'A relaxed olive kurta.',
      descriptionLong: 'Easy everyday kurta.\n\n• Soft cotton\n• Straight fit',
    });
  });

  it('strips emoji the model slipped in, keeping bullets and punctuation', () => {
    const out = normalizeProductCopy({
      name: '✨ Olive Kurta 🔥',
      description: 'Breezy olive kurta ✅ for summer 🇮🇳 – easy fit.',
      descriptionLong: 'Easy everyday kurta 👌🏽\n\n• ✨ Soft cotton\n- 🧵 Straight fit',
    });
    expect(out).toEqual({
      name: 'Olive Kurta',
      description: 'Breezy olive kurta for summer – easy fit.',
      descriptionLong: 'Easy everyday kurta\n\n• Soft cotton\n• Straight fit',
    });
  });

  it('strips code fences, HTML, tolerates raw newlines in strings, normalises bullets', () => {
    const out = normalizeProductCopy(
      '```json\n{"name":"<b>Tee</b>","description":"<p>Black   tee.</p>","descriptionLong":"Intro\n\n\n\n- one\n* two"}\n```',
    );
    expect(out?.name).toBe('Tee');
    expect(out?.description).toBe('Black tee.');
    expect(out?.descriptionLong).toBe('Intro\n\n• one\n• two');
  });

  it('clamps runaway lengths without cutting mid-word', () => {
    const out = normalizeProductCopy({
      name: 'word '.repeat(100),
      description: 'word '.repeat(500),
      descriptionLong: 'x',
    });
    expect(out!.name.length).toBeLessThanOrEqual(120);
    expect(out!.description.length).toBeLessThanOrEqual(600);
    expect(out!.description.endsWith('word')).toBe(true);
  });

  it('returns null on invalid JSON, wrong shape or empty description', () => {
    expect(normalizeProductCopy('not json')).toBeNull();
    expect(normalizeProductCopy({ name: 'x' })).toBeNull();
    expect(
      normalizeProductCopy({ name: 'x', description: '   ', descriptionLong: 'y' }),
    ).toBeNull();
  });
});

describe('generateProductCopy', () => {
  const input = { mode: 'without_model' as const, apparelImageUrls: ['https://example.com/a.jpg'] };

  it('resolves null (never throws) when disabled', async () => {
    // vitest.config sets AI_PRODUCT_COPY_ENABLED=false so tests never hit a provider.
    await expect(generateProductCopy(input)).resolves.toBeNull();
  });

  describe('with a stubbed provider', () => {
    beforeEach(() => {
      env.AI_PRODUCT_COPY_ENABLED = 'true';
      env.AI_IMAGE_PROVIDER = 'gemini';
      generateContent.mockReset();
      fetchReferenceImage.mockClear();
    });
    afterEach(() => {
      env.AI_PRODUCT_COPY_ENABLED = 'false';
    });

    it('returns normalized copy stamped with the model', async () => {
      generateContent.mockResolvedValue({
        text: JSON.stringify({
          name: 'Tee',
          description: 'A tee.',
          descriptionLong: 'Intro\n\n- a',
        }),
      });
      const out = await generateProductCopy(input);
      expect(out).toMatchObject({
        name: 'Tee',
        description: 'A tee.',
        descriptionLong: 'Intro\n\n• a',
      });
      expect(out?.model).toBe(env.AI_TEXT_MODEL);
    });

    it('skips the provider entirely when the caller opts out', async () => {
      await expect(generateProductCopy({ ...input, withCopy: false })).resolves.toBeNull();
      expect(generateContent).not.toHaveBeenCalled();
      expect(fetchReferenceImage).not.toHaveBeenCalled();
    });

    it('aborts a hung call at the timeout and resolves null', async () => {
      let sawAbort = false;
      generateContent.mockImplementation(
        ({ config }: { config: { abortSignal: AbortSignal } }) =>
          new Promise((_, reject) =>
            config.abortSignal.addEventListener('abort', () => {
              sawAbort = true;
              reject(new Error('aborted'));
            }),
          ),
      );
      await expect(generateProductCopy(input, { timeoutMs: 50 })).resolves.toBeNull();
      expect(sawAbort).toBe(true);
      // The same signal reaches the image downloads.
      expect(fetchReferenceImage.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    });

    it('resolves null when the provider errors', async () => {
      generateContent.mockRejectedValue(new Error('429 Too Many Requests'));
      await expect(generateProductCopy(input)).resolves.toBeNull();
    });
  });
});
