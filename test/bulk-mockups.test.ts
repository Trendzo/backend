/**
 * Bulk-mockup queue (beta): enqueue → worker generates → ready; cancel only from
 * queued; dismiss terminal jobs. The AI generation is mocked so the test asserts
 * the QUEUE state machine, not image output.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ai-catalog/generate-views.js', () => ({
  IMAGE_GEN_CONCURRENCY: 2,
  genAndUpload: vi.fn(),
  generateMockupViews: vi.fn(async () => ({
    printedUrl: null,
    views: [
      { name: 'front', url: 'https://cdn.test/front.png' },
      { name: 'back', url: 'https://cdn.test/back.png' },
    ],
  })),
}));

import { db, pool } from '@/db/client.js';
import { bulkMockupJobs, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { processBulkMockupQueue } from '@/shared/bulk-mockups/worker.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;

let app: App;
let token: string;
let storeId: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: 'Bulk Mockup Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
  });
  await db.insert(retailerAccounts).values({
    id: retailerId,
    storeId,
    email: `bulk+${retailerId}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: `+9193${Math.floor(10000000 + Math.random() * 89999999)}`,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  token = signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' as const });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const enqueue = () =>
  app.inject({
    method: 'POST',
    url: '/api/v1/retailer/bulk-mockups',
    headers: auth(token),
    payload: { mode: 'without_model', apparelImageUrls: ['https://example.com/a.jpg'] },
  }) as Promise<InjectRes>;

describe('bulk-mockup queue', () => {
  it('enqueues a queued job and counts it in the summary', async () => {
    const res = await enqueue();
    expect(res.statusCode).toBe(200);
    expect(data(res).status).toBe('queued');

    const sum = await app.inject({
      method: 'GET',
      url: '/api/v1/retailer/bulk-mockups/summary',
      headers: auth(token),
    });
    expect(data(sum as InjectRes).pending).toBeGreaterThanOrEqual(1);
  });

  it('worker claims a queued job and generates → ready with outputUrls', async () => {
    await enqueue();
    const claimedId = await processBulkMockupQueue(db);
    expect(claimedId).toBeTruthy();
    const job = await db.query.bulkMockupJobs.findFirst({
      where: (j, { eq }) => eq(j.id, claimedId!),
    });
    expect(job?.status).toBe('ready');
    expect(job?.outputUrls.length).toBe(2);
    expect(job?.finishedAt).not.toBeNull();
  });

  it('cancels a queued job', async () => {
    const created = data(await enqueue());
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/bulk-mockups/${created.id}/cancel`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(data(res as InjectRes).status).toBe('cancelled');
  });

  it('refuses to cancel a processing job (409)', async () => {
    const id = newId('bmj');
    await db.insert(bulkMockupJobs).values({
      id,
      storeId,
      mode: 'without_model',
      request: { mode: 'without_model', apparelImageUrls: ['https://example.com/a.jpg'] },
      referenceImageUrls: ['https://example.com/a.jpg'],
      status: 'processing',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/bulk-mockups/${id}/cancel`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(409);
  });

  it('dismisses a ready job so it drops out of the default list', async () => {
    await enqueue();
    const readyId = await processBulkMockupQueue(db);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/retailer/bulk-mockups/${readyId}/dismiss`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(data(res as InjectRes).status).toBe('dismissed');

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/retailer/bulk-mockups',
      headers: auth(token),
    });
    const ids = (data(list as InjectRes) as { id: string }[]).map((j) => j.id);
    expect(ids).not.toContain(readyId);
  });
});
