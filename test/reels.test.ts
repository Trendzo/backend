import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock Cloudinary so /media and reel-delete never touch the network. Hoisted above imports.
vi.mock('@/shared/cloudinary.js', () => ({
  uploadToCloudinary: vi.fn(async () => ({
    url: 'https://cdn.example/test.mp4',
    publicId: 'closetx/reels/testpub',
    bytes: 2048,
    width: 720,
    height: 1280,
    format: 'mp4',
    resourceType: 'video',
    duration: 12.7,
  })),
  buildVideoThumbnailUrl: vi.fn((publicId: string) => `https://cdn.example/${publicId}.jpg`),
  deleteFromCloudinary: vi.fn(async () => undefined),
}));

import { db, pool } from '@/db/client.js';
import { adminAccounts, consumerBans, consumers } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

let app: App;
let consumerId: string;
let otherConsumerId: string;
let adminId: string;
let ctoken: string;
let otherToken: string;
let atoken: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = (res: InjectRes) => JSON.parse(res.body);
const data = (res: InjectRes) => json(res).data;

let pubSeq = 0;
const reelPayload = (over: Record<string, unknown> = {}) => ({
  videoUrl: 'https://cdn.example/v.mp4',
  videoPublicId: `closetx/reels/p${pubSeq++}`,
  thumbnailUrl: 'https://cdn.example/v.jpg',
  durationSec: 10,
  caption: 'test reel',
  ...over,
});

async function createReel(token = ctoken, over: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/consumer/reels',
    headers: auth(token),
    payload: reelPayload(over),
  });
  expect(res.statusCode).toBe(200);
  return data(res).id as string;
}

function multipart(mime: string) {
  const boundary = `----vitest${Date.now()}${pubSeq++}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="clip"\r\nContent-Type: ${mime}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), Buffer.from([0, 1, 2, 3, 4]), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();

  consumerId = newId(IdPrefix.Consumer);
  otherConsumerId = newId(IdPrefix.Consumer);
  adminId = newId(IdPrefix.Admin);

  await db.insert(consumers).values([
    { id: consumerId, phone: '+91900000001', name: 'Test Consumer' },
    { id: otherConsumerId, phone: '+91900000002', name: 'Other Consumer' },
  ]);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });

  ctoken = signAccessToken({ sub: consumerId, kind: 'consumer' });
  otherToken = signAccessToken({ sub: otherConsumerId, kind: 'consumer' });
  atoken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('reels — auth & validation', () => {
  it('rejects unauthenticated access', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels' });
    expect(res.statusCode).toBe(401);
    expect(json(res).success).toBe(false);
  });

  it('422s on an invalid create body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/reels',
      headers: auth(ctoken),
      payload: { caption: 'no video url' },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('reels — create & feed', () => {
  it('creates a reel with zeroed counts and author chip', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/reels',
      headers: auth(ctoken),
      payload: reelPayload({ caption: 'hello world' }),
    });
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d).toMatchObject({
      caption: 'hello world',
      status: 'active',
      likeCount: 0,
      commentCount: 0,
      saveCount: 0,
      viewCount: 0,
      viewerHasLiked: false,
      viewerHasSaved: false,
    });
    expect(d.author).toMatchObject({ id: consumerId, name: 'Test Consumer' });
  });

  it('lists the reel in the active feed', async () => {
    const id = await createReel();
    const res = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels?limit=50', headers: auth(ctoken) });
    expect(res.statusCode).toBe(200);
    const ids = data(res).items.map((r: { id: string }) => r.id);
    expect(ids).toContain(id);
  });

  it('lists own reels under /mine', async () => {
    const id = await createReel();
    const res = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels/mine', headers: auth(ctoken) });
    const ids = data(res).items.map((r: { id: string }) => r.id);
    expect(ids).toContain(id);
  });
});

describe('reels — likes', () => {
  it('likes, is idempotent, and unlikes with correct counts + viewer flag', async () => {
    const id = await createReel();

    let res = await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/like`, headers: auth(ctoken) });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toEqual({ liked: true, likeCount: 1 });

    // Liking again is a no-op (unique-violation rollback), count stays 1.
    res = await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/like`, headers: auth(ctoken) });
    expect(data(res).likeCount).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(data(detail).viewerHasLiked).toBe(true);

    res = await app.inject({ method: 'DELETE', url: `/api/v1/consumer/reels/${id}/like`, headers: auth(ctoken) });
    expect(data(res)).toEqual({ liked: false, likeCount: 0 });
  });
});

describe('reels — comments', () => {
  it('adds, lists, and deletes a comment with counter sync', async () => {
    const id = await createReel();

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/reels/${id}/comments`,
      headers: auth(ctoken),
      payload: { body: 'nice fit 🔥' },
    });
    expect(add.statusCode).toBe(200);
    const commentId = data(add).id as string;
    expect(data(add).author.id).toBe(consumerId);

    const list = await app.inject({ method: 'GET', url: `/api/v1/consumer/reels/${id}/comments`, headers: auth(ctoken) });
    expect(data(list).items.map((c: { id: string }) => c.id)).toContain(commentId);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(data(detail).commentCount).toBe(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/consumer/reels/${id}/comments/${commentId}`,
      headers: auth(ctoken),
    });
    expect(del.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(data(after).commentCount).toBe(0);
  });

  it("won't delete another user's comment", async () => {
    const id = await createReel();
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/consumer/reels/${id}/comments`,
      headers: auth(ctoken),
      payload: { body: 'mine' },
    });
    const commentId = data(add).id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/consumer/reels/${id}/comments/${commentId}`,
      headers: auth(otherToken),
    });
    expect(del.statusCode).toBe(404);
  });
});

describe('reels — saves & views', () => {
  it('saves, surfaces in the saved feed, and unsaves', async () => {
    const id = await createReel();

    let res = await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/save`, headers: auth(ctoken) });
    expect(data(res)).toEqual({ saved: true, saveCount: 1 });

    const saved = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels/saved', headers: auth(ctoken) });
    const item = data(saved).items.find((r: { id: string }) => r.id === id);
    expect(item).toBeTruthy();
    expect(item.viewerHasSaved).toBe(true);

    res = await app.inject({ method: 'DELETE', url: `/api/v1/consumer/reels/${id}/save`, headers: auth(ctoken) });
    expect(data(res)).toEqual({ saved: false, saveCount: 0 });
  });

  it('increments the view counter', async () => {
    const id = await createReel();
    await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/view`, headers: auth(ctoken) });
    const res = await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/view`, headers: auth(ctoken) });
    expect(data(res).viewCount).toBe(2);
  });
});

