/**
 * Move externally hosted media (Cloudinary + the old S3/CloudFront bucket) into the
 * configured object store (STORAGE_DRIVER — e.g. s3 pointed at MinIO via S3_ENDPOINT) and
 * rewrite every stored link to the new URL. CLI: scripts/migrate-media.ts.
 *
 * Phases:
 *   discover — scan every public text / varchar / json / jsonb / array column for source URLs
 *   probe    — dry run only: HEAD each source and report the ones that are not reachable;
 *              nothing is uploaded or written
 *   copy     — apply only: download each source and upload it under a deterministic key
 *              (re-upload of the same key just overwrites, so the copy is idempotent)
 *   rewrite  — apply only: replace the URLs in place, one UPDATE per row covering all its
 *              columns, in a single transaction; column types are preserved via casts
 *
 * Sources that fail to download (404, private/authenticated assets) are reported and their
 * links left untouched. A re-run only sees links not yet rewritten.
 */
import { sql } from 'drizzle-orm';
import type { db as Db } from '@/db/client.js';
import {
  cloudinarySignedDownloadUrl,
  isStorageConfigured,
  publicUrlFor,
  storageDriverName,
  uploadObject,
} from '@/shared/storage/index.js';
import { buildObjectKey } from '@/shared/storage/keys.js';
import {
  DEFAULT_SOURCE_HOSTS,
  findSourceUrls,
  isSourceUrl,
  mediaKeyFor,
  rewriteUrls,
  splitKey,
} from './media-migration.js';

type Column = { table: string; column: string; type: string };
type Hit = { table: string; column: string; urls: number };

export type MediaMigrationReport = {
  apply: boolean;
  /** Columns holding at least one source URL, with their distinct URL counts. */
  columns: Hit[];
  /** Distinct source URLs discovered. */
  urls: number;
  /** Dry run: sources that answered a HEAD probe with 2xx. */
  reachable: number;
  /** Apply: sources uploaded to the configured store. */
  copied: number;
  /** URLs differing from another source only by query string — they share its copy. */
  aliased: number;
  failed: Array<{ url: string; reason: string }>;
  rowsRewritten: number;
  /** Apply: source → new URL. Dry run: source → planned object key. */
  samples: Array<{ from: string; to: string }>;
};

export type MediaMigrationOptions = {
  /** false = dry run (discover + probe, write nothing); true = copy, then rewrite. */
  apply: boolean;
  hosts?: readonly string[];
  concurrency?: number;
  fetchImpl?: typeof fetch;
  /**
   * Second chance for a source the CDN refuses unsigned (401/403): a signed URL for the same
   * original, or null. Defaults to the Cloudinary download API when credentials are set.
   */
  signedSourceUrl?: (url: string) => string | null;
  log?: (msg: string) => void;
};

const FETCH_TIMEOUT_MS = 120_000;

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const tableRef = (table: string) => sql.raw(`public.${ident(table)}`);
const colRef = (column: string) => sql.raw(ident(column));

async function listColumns(database: typeof Db): Promise<Column[]> {
  const res = await database.execute(sql`
    select c.table_name as "table", c.column_name as "column", format_type(a.atttypid, a.atttypmod) as "type"
    from information_schema.columns c
    join pg_attribute a on a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
      and a.attname = c.column_name
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.is_generated = 'NEVER'
      and (c.data_type in ('text', 'character varying', 'json', 'jsonb') or c.data_type = 'ARRAY')
    order by c.table_name, c.ordinal_position`);
  return res.rows as Column[];
}

