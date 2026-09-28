/**
 * Rich-text sanitizer for retailer-authored HTML (product long descriptions).
 *
 * Sanitize-on-write: this runs in the listings controller before anything is
 * persisted, so every value in `product_listings.description_long` is safe to
 * render verbatim (dashboard `RichTextView`, future consumer surfaces).
 *
 * The allow-list mirrors exactly what the dashboard's Tiptap editor can
 * produce: headings h2-h4, inline marks, lists, blockquote/hr, tables, links
 * and Cloudinary-hosted images with an optional inline `color` style.
 */
import sanitizeHtml from 'sanitize-html';
import { env } from '@/config/env.js';

/** Hard cap on the sanitized payload — well above any legitimate description. */
export const LONG_DESC_MAX_BYTES = 100_000;

/**
 * Only images we host ourselves survive — pasted hotlinks/base64 are dropped.
 *
 * Both the legacy Cloudinary host and the S3/CloudFront host are allowed for the whole
 * transition: existing rows still hold `res.cloudinary.com` URLs, and Cloudinary is never
 * decommissioned, so both can stay permanently. Without this, the instant a description is
 * migrated to an S3 URL the next retailer save would silently delete every image (the
 * filter DROPS rather than strips — see below).
 */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

const ALLOWED_IMAGE_HOSTS: ReadonlySet<string> = new Set(
  ['res.cloudinary.com', hostOf(env.S3_PUBLIC_BASE_URL)].filter(
    (h): h is string => h !== null,
  ),
);

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'h2', 'h3', 'h4',
    'p', 'br',
    'strong', 'b', 'em', 'i', 'u', 's',
    'blockquote', 'hr',
    'ul', 'ol', 'li',
    'a', 'span', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    span: ['style'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedStyles: {
    span: {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
    },
  },
  allowedSchemes: ['https'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: 'noopener noreferrer nofollow',
        target: '_blank',
      },
    }),
  },
  // Drop (don't just strip) images that aren't on a host we control — this is what
  // enforces "uploaded, not pasted" for description media. The drop is silent, so it is
  // logged: a missing image is otherwise an untraceable "my picture vanished" report.
  exclusiveFilter: (frame) => {
    if (frame.tag !== 'img') return false;
    const host = hostOf(frame.attribs.src);
    if (host !== null && ALLOWED_IMAGE_HOSTS.has(host)) return false;
    console.warn('[sanitize] dropped img host=%s', host ?? '(unparseable)');
    return true;
  },
};

/**
 * Returns the sanitized HTML, or null when nothing meaningful remains
 * (empty editor output like `<p></p>` normalizes to "no description").
 */
export function sanitizeRichText(input: string): string | null {
  const clean = sanitizeHtml(input, OPTIONS).trim();
  // Strip empty block scaffolding to detect content-free documents.
  const text = clean
    .replace(/<br\s*\/?>/gi, '')
    .replace(/<\/?(p|h[2-4]|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|span|strong|b|em|i|u|s)[^>]*>/gi, '')
    .trim();
  const hasMedia = /<(img|hr)\b/i.test(clean);
  if (!text && !hasMedia) return null;
  return clean;
}

/**
 * True when the input contains at least one HTML tag. Tag-free input is treated as
 * plain text (e.g. the retailer app's multiline input or AI-drafted copy) and is
 * converted with `plainTextToHtml` before sanitizing, so the column always holds
 * HTML that every renderer (dashboard, consumer app) displays with its structure.
 */
export function looksLikeHtml(input: string): boolean {
  return /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i.test(input);
}

const BULLET_LINE = /^\s*[•\-*]\s+/;

function escapeText(s: string): string {
  return s
    .replace(/&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Plain text → the simple HTML subset the rich-text editors produce. Blank lines
 * separate paragraphs; single newlines inside a paragraph become `<br>`; runs of
 * lines starting with `•`, `-` or `*` become one `<ul>`. The retailer app's
 * `htmlToEditableText` is the inverse for exactly this subset (p/br/ul/li).
 */
export function plainTextToHtml(input: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (items.length) out.push(`<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    items = [];
  };
  for (const raw of input.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
    } else if (BULLET_LINE.test(line)) {
      flushPara();
      const item = line.replace(BULLET_LINE, '').trim();
      if (item) items.push(escapeText(item));
    } else {
      flushList();
      para.push(escapeText(line));
    }
  }
  flushPara();
  flushList();
  return out.join('');
}
