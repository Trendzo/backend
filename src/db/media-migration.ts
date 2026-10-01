/**
 * Pure helpers for moving externally hosted media (Cloudinary, the old S3/CloudFront
 * bucket) into the configured object store and rewriting the stored links. The runner is
 * `migrate-media.ts`; these functions hold the URL rules so they can be unit-tested.
 */

/** Hosts whose media is migrated by default: Cloudinary + the old CloudFront distribution. */
export const DEFAULT_SOURCE_HOSTS = ['res.cloudinary.com', 'dgwf2q4dx1fzq.cloudfront.net'] as const;

/** Virtual-hosted URLs of the old bucket itself (trendzo-media.s3[.region].amazonaws.com). */
const OLD_BUCKET_HOST = /^trendzo-media\.s3(?:[.-][a-z0-9-]+)*\.amazonaws\.com$/i;

/**
 * Candidate URLs inside any stored value — plain text, a jsonb document's text form or a
 * Postgres array literal. Stops at characters that delimit values in those encodings.
 */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\,\]\)}]+/g;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function isSourceUrl(url: string, hosts: readonly string[] = DEFAULT_SOURCE_HOSTS): boolean {
  const u = parse(url);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
  const host = u.hostname.toLowerCase();
  return hosts.includes(host) || OLD_BUCKET_HOST.test(host);
}

/** Every distinct migratable URL in `text`, in first-seen order. */
export function findSourceUrls(
  text: string,
  hosts: readonly string[] = DEFAULT_SOURCE_HOSTS,
): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_IN_TEXT)) {
    // Sentence punctuation directly after a URL in prose is not part of it.
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (isSourceUrl(url, hosts)) seen.add(url);
  }
  return [...seen];
}

/**
 * Object key for a source URL, or null when it cannot be mapped safely.
 *
 * - Old bucket / CloudFront: the SAME key (path minus the leading slash), so the object
 *   lands exactly where the old one was.
 * - Cloudinary: `legacy/cloudinary/<path after host>` — cloud name, resource type,
 *   delivery type, any transformation segment, version and folders are all kept, so two
 *   different Cloudinary URLs never collide.
 *
 * The query string is dropped (it is not part of the object); percent-escapes decoded.
 */
export function mediaKeyFor(url: string): string | null {
  const u = parse(url);
  if (!u) return null;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null;
  const host = u.hostname.toLowerCase();
  const key = segments.join('/');
  return host === 'res.cloudinary.com' ? `legacy/cloudinary/${key}` : key;
}

/** Split a key into the storage facade's folder + publicId (the key's last segment). */
export function splitKey(key: string): { folder: string; publicId: string } {
  const i = key.lastIndexOf('/');
  return i === -1
    ? { folder: '', publicId: key }
    : { folder: key.slice(0, i), publicId: key.slice(i + 1) };
}

/**
 * Replace every mapped URL in `text` with its new URL. Exact-string replacement, longest
 * source first, so a URL that is a prefix of another (e.g. with and without a query) can
 * never clobber the longer one.
 */
export function rewriteUrls(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  const sources = [...map.keys()].sort((a, b) => b.length - a.length);
  for (const from of sources) {
    if (out.includes(from)) out = out.split(from).join(map.get(from) as string);
  }
  return out;
}
