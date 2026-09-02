/**
 * App-version parsing and comparison for client gating.
 *
 * The consumer app sends `x-app-version` (e.g. "1.0.6") on every request; a theme (or any
 * future remotely-gated capability) can declare a minimum version. Comparison must be
 * numeric per part — the whole reason this file exists is that "1.0.10" > "1.0.6", which a
 * string compare gets wrong.
 *
 * Philosophy: gates FAIL CLOSED. A missing or unparseable version never satisfies a gate,
 * the same way an unknown city never satisfies a city-restricted CMS item — showing a
 * capability to a client that may not support it is worse than hiding it.
 */

/**
 * Parse "2.8", "2.8.0", "v2.8.1", "1.2.3-beta.1" into [major, minor, patch].
 * Missing patch is 0; a prerelease suffix is ignored (gates are floors, not exact pins).
 * Anything else — including non-strings — returns null.
 */
export function parseAppVersion(raw: unknown): [number, number, number] | null {
  if (typeof raw !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(raw.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
}

/** -1 / 0 / 1, or null when either side is unparseable. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseAppVersion(a);
  const pb = parseAppVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** True only when `appVersion` parses AND is >= `min`. Fails closed on garbage/absence. */
export function meetsMinVersion(appVersion: string | null | undefined, min: string): boolean {
  if (appVersion == null) return false;
  const cmp = compareAppVersions(appVersion, min);
  return cmp !== null && cmp >= 0;
}