describe('reels — media upload (cloudinary mocked)', () => {
  it('accepts a video and returns URLs + duration', async () => {
    const { body, contentType } = multipart('video/mp4');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/reels/media',
      headers: { ...auth(ctoken), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d.videoUrl).toBeTruthy();
    expect(d.thumbnailUrl).toContain('.jpg');
    expect(d.durationSec).toBe(13); // Math.round(12.7)
  });

  it('rejects a non-video mime type', async () => {
    const { body, contentType } = multipart('image/png');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/reels/media',
      headers: { ...auth(ctoken), 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('reels — moderation', () => {
  it('takedown hides from feed and blocks interaction; restore brings it back', async () => {
    const id = await createReel();

    const td = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reels/${id}/takedown`,
      headers: auth(atoken),
      payload: { reason: 'spec takedown' },
    });
    expect(td.statusCode).toBe(200);
    expect(data(td).status).toBe('taken_down');

    const feed = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels?limit=50', headers: auth(ctoken) });
    expect(data(feed).items.map((r: { id: string }) => r.id)).not.toContain(id);

    const like = await app.inject({ method: 'POST', url: `/api/v1/consumer/reels/${id}/like`, headers: auth(ctoken) });
    expect(like.statusCode).toBe(404);

    const restore = await app.inject({ method: 'POST', url: `/api/v1/admin/reels/${id}/restore`, headers: auth(atoken) });
    expect(data(restore).status).toBe('active');

    const feed2 = await app.inject({ method: 'GET', url: '/api/v1/consumer/reels?limit=50', headers: auth(ctoken) });
    expect(data(feed2).items.map((r: { id: string }) => r.id)).toContain(id);
  });

  it('requires admin auth for moderation routes', async () => {
    const id = await createReel();
    // No token → unauthenticated.
    const anon = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reels/${id}/takedown`,
      payload: { reason: 'nope' },
    });
    expect(anon.statusCode).toBe(401);
    // Valid consumer token → authenticated but wrong kind → forbidden.
    const wrongKind = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/reels/${id}/takedown`,
      headers: auth(ctoken),
      payload: { reason: 'nope' },
    });
    expect(wrongKind.statusCode).toBe(403);
  });

  it('accepts a report against a reel', async () => {
    const id = await createReel();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/community/reports',
      headers: auth(ctoken),
      payload: { targetType: 'reel', targetId: id, reason: 'spec report' },
    });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({ targetType: 'reel', targetId: id, status: 'pending' });
  });
});

describe('reels — ownership & bans', () => {
  it("won't delete another user's reel", async () => {
    const id = await createReel(otherToken);
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(res.statusCode).toBe(404);
  });

  it('deletes own reel and 404s afterwards', async () => {
    const id = await createReel();
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: `/api/v1/consumer/reels/${id}`, headers: auth(ctoken) });
    expect(get.statusCode).toBe(404);
  });

  it('blocks creation when banned from the reels surface', async () => {
    const bannedId = newId(IdPrefix.Consumer);
    await db.insert(consumers).values({ id: bannedId, phone: '+91900000003', name: 'Banned' });
    await db.insert(consumerBans).values({
      id: newId(IdPrefix.ConsumerBan),
      consumerId: bannedId,
      surface: 'reels',
      reason: 'spec ban',
      createdByAdminId: adminId,
    });
    const bannedToken = signAccessToken({ sub: bannedId, kind: 'consumer' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/consumer/reels',
      headers: auth(bannedToken),
      payload: reelPayload(),
    });
    expect(res.statusCode).toBe(403);
  });
});