/** Same-host regex Postgres can use to pre-filter rows cheaply (matched case-insensitively). */
function hostRegex(hosts: readonly string[]): string {
  const esc = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `https?://(${[...esc, 'trendzo-media\\.s3[a-z0-9.-]*\\.amazonaws\\.com'].join('|')})/`;
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/** Retries network errors, 429 and 5xx with backoff; any other status is returned as-is. */
async function fetchWithRetry(
  f: typeof fetch,
  url: string,
  method: 'GET' | 'HEAD',
  attempts = 3,
): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await f(url, {
        method,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status < 500 && res.status !== 429) return res;
      await discard(res);
      last = new Error(`HTTP ${res.status}`);
    } catch (err) {
      last = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

type Signer = (url: string) => string | null;

/**
 * Fetch a source; a 401/403 is retried once through `signer` (the original behind a signed
 * URL). Resolves to the 2xx response, or throws with the status that stopped it.
 */
async function fetchSource(
  f: typeof fetch,
  url: string,
  method: 'GET' | 'HEAD',
  signer: Signer,
): Promise<Response> {
  let res = await fetchWithRetry(f, url, method);
  if (method === 'HEAD' && (res.status === 405 || res.status === 501)) {
    await discard(res);
    res = await fetchWithRetry(f, url, 'GET');
  }
  if (res.status === 401 || res.status === 403) {
    const signed = signer(url);
    if (signed) {
      await discard(res);
      // Signed download endpoints are GET-only.
      const viaSigned = await fetchWithRetry(f, signed, 'GET');
      if (viaSigned.ok) return viaSigned;
      await discard(viaSigned);
      throw new Error(`HTTP ${res.status} (signed fallback HTTP ${viaSigned.status})`);
    }
  }
  if (!res.ok) {
    await discard(res);
    throw new Error(`HTTP ${res.status}`);
  }
  return res;
}

/** Reachability only: the body is dropped unread. */
async function probe(f: typeof fetch, url: string, signer: Signer): Promise<void> {
  await discard(await fetchSource(f, url, 'HEAD', signer));
}

/** Same resource, different query string (`…/a.png?mock=1` vs `…/a.png`). */
function sameResource(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) await fn(items[next++] as T);
    }),
  );
}

/**
 * Refuse to copy into a store whose URLs are themselves sources: the rewritten links would
 * be re-discovered (and re-copied) on every run, and Cloudinary → Cloudinary moves nothing.
 */
function assertTargetUsable(hosts: readonly string[]): void {
  if (storageDriverName === 'cloudinary') {
    throw new Error(
      'STORAGE_DRIVER=cloudinary is a migration source, not a target — set STORAGE_DRIVER=s3 (plus S3_ENDPOINT for MinIO).',
    );
  }
  if (!isStorageConfigured()) {
    throw new Error(`Storage driver "${storageDriverName}" is not configured.`);
  }
  const sample = publicUrlFor('legacy/probe.png');
  if (isSourceUrl(sample, hosts)) {
    throw new Error(
      `Target public URL ${sample} is on a source host — point S3_PUBLIC_BASE_URL at the new store.`,
    );
  }
}

