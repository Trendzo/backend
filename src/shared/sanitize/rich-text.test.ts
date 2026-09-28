import { describe, expect, it } from 'vitest';
import { looksLikeHtml, plainTextToHtml, sanitizeRichText } from './rich-text.js';

describe('looksLikeHtml', () => {
  it('detects tags, ignores angle brackets in prose', () => {
    expect(looksLikeHtml('<p>Hi</p>')).toBe(true);
    expect(looksLikeHtml('Line one<br/>two')).toBe(true);
    expect(looksLikeHtml('<a href="https://x.y">x</a>')).toBe(true);
    expect(looksLikeHtml('Fits sizes < 40 and > 32')).toBe(false);
    expect(looksLikeHtml('I <3 this kurta')).toBe(false);
    expect(looksLikeHtml('Plain text\n\n• bullet')).toBe(false);
  });
});

describe('plainTextToHtml', () => {
  it('turns paragraphs and bullet runs into p/ul', () => {
    expect(plainTextToHtml('Easy kurta.\n\n• Soft cotton\n• Straight fit')).toBe(
      '<p>Easy kurta.</p><ul><li>Soft cotton</li><li>Straight fit</li></ul>',
    );
  });

  it('accepts -, * and • bullets and ends a list at a non-bullet line', () => {
    expect(plainTextToHtml('- one\n* two\nAfter')).toBe(
      '<ul><li>one</li><li>two</li></ul><p>After</p>',
    );
  });

  it('keeps single newlines inside a paragraph as <br>', () => {
    expect(plainTextToHtml('Line one\nLine two\r\n\r\nNext')).toBe(
      '<p>Line one<br>Line two</p><p>Next</p>',
    );
  });

  it('escapes markup characters but keeps existing entities', () => {
    expect(plainTextToHtml('Sizes < 40 & wash > 30°, 5 &amp; 6')).toBe(
      '<p>Sizes &lt; 40 &amp; wash &gt; 30°, 5 &amp; 6</p>',
    );
  });

  it('returns empty for blank input, which sanitizes to null', () => {
    expect(plainTextToHtml('  \n\n ')).toBe('');
    expect(sanitizeRichText(plainTextToHtml('  \n '))).toBeNull();
  });

  it('survives the sanitizer unchanged', () => {
    const html = plainTextToHtml('Intro\n\n• a & b\n• c');
    expect(sanitizeRichText(html)).toBe(html);
  });
});
