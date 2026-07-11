/**
 * Retry a provider call on transient rate-limit / availability errors with
 * truncated exponential backoff + jitter. Vertex's Gemini image models use
 * Dynamic Shared Quota: 429 RESOURCE_EXHAUSTED is expected under contention and
 * Google's guidance is to back off and retry rather than fail the request.
 * Non-retryable errors (bad input, auth, other 4xx) rethrow immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; maxMs?: number } = {},
): Promise<T> {
  const { retries = 5, baseMs = 1000, maxMs = 16000 } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const jitter = Math.random() * backoff * 0.25;
      await new Promise((resolve) => setTimeout(resolve, backoff + jitter));
      attempt += 1;
    }
  }
}

/** True for 429 (RESOURCE_EXHAUSTED) and 503 (UNAVAILABLE) — the transient class. */
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 429 || e.status === 503) return true;
  if (e.code === 429 || e.code === 503) return true;
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(e.message ?? '');
}