export async function migrateMedia(
  database: typeof Db,
  opts: MediaMigrationOptions,
): Promise<MediaMigrationReport> {
  const hosts = opts.hosts ?? DEFAULT_SOURCE_HOSTS;
  const log = opts.log ?? (() => {});
  const f = opts.fetchImpl ?? fetch;
  const concurrency = opts.concurrency ?? 6;
  const signer: Signer = opts.signedSourceUrl ?? cloudinarySignedDownloadUrl;
  const re = hostRegex(hosts);
  const report: MediaMigrationReport = {
    apply: opts.apply,
    columns: [],
    urls: 0,
    reachable: 0,
    copied: 0,
    aliased: 0,
    failed: [],
    rowsRewritten: 0,
    samples: [],
  };
  if (opts.apply) assertTargetUsable(hosts);

  // ── discover ────────────────────────────────────────────────────────────────
  const byTable = new Map<string, Column[]>();
  const allUrls = new Set<string>();
  for (const col of await listColumns(database)) {
    const rows = (
      await database.execute(
        sql`select ${colRef(col.column)}::text as v from ${tableRef(col.table)} where ${colRef(col.column)}::text ~* ${re}`,
      )
    ).rows as Array<{ v: string }>;
    if (!rows.length) continue;
    const urls = new Set(rows.flatMap((r) => findSourceUrls(r.v, hosts)));
    if (!urls.size) continue;
    urls.forEach((u) => allUrls.add(u));
    report.columns.push({ table: col.table, column: col.column, urls: urls.size });
    byTable.set(col.table, [...(byTable.get(col.table) ?? []), col]);
  }
  report.urls = allUrls.size;
  log(`discovered ${allUrls.size} source URL(s) in ${report.columns.length} column(s)`);

  // ── plan keys ───────────────────────────────────────────────────────────────
  const work: Array<{ url: string; key: string }> = [];
  const keyOwner = new Map<string, string>();
  /** alias URL → the URL whose copy it reuses. */
  const aliases = new Map<string, string>();
  for (const url of allUrls) {
    const key = mediaKeyFor(url);
    let storedKey: string | null = null;
    if (key) {
      // The facade sanitises key segments, so compare on the key it will really write.
      try {
        storedKey = buildObjectKey(splitKey(key));
      } catch {
        storedKey = null;
      }
    }
    if (!key || !storedKey) {
      report.failed.push({ url, reason: 'unmappable URL' });
      continue;
    }
    // URLs differing only by query string are the same object (neither CDN varies on the
    // query), so they share one copy. Anything else landing on the same key — characters
    // the facade sanitises away — is a genuine collision: flagged, not overwritten.
    const owner = keyOwner.get(storedKey);
    if (owner !== undefined && owner !== url) {
      if (sameResource(owner, url)) {
        aliases.set(url, owner);
        report.aliased += 1;
      } else {
        report.failed.push({ url, reason: `key collision with ${owner}` });
      }
      continue;
    }
    keyOwner.set(storedKey, url);
    work.push({ url, key });
  }

  // ── dry run: probe ──────────────────────────────────────────────────────────
  if (!opts.apply) {
    let done = 0;
    await mapLimit(work, concurrency, async ({ url }) => {
      try {
        await probe(f, url, signer);
        report.reachable += 1;
      } catch (err) {
        report.failed.push({ url, reason: errMessage(err) });
      }
      done += 1;
      if (done % 100 === 0) log(`  probed ${done}/${work.length}`);
    });
    report.samples = work.slice(0, 5).map(({ url, key }) => ({ from: url, to: key }));
    for (const [alias, owner] of aliases) {
      if (report.failed.some((x) => x.url === owner)) {
        report.failed.push({ url: alias, reason: `shares unreachable ${owner}` });
      }
    }
    log(
      `probed ${work.length}: ${report.reachable} reachable, ${report.failed.length} failed, ${report.aliased} query alias(es)`,
    );
    return report;
  }

  // ── copy ────────────────────────────────────────────────────────────────────
  const map = new Map<string, string>();
  let done = 0;
  await mapLimit(work, concurrency, async ({ url, key }) => {
    try {
      const res = await fetchSource(f, url, 'GET', signer);
      const buffer = Buffer.from(await res.arrayBuffer());
      const { folder, publicId } = splitKey(key);
      const out = await uploadObject(buffer, {
        folder,
        publicId,
        contentType: res.headers.get('content-type') ?? undefined,
      });
      map.set(url, out.url);
      report.copied += 1;
    } catch (err) {
      report.failed.push({ url, reason: errMessage(err) });
    }
    done += 1;
    if (done % 50 === 0) log(`  copied ${done}/${work.length}`);
  });
  for (const [alias, owner] of aliases) {
    const to = map.get(owner);
    if (to) map.set(alias, to);
    else report.failed.push({ url: alias, reason: `shares failed ${owner}` });
  }
  report.samples = [...map].slice(0, 5).map(([from, to]) => ({ from, to }));
  log(`copied ${report.copied}/${work.length}; ${report.failed.length} failed`);

  // ── rewrite ─────────────────────────────────────────────────────────────────
  if (!map.size) return report;
  await database.transaction(async (tx) => {
    for (const [table, cols] of byTable) {
      const where = sql.join(
        cols.map((c) => sql`${colRef(c.column)}::text ~* ${re}`),
        sql` or `,
      );
      const select = sql.join(
        cols.map((c, i) => sql`${colRef(c.column)}::text as ${sql.raw(`c${i}`)}`),
        sql`, `,
      );
      // FOR UPDATE pins each row's ctid until commit: no concurrent writer can move the row
      // (and let its old slot be reused by another row) between this read and our UPDATE.
      const rows = (
        await tx.execute(
          sql`select ctid::text as ctid, ${select} from ${tableRef(table)} where ${where} for update`,
        )
      ).rows as Array<Record<string, string | null>>;
      for (const row of rows) {
        const sets = cols.flatMap((c, i) => {
          const before = row[`c${i}`];
          if (typeof before !== 'string') return [];
          const after = rewriteUrls(before, map);
          return after === before ? [] : [sql`${colRef(c.column)} = ${after}::${sql.raw(c.type)}`];
        });
        if (!sets.length) continue;
        // One UPDATE per row: a row's ctid changes once it is updated, so all of its
        // columns must be written together.
        await tx.execute(
          sql`update ${tableRef(table)} set ${sql.join(sets, sql`, `)} where ctid = ${row.ctid}::tid`,
        );
        report.rowsRewritten += 1;
      }
    }
  });
  log(`rewrote ${report.rowsRewritten} row(s)`);
  return report;
}
