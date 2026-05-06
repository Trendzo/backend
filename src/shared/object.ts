/**
 * Strip keys whose value is `undefined`. Useful when threading a Zod-parsed body into a
 * Drizzle `.set(...)` call under `exactOptionalPropertyTypes: true` — the optional zod
 * fields land as `key: undefined` and the strict insert/update type rejects them.
 */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}
