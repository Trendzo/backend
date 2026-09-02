/**
 * Festival themes — the draft/publish split, the one-winner resolver, and the gates.
 *
 * The behaviours worth locking down mirror the Home CMS suite next door, plus the parts
 * that are new here and invisible until they are wrong:
 *   - exactly ONE winner (or null) per request, picked by a total order — priority, then
 *     city-specificity, then recency, then slug — so two phones never disagree
 *   - windows / city / platform / min-app-version are applied when a DEVICE reads, not
 *     when an admin publishes, and every gate fails closed on missing context
 *   - contrast and locked tokens are publish-time gates: a draft may hold garbage, a
 *     publication may not
 *   - disable-now subtracts from the LAST PUBLISHED payload, never re-renders the draft
 *   - the semantic ETag revalidates on (version, winner), not on the body hash
 *
 * Fixture copy is ASCII on purpose: the embedded Postgres the harness boots runs WIN1252,
 * so non-ASCII fails to insert. Production is UTF8 — harness limitation, not product rule.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { eq, sql } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import { adminAccounts, cmsThemePublications, cmsThemes } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { contrastRatio, WCAG_AA_MIN } from '@/shared/cms/contrast.js';
import { invalidateThemePublication } from '@/shared/cms/theme-published.js';
import { asThemeSnapshot } from '@/shared/cms/theme-render.js';
import type { ThemeTokens } from '@/shared/cms/theme-schema.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { compareAppVersions, meetsMinVersion, parseAppVersion } from '@/shared/semver.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string; headers: Record<string, unknown> };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;
const errOf = (res: InjectRes) => JSON.parse(res.body).error;

let app: App;
let adminToken: string;
let supportToken: string;

const adminGet = (path: string, token = adminToken) =>
  app.inject({ method: 'GET', url: `/api/v1/admin/cms/themes${path}`, headers: auth(token) });
const adminPost = (path: string, payload: unknown, token = adminToken) =>
  app.inject({ method: 'POST', url: `/api/v1/admin/cms/themes${path}`, headers: auth(token), payload });
const adminPatch = (path: string, payload: unknown, token = adminToken) =>
  app.inject({ method: 'PATCH', url: `/api/v1/admin/cms/themes${path}`, headers: auth(token), payload });

const publicTheme = (query = '', headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/api/v1/cms/theme${query}`, headers });

/** Publish the current draft and drop the module-level cache the way the portal flow does. */
async function publish(note?: string) {
  const res = await adminPost('/publish', note ? { note } : {});
  invalidateThemePublication();
  return res;
}

/**
 * Insert straight to the DB so a test can set priorities, windows, cities and updatedAt
 * stamps the API would also allow — and, for the publish-gate test, values it would NOT.
 */
async function seedTheme(over: Partial<typeof cmsThemes.$inferInsert> & { slug: string }) {
  const id = newId(IdPrefix.CmsTheme);
  await db.insert(cmsThemes).values({
    id,
    name: over.slug,
    chrome: { statusBarStyle: 'dark', header: { kind: 'default' }, tabBar: {} },
    decor: { kind: 'none', respectReduceMotion: true },
    tokens: {},
    copy: {},
    ...over,
  });
  return id;
}

/** Create through the API (validation on) and hand back the row id for PATCH/disable-now. */
async function createTheme(body: Record<string, unknown>): Promise<string> {
  const res = await adminPost('/', body);
  expect(res.statusCode).toBe(200);
  return data(res).id as string;
}

