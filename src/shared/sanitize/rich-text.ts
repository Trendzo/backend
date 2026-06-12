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

/** Hard cap on the sanitized payload — well above any legitimate description. */
export const LONG_DESC_MAX_BYTES = 100_000;

/** Only images we host ourselves survive — pasted hotlinks/base64 are dropped. */
const ALLOWED_IMAGE_HOST = 'res.cloudinary.com';

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
  // Drop (don't just strip) images that aren't hosted on our Cloudinary —
  // this is what enforces "uploaded, not pasted" for description media.
  exclusiveFilter: (frame) => {
    if (frame.tag !== 'img') return false;
    try {
      return new URL(frame.attribs.src ?? '').host !== ALLOWED_IMAGE_HOST;
    } catch {
      return true; // unparseable / missing src
    }
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