let mpSeq = 0;
/** Hand-rolled multipart body, single `file` field — same idiom as reels.test.ts. */
function multipart(buf: Buffer, mime: string) {
  const boundary = `----vitest${Date.now()}${mpSeq++}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="asset"\r\nContent-Type: ${mime}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (purpose: string, buf: Buffer, mime: string) => {
  const { body, contentType } = multipart(buf, mime);
  return app.inject({
    method: 'POST',
    url: `/api/v1/uploads?purpose=${purpose}`,
    headers: { ...auth(adminToken), 'content-type': contentType },
    payload: body,
  });
};

const HOUR = 60 * 60_000;

beforeAll(async () => {
  app = buildApp();
  await app.ready();

  // The token subs must exist as rows: cms_themes.updated_by_admin_id and
  // cms_theme_publications.published_by_admin_id are FKs onto admin_accounts.
  const adminId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `theme-admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });
  adminToken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });

  const supportId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: supportId,
    email: `theme-support+${supportId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'support',
  });
  supportToken = signAccessToken({ sub: supportId, kind: 'admin', subRole: 'support' });
});

beforeEach(async () => {
  // Each test owns the whole theme CMS: the public read serves ONE latest publication,
  // and the module-level cache leaks across tests unless dropped explicitly.
  await db.delete(cmsThemePublications);
  await db.delete(cmsThemes);
  invalidateThemePublication();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

// ─── 1. Nothing published ─────────────────────────────────────────────────────

describe('public read with nothing to serve', () => {
  it('answers the full contract with theme null when nothing was ever published', async () => {
    const res = await publicTheme();
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d.theme).toBeNull();
    expect(d.publicationVersion).toBe(0);
    expect(d.schemaVersion).toBe(1);
    expect(d.refreshAfterSeconds).toBe(1800);
    expect(Number.isNaN(Date.parse(d.generatedAt))).toBe(false);
  });

  it('serves theme null (but the real version) from a publication with zero themes', async () => {
    const pub = await publish();
    expect(pub.statusCode).toBe(200);
    expect(data(pub).version).toBe(1);

    const d = data(await publicTheme());
    expect(d.theme).toBeNull();
    expect(d.publicationVersion).toBe(1);
  });
});

// ─── 2. Wire contract ─────────────────────────────────────────────────────────

describe('public wire contract', () => {
  it('ships slug/window/tokens/chrome/decor/copy and strips name/targeting/updatedAt', async () => {
    await seedTheme({
      slug: 'diwali-2026',
      name: 'Diwali 2026',
      priority: 100,
      tokens: { accent: '#C1121F', accentInk: '#FFFFFF' },
      copy: { greeting: 'Happy Diwali' },
    });
    await publish();

    const d = data(await publicTheme());
    expect(d.publicationVersion).toBe(1);
    expect(d.theme).not.toBeNull();
    // Exact key set: the resolver already applied targeting, so none of it may leak.
    expect(Object.keys(d.theme).sort()).toEqual([
      'chrome',
      'copy',
      'decor',
      'endsAt',
      'slug',
      'startsAt',
      'tokens',
    ]);
    expect(d.theme.slug).toBe('diwali-2026');
    expect(d.theme.tokens).toEqual({ accent: '#C1121F', accentInk: '#FFFFFF' });
    expect(d.theme.copy.greeting).toBe('Happy Diwali');
    expect(d.theme.name).toBeUndefined();
    expect(d.theme.priority).toBeUndefined();
    expect(d.theme.cities).toBeUndefined();
    expect(d.theme.platforms).toBeUndefined();
    expect(d.theme.minAppVersion).toBeUndefined();
    expect(d.theme.updatedAt).toBeUndefined();
  });
});

// ─── 3. Windows against the read clock ────────────────────────────────────────

describe('publish windows', () => {
  it('hides an expired theme', async () => {
    await seedTheme({
      slug: 'expired-fest',
      startsAt: new Date(Date.now() - 2 * HOUR),
      endsAt: new Date(Date.now() - 1 * HOUR),
    });
    await publish();
    expect(data(await publicTheme()).theme).toBeNull();
  });

  it('hides a future theme now, but the published-source preview resolves it inside its window', async () => {
    const startsAt = new Date(Date.now() + 1 * HOUR);
    const endsAt = new Date(Date.now() + 3 * HOUR);
    await seedTheme({ slug: 'midnight-fest', startsAt, endsAt });
    await publish();

    expect(data(await publicTheme()).theme).toBeNull();

    const inside = new Date(Date.now() + 2 * HOUR).toISOString();
    const preview = await adminGet(
      `/preview?source=published&at=${encodeURIComponent(inside)}`,
    );
    expect(preview.statusCode).toBe(200);
    const p = data(preview);
    expect(p.source).toBe('published');
    expect(p.version).toBe(1);
    expect(p.winner?.slug).toBe('midnight-fest');
    expect(p.response.theme?.slug).toBe('midnight-fest');
  });
});

// ─── 4. City targeting ────────────────────────────────────────────────────────

describe('city targeting', () => {
  it('matches case-insensitively, misses other cities, and fails closed with no city', async () => {
    await seedTheme({ slug: 'mumbai-fest', cities: ['Mumbai'] });
    await publish();

    expect(data(await publicTheme('?city=mumbai')).theme?.slug).toBe('mumbai-fest');
    expect(data(await publicTheme('?city=Mumbai')).theme?.slug).toBe('mumbai-fest');
    expect(data(await publicTheme('?city=pune')).theme).toBeNull();
    // No city known: showing a Mumbai-only skin nationwide is worse than not showing it.
    expect(data(await publicTheme()).theme).toBeNull();
  });

  it('treats an empty cities list as visible to nobody', async () => {
    await seedTheme({ slug: 'nowhere-fest', cities: [] });
    await publish();

    expect(data(await publicTheme()).theme).toBeNull();
    expect(data(await publicTheme('?city=mumbai')).theme).toBeNull();
  });
});

// ─── 5 + 6. Specificity and priority ──────────────────────────────────────────

describe('resolver precedence', () => {
  it('lets a city-restricted theme beat a national one at EQUAL priority, only in its city', async () => {
    await seedTheme({ slug: 'national', priority: 100 });
    await seedTheme({ slug: 'mumbai-fest', priority: 100, cities: ['Mumbai'] });
    await publish();

    expect(data(await publicTheme('?city=mumbai')).theme?.slug).toBe('mumbai-fest');
    expect(data(await publicTheme('?city=pune')).theme?.slug).toBe('national');
  });

  it('lets priority beat specificity, until the city theme is bumped above it', async () => {
    await seedTheme({ slug: 'national', priority: 100 });
    await seedTheme({ slug: 'bangalore-fest', priority: 50, cities: ['Bangalore'] });
    await publish();

    // Priority outranks specificity: the national P100 wins even in Bangalore.
    expect(data(await publicTheme('?city=bangalore')).theme?.slug).toBe('national');

    await db
      .update(cmsThemes)
      .set({ priority: 150 })
      .where(eq(cmsThemes.slug, 'bangalore-fest'));
    await publish();

    expect(data(await publicTheme('?city=bangalore')).theme?.slug).toBe('bangalore-fest');
    expect(data(await publicTheme('?city=pune')).theme?.slug).toBe('national');
    expect(data(await publicTheme()).theme?.slug).toBe('national');
  });
});

// ─── 7. App-version gate ──────────────────────────────────────────────────────

describe('min-app-version gate', () => {
  it('compares numerically per part and fails closed on missing or garbage versions', async () => {
    await seedTheme({ slug: 'gated-fest', priority: 100, minAppVersion: '1.0.7' });
    await seedTheme({ slug: 'fallback-fest', priority: 10 });
    await publish();

    // "1.0.10" >= "1.0.7" only under NUMERIC compare — a string compare says the opposite.
    expect(data(await publicTheme('', { 'x-app-version': '1.0.10' })).theme?.slug).toBe('gated-fest');
    expect(data(await publicTheme('', { 'x-app-version': '1.0.6' })).theme?.slug).toBe('fallback-fest');
    // Missing and unparseable headers never satisfy a gate, but the ungated theme still serves.
    expect(data(await publicTheme()).theme?.slug).toBe('fallback-fest');
    expect(data(await publicTheme('', { 'x-app-version': 'not-a-version' })).theme?.slug).toBe(
      'fallback-fest',
    );
  });
});

// ─── 8. Platform gate ─────────────────────────────────────────────────────────

describe('platform gate', () => {
  it('serves an ios-only theme to ios and nobody else', async () => {
    await seedTheme({ slug: 'ios-fest', platforms: ['ios'] });
    await publish();

    expect(data(await publicTheme('', { 'x-app-platform': 'ios' })).theme?.slug).toBe('ios-fest');
    expect(data(await publicTheme('', { 'x-app-platform': 'android' })).theme).toBeNull();
    expect(data(await publicTheme()).theme).toBeNull();
    expect(data(await publicTheme('', { 'x-app-platform': 'windows' })).theme).toBeNull();
  });
});

// ─── 9. Determinism ───────────────────────────────────────────────────────────

describe('deterministic tiebreaks', () => {
  it('breaks an exact priority tie by recency, and an exact recency tie by slug', async () => {
    await seedTheme({ slug: 'alpha-fest', priority: 100, updatedAt: new Date('2026-01-01T00:00:00.000Z') });
    await seedTheme({ slug: 'zulu-fest', priority: 100, updatedAt: new Date('2026-02-01T00:00:00.000Z') });
    await publish();

    // Newer draft wins the tie.
    expect(data(await publicTheme()).theme?.slug).toBe('zulu-fest');

    // Identical updatedAt: the LAST tiebreak is slug ASC, so the order is still total.
    await db.update(cmsThemes).set({ updatedAt: new Date('2026-03-01T00:00:00.000Z') });
    await publish();
    expect(data(await publicTheme()).theme?.slug).toBe('alpha-fest');
  });
});

// ─── 10. ETag ─────────────────────────────────────────────────────────────────

describe('semantic etag', () => {
  it('304s an unchanged (version, winner) pair and busts on a new publication', async () => {
    await seedTheme({ slug: 'etag-fest' });
    await publish();

    const first = await publicTheme();
    expect(first.statusCode).toBe(200);
    const tag = first.headers['etag'] as string;
    expect(tag).toBe('W/"theme:1:etag-fest"');
    expect(first.headers['vary']).toContain('x-app-version');

    const replay = await publicTheme('', { 'if-none-match': tag });
    expect(replay.statusCode).toBe(304);
    expect(replay.body).toBe('');

    // A republish bumps the version and therefore the tag, even with an identical winner.
    await publish();
    const after = await publicTheme('', { 'if-none-match': tag });
    expect(after.statusCode).toBe(200);
    expect(after.headers['etag']).toBe('W/"theme:2:etag-fest"');
  });
});

// ─── 11. Write-time and publish-time validation ───────────────────────────────

describe('admin validation', () => {
  it('rejects a locked token key at create (zod strict)', async () => {
    const res = await adminPost('/', { slug: 'bad-locked', name: 'Bad', tokens: { err: '#FFD700' } });
    expect(res.statusCode).toBe(422);
  });

  it('rejects malformed hex colors at create', async () => {
    const bad = await adminPost('/', { slug: 'bad-hex', name: 'Bad', tokens: { accent: '#12345g' } });
    expect(bad.statusCode).toBe(422);

    const short = await adminPost('/', { slug: 'bad-short', name: 'Bad', tokens: { accent: '#fff' } });
    expect(short.statusCode).toBe(422);
  });

  it('rejects a gradient header without gradient stops at create', async () => {
    const res = await adminPost('/', {
      slug: 'bad-gradient',
      name: 'Bad',
      chrome: { statusBarStyle: 'dark', header: { kind: 'gradient' }, tabBar: {} },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a lottie decor without a url at create', async () => {
    const res = await adminPost('/', {
      slug: 'bad-lottie',
      name: 'Bad',
      decor: { kind: 'lottie', respectReduceMotion: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects an asset URL outside the trusted CDN at create', async () => {
    const res = await adminPost('/', {
      slug: 'bad-host',
      name: 'Bad',
      chrome: {
        statusBarStyle: 'dark',
        header: { kind: 'default', overlayUrl: 'https://evil.example/x.png' },
        tabBar: {},
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('lets a failing-contrast draft SAVE but blocks it at publish, naming the ratio', async () => {
    const id = await createTheme({
      slug: 'low-contrast',
      name: 'Low Contrast',
      tokens: { accent: '#777777', accentInk: '#999999' },
    });

    const blocked = await adminPost('/publish', {});
    expect(blocked.statusCode).toBe(422);
    const failures = errOf(blocked).details.failures as Array<{ slug: string; message: string }>;
    expect(failures[0]?.slug).toBe('low-contrast');
    expect(failures[0]?.message).toContain('4.5:1');

    const fixed = await adminPatch(`/${id}`, { tokens: { accent: '#C1121F', accentInk: '#FFFFFF' } });
    expect(fixed.statusCode).toBe(200);
    const pub = await publish();
    expect(pub.statusCode).toBe(200);
  });
});

// ─── 12. Publish-time locked-token guard ──────────────────────────────────────

describe('publish gate on locked tokens', () => {
  it('names the slug and the locked token for a row written around the API', async () => {
    // Straight to the DB: zod never saw this row, so publish is the last line of defence.
    await seedTheme({
      slug: 'sneaky-green',
      tokens: { green: '#00FF00' } as unknown as ThemeTokens,
    });

    const res = await adminPost('/publish', {});
    expect(res.statusCode).toBe(422);
    const failures = errOf(res).details.failures as Array<{ slug: string; message: string }>;
    expect(failures.some((f) => f.slug === 'sneaky-green' && f.message.includes('locked'))).toBe(true);
  });
});

// ─── 13. Lifecycle: draft edits, publish, restore ─────────────────────────────

describe('draft vs published lifecycle', () => {
  it('keeps the public read on the old snapshot until the next publish', async () => {
    const id = await createTheme({
      slug: 'lifecycle-fest',
      name: 'Lifecycle',
      copy: { greeting: 'hello v1' },
    });
    await publish();

    expect(data(await publicTheme()).theme?.copy.greeting).toBe('hello v1');

    const patched = await adminPatch(`/${id}`, { name: 'Renamed', copy: { greeting: 'hello v2' } });
    expect(patched.statusCode).toBe(200);

    invalidateThemePublication();
    const live = data(await publicTheme());
    expect(live.publicationVersion).toBe(1);
    expect(live.theme?.copy.greeting).toBe('hello v1');

    await publish();
    const after = data(await publicTheme());
    expect(after.publicationVersion).toBe(2);
    expect(after.theme?.copy.greeting).toBe('hello v2');
  });

  it('restore rewinds the draft (re-enabling and disabling as needed) without republishing', async () => {
    const idA = await createTheme({ slug: 'resto-a', name: 'Resto A' });
    await publish('v1 with A');

    // Disable A and ship an EMPTY v2, then grow a new draft B that v1 never knew about.
    await adminPatch(`/${idA}`, { isEnabled: false });
    await publish('v2 empty');
    const idB = await createTheme({ slug: 'resto-b', name: 'Resto B' });

    const restore = await adminPost('/publications/1/restore', {});
    expect(restore.statusCode).toBe(200);
    expect(data(restore)).toEqual({ restoredVersion: 1, published: false });

    // The DRAFT is back at v1: A enabled again, B (absent from v1) switched off.
    const rowA = data(await adminGet(`/${idA}`));
    expect(rowA.isEnabled).toBe(true);
    const rowB = data(await adminGet(`/${idB}`));
    expect(rowB.isEnabled).toBe(false);

    // Customers are STILL on v2 — prove it against a fresh cache read.
    invalidateThemePublication();
    const live = data(await publicTheme());
    expect(live.publicationVersion).toBe(2);
    expect(live.theme).toBeNull();

    // Publishing the restored draft reproduces v1's content as v3.
    await publish('v3 = v1 again');
    const after = data(await publicTheme());
    expect(after.publicationVersion).toBe(3);
    expect(after.theme?.slug).toBe('resto-a');
  });
});

// ─── 14. Disable-now ──────────────────────────────────────────────────────────

describe('disable-now', () => {
  it('subtracts the slug from the LAST PUBLISHED payload without leaking draft edits', async () => {
    const idA = await createTheme({ slug: 'kill-a', name: 'Kill A', priority: 100 });
    const idB = await createTheme({ slug: 'kill-b', name: 'Kill B', priority: 50 });
    await publish();
    expect(data(await publicTheme()).theme?.slug).toBe('kill-a');

    // Edit B's draft but do NOT publish — the kill switch must not carry this along.
    const edited = await adminPatch(`/${idB}`, { name: 'Edited B' });
    expect(edited.statusCode).toBe(200);

    const killed = await adminPost(`/${idA}/disable-now`, {});
    expect(killed.statusCode).toBe(200);
    expect(data(killed)).toEqual({ slug: 'kill-a', disabled: true, version: 2 });
    invalidateThemePublication();

    // A is gone from the public read immediately; B serves.
    const live = data(await publicTheme());
    expect(live.publicationVersion).toBe(2);
    expect(live.theme?.slug).toBe('kill-b');

    // The new publication is v1 minus A: B's entry is v1's frozen snapshot, not the draft.
    const [pub2] = await db
      .select()
      .from(cmsThemePublications)
      .where(eq(cmsThemePublications.version, 2));
    const payload = pub2?.payload as { themes: Array<{ slug: string; name: string }> };
    expect(payload.themes.map((t) => t.slug)).toEqual(['kill-b']);
    expect(payload.themes[0]?.name).toBe('Kill B');

    // And the draft flag flipped, so the next ordinary publish stays A-free.
    expect(data(await adminGet(`/${idA}`)).isEnabled).toBe(false);
  });
});

// ─── 15. Concurrent publish ───────────────────────────────────────────────────

describe('concurrent publish', () => {
  it('serializes two simultaneous publishes into consecutive versions', async () => {
    const [r1, r2] = await Promise.all([adminPost('/publish', {}), adminPost('/publish', {})]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const versions = [data(r1).version, data(r2).version].sort((a: number, b: number) => a - b);
    expect(versions).toEqual([1, 2]);
  });
});

// ─── 16. Permissions ──────────────────────────────────────────────────────────

describe('permissions', () => {
  it('lets support read but not edit, publish, or kill', async () => {
    const read = await adminGet('', supportToken);
    expect(read.statusCode).toBe(200);

    const create = await adminPost('/', { slug: 'nope-fest', name: 'Nope' }, supportToken);
    expect(create.statusCode).toBe(403);

    const pub = await adminPost('/publish', {}, supportToken);
    expect(pub.statusCode).toBe(403);

    const kill = await adminPost('/cmst_nonexistent/disable-now', {}, supportToken);
    expect(kill.statusCode).toBe(403);
  });
});

// ─── 17. Theme asset uploads ──────────────────────────────────────────────────

describe('theme asset uploads', () => {
  const lottie = { v: '5.7.1', layers: [], op: 60 };

  it('accepts a real Lottie JSON under the cap', async () => {
    const res = await upload('theme-lottie', Buffer.from(JSON.stringify(lottie)), 'application/json');
    expect(res.statusCode).toBe(200);
    expect(data(res).url).toMatch(/^https:\/\/memory\.test\//);
  });

  it('rejects a Lottie over 512 KB', async () => {
    const fat = { ...lottie, pad: 'a'.repeat(600 * 1024) };
    const res = await upload('theme-lottie', Buffer.from(JSON.stringify(fat)), 'application/json');
    expect(res.statusCode).toBe(422);
  });

  it('rejects JSON that is not a Lottie animation', async () => {
    const res = await upload('theme-lottie', Buffer.from(JSON.stringify({ foo: 1 })), 'application/json');
    expect(res.statusCode).toBe(422);
    expect(errOf(res).message).toContain('Lottie');
  });

  it('rejects a JPEG wordmark (PNG/WebP only)', async () => {
    const res = await upload('theme-wordmark', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');
    expect(res.statusCode).toBe(422);
  });

  it('rejects a wordmark over 1 MB', async () => {
    const res = await upload('theme-wordmark', Buffer.alloc(1024 * 1024 + 1), 'image/png');
    expect(res.statusCode).toBe(422);
  });
});

// ─── 18. Pure units ───────────────────────────────────────────────────────────

describe('semver (unit)', () => {
  it('parses the accepted grammar and nothing else', () => {
    expect(parseAppVersion('1.0.10')).toEqual([1, 0, 10]);
    expect(parseAppVersion('2.8')).toEqual([2, 8, 0]);
    expect(parseAppVersion('v2.8.1')).toEqual([2, 8, 1]);
    expect(parseAppVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseAppVersion(' 1.2.3 ')).toEqual([1, 2, 3]);
    expect(parseAppVersion('garbage')).toBeNull();
    expect(parseAppVersion('1')).toBeNull();
    expect(parseAppVersion('')).toBeNull();
    expect(parseAppVersion(7)).toBeNull();
    expect(parseAppVersion(null)).toBeNull();
  });

  it('compares numerically per part', () => {
    // The reason this module exists: a string compare puts "1.0.10" BELOW "1.0.6".
    expect(compareAppVersions('1.0.10', '1.0.6')).toBe(1);
    expect(compareAppVersions('1.0.6', '1.0.10')).toBe(-1);
    expect(compareAppVersions('v2.8', '2.8.0')).toBe(0);
    expect(compareAppVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareAppVersions('junk', '1.0.0')).toBeNull();
    expect(compareAppVersions('1.0.0', 'junk')).toBeNull();
  });

  it('fails closed in meetsMinVersion', () => {
    expect(meetsMinVersion('1.0.7', '1.0.7')).toBe(true);
    expect(meetsMinVersion('1.0.10', '1.0.7')).toBe(true);
    expect(meetsMinVersion('1.0.6', '1.0.7')).toBe(false);
    expect(meetsMinVersion(null, '1.0.0')).toBe(false);
    expect(meetsMinVersion(undefined, '1.0.0')).toBe(false);
    expect(meetsMinVersion('garbage', '1.0.0')).toBe(false);
    // A garbage MIN also fails closed rather than letting everything through.
    expect(meetsMinVersion('1.0.0', 'garbage')).toBe(false);
  });
});

describe('contrast (unit)', () => {
  it('pins white-on-black at 21:1 and stays symmetric', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 2);
    expect(contrastRatio('#C1121F', '#FFFFFF')).toBe(contrastRatio('#FFFFFF', '#C1121F'));
  });

  it('marks a known low-contrast pair as failing AA', () => {
    const ratio = contrastRatio('#777777', '#999999');
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeLessThan(WCAG_AA_MIN);
  });

  it('returns null for malformed hex instead of guessing', () => {
    expect(contrastRatio('#fff', '#000000')).toBeNull();
    expect(contrastRatio('#GGGGGG', '#000000')).toBeNull();
  });
});

/**
 * Regressions from the adversarial review of this feature. Each of these shipped
 * green against the original suite and failed only under a concurrency, rename or
 * restore-ordering scenario nothing else exercised.
 */
describe('lifecycle regressions', () => {
  it('disable-now still kills a theme whose slug was renamed after publishing', async () => {
    const id = await createTheme({
      slug: 'diwali-2026',
      name: 'Diwali 2026',
      isEnabled: true,
      priority: 100,
    });
    await publish();
    expect(data(await publicTheme()).theme.slug).toBe('diwali-2026');

    // Slug is editable, and identity must not depend on it.
    expect((await adminPatch(`/${id}`, { slug: 'diwali-2026-v2' })).statusCode).toBe(200);

    const killed = await adminPost(`/${id}/disable-now`, {});
    expect(killed.statusCode).toBe(200);
    invalidateThemePublication();

    // The kill switch must actually kill: before the fix the payload was filtered
    // by the NEW slug, left the old entry in place, and phones kept the theme.
    expect(data(await publicTheme()).theme).toBeNull();
  });

  it('a publish racing a disable-now cannot resurrect the killed theme', async () => {
    const id = await createTheme({ slug: 'race-fest', name: 'Race Fest', isEnabled: true, priority: 100 });
    await publish();

    // Fire both at once: whichever commits second must observe the first's effect,
    // because publish now reads the drafts inside the same advisory lock.
    const [pub, kill] = await Promise.all([
      adminPost('/publish', {}),
      adminPost(`/${id}/disable-now`, {}),
    ]);
    expect(pub.statusCode).toBe(200);
    expect(kill.statusCode).toBe(200);
    invalidateThemePublication();

    const latest = await db.query.cmsThemePublications.findMany({
      orderBy: [sql`${cmsThemePublications.version} desc`],
      limit: 1,
    });
    const payload = asThemeSnapshot(latest[0]?.payload);
    const draft = await db.query.cmsThemes.findFirst({ where: eq(cmsThemes.id, id) });
    // The draft is off, so the final published set must not contain it either.
    expect(draft?.isEnabled).toBe(false);
    expect(payload.themes.some((t) => t.id === id)).toBe(false);
    expect(data(await publicTheme()).theme).toBeNull();
  });

  it('restore reproduces the winner the restored version actually served', async () => {
    // Equal priority, both national: v1's winner is decided by the updatedAt
    // recency tiebreak, which restore must preserve rather than restamp.
    await seedTheme({ slug: 'alpha-fest', priority: 100, updatedAt: new Date('2026-01-01T00:00:00Z') });
    await seedTheme({ slug: 'zulu-fest', priority: 100, updatedAt: new Date('2026-02-01T00:00:00Z') });
    await publish();
    const v1Winner = data(await publicTheme()).theme.slug;
    expect(v1Winner).toBe('zulu-fest');

    // Move away from v1, then come back to it.
    await db.update(cmsThemes).set({ isEnabled: false });
    await publish();
    invalidateThemePublication();
    expect(data(await publicTheme()).theme).toBeNull();

    expect((await adminPost('/publications/1/restore', {})).statusCode).toBe(200);
    await publish();
    invalidateThemePublication();

    expect(data(await publicTheme()).theme.slug).toBe(v1Winner);
  });
});
