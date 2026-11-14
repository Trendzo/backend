import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '@/config/env.js';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import { bulkMockupJobs, categories, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

vi.mock('@langchain/google', () => ({
  ChatGoogle: class {
    withStructuredOutput() {
      return { invoke: async (messages: Array<[string, string]>) => {
        const latest = messages.at(-1)?.[1];
        if (latest === 'Blue linen dress') return {
          name: 'Blue linen dress', listingPolicy: 'final_sale',
          occasion: ['Party'], ageGroups: ['18-24'], hsn: '6204',
        };
        if (latest === 'Blue shirt size M') return {
          name: 'Blue shirt', variantRows: [{ color: 'Blue', size: 'M' }],
        };
        if (latest === 'price 999') return { priceRupees: 999 };
        if (latest === 'generate mockups') return { generateMockups: true };
        return {};
      } };
    }
  },
}));
vi.mock('@/shared/ai-catalog/product-copy.js', () => ({ generateProductCopy: async () => null }));

const app = buildApp();
let token: string;
let otherToken: string;
let categoryId: string;
let listingId: string;
const headers = () => ({ authorization: `Bearer ${token}` });
const data = (response: { body: string }) => JSON.parse(response.body).data;

beforeAll(async () => {
  env.GEMINI_API_KEY = 'test-key-for-chat-integration';
  await app.ready();
  for (let n = 0; n < 2; n++) {
    const retailerId = newId(IdPrefix.Retailer);
    const storeId = newId(IdPrefix.Store);
    await db.insert(retailerStores).values({
      id: storeId, legalEntityId: retailerId, legalName: `Draft Store ${n}`,
      gstin: '27AAFCK1234M1Z5', address: '1 Rd, Mumbai, MH', stateCode: 'MH',
      lat: 19.06, lng: 72.83, status: 'active', platformFeeBp: 200,
    });
    await db.insert(retailerAccounts).values({
      id: retailerId, storeId, email: `draft+${retailerId}@test.local`,
      passwordHash: 'x'.repeat(20), legalName: 'Owner',
      phone: `+9194${Math.floor(10000000 + Math.random() * 89999999)}`,
      gstin: '27AAFCK1234M1Z5', subRole: 'owner', status: 'active',
    });
    const signed = signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' });
    if (n === 0) token = signed;
    else otherToken = signed;
  }
  categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId, slug: `draft-${categoryId.slice(-6)}`,
    label: 'Draft Category', gender: 'unisex',
  });
});

afterAll(async () => { await app.close(); await pool.end(); });

describe('partial product draft API', () => {
  it('persists a photo-only draft without inventing a category or gender', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/retailer/listings', headers: headers(),
      payload: { galleryUrls: ['https://example.com/product.jpg'] },
    });
    expect(response.statusCode).toBe(200);
    const listing = data(response);
    listingId = listing.id;
    expect(listing).toMatchObject({ name: '', categoryId: null, gender: null, status: 'draft' });

    const readiness = data(await app.inject({
      method: 'GET', url: `/api/v1/retailer/listings/${listingId}/readiness`, headers: headers(),
    }));
    expect(readiness.canSaveDraft).toBe(true);
    expect(readiness.canPublish).toBe(false);
    expect(readiness.publishIssues.map((issue: { code: string }) => issue.code))
      .toEqual(expect.arrayContaining(['name_required', 'category_required', 'gender_required']));
  });

  it('returns structured publish issues and prevents a live product becoming incomplete', async () => {
    const blocked = await app.inject({
      method: 'PATCH', url: `/api/v1/retailer/listings/${listingId}`, headers: headers(),
      payload: { status: 'active' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body).error.details.issues.length).toBeGreaterThan(0);

    await app.inject({ method: 'PATCH', url: `/api/v1/retailer/listings/${listingId}`,
      headers: headers(), payload: {
        name: 'Linen shirt', categoryId, gender: 'her',
        description: 'Soft linen shirt', descriptionLong: 'A shirt for warm days.',
      },
    });
    const variant = await app.inject({
      method: 'PUT', url: `/api/v1/retailer/listings/${listingId}/default-variant`,
      headers: headers(), payload: { pricePaise: 129900, stock: 0, imageUrls: [] },
    });
    expect(variant.statusCode).toBe(200);
    const published = await app.inject({
      method: 'PATCH', url: `/api/v1/retailer/listings/${listingId}`,
      headers: headers(), payload: { status: 'active' },
    });
    expect(published.statusCode).toBe(200);
    expect(data(published).status).toBe('active');

    const invalid = await app.inject({
      method: 'PATCH', url: `/api/v1/retailer/listings/${listingId}`,
      headers: headers(), payload: { gender: null },
    });
    expect(invalid.statusCode).toBe(409);
    expect(JSON.parse(invalid.body).error.details.issues)
      .toContainEqual(expect.objectContaining({ code: 'gender_required' }));
  });

  it('ties chat sessions to the authenticated retailer and store', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/retailer/product-chat/sessions', headers: headers() });
    expect(created.statusCode).toBe(200);
    const sessionId = data(created).id;
    const own = await app.inject({ method: 'GET', url: `/api/v1/retailer/product-chat/sessions/${sessionId}`, headers: headers() });
    expect(own.statusCode).toBe(200);
    const other = await app.inject({ method: 'GET', url: `/api/v1/retailer/product-chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${otherToken}` } });
    expect(other.statusCode).toBe(404);
  });

  it('creates and updates a chat draft while keeping publish validation on the backend', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/retailer/product-chat/sessions', headers: headers() });
    expect(created.statusCode).toBe(200);
    const sessionId = data(created).id;
    const first = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'Blue linen dress' } });
    expect(first.statusCode).toBe(200);
    expect(data(first).lastTurnSucceeded).toBe(true);
    const chatListingId = data(first).listingId;
    expect(chatListingId).toBeTruthy();

    const followUp = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'price 999' } });
    expect(followUp.statusCode).toBe(200);
    expect(data(followUp).lastTurnSucceeded).toBe(true);
    expect(data(followUp).listingId).toBe(chatListingId);
    expect(data(followUp).readiness.canPublish).toBe(false);
    const listing = data(await app.inject({ method: 'GET', url: `/api/v1/retailer/listings/${chatListingId}`,
      headers: headers() }));
    expect(listing.name).toBe('Blue linen dress');
    expect(listing.listingPolicy).toBe('final_sale');
    expect(listing.occasion).toContain('Party');
    expect(listing.ageGroups).toContain('18-24');
    expect(listing.hsn).toBe('6204');
    expect(listing.variants[0].pricePaise).toBe(99900);

    const publish = await app.inject({ method: 'POST',
      url: `/api/v1/retailer/product-chat/sessions/${sessionId}/publish`, headers: headers() });
    expect(publish.statusCode).toBe(409);
    expect(JSON.parse(publish.body).error.details.issues)
      .toContainEqual(expect.objectContaining({ code: 'category_required' }));
  });

  it('uses a follow-up price to finish the only pending color and size row', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/retailer/product-chat/sessions', headers: headers() });
    const sessionId = data(created).id;
    const first = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'Blue shirt size M' } });
    expect(first.statusCode).toBe(200);
    const chatListingId = data(first).listingId;
    const staged = data(await app.inject({ method: 'GET', url: `/api/v1/retailer/listings/${chatListingId}`,
      headers: headers() }));
    expect(staged.variantMode).toBe('color_size');
    expect(staged.draftVariantData.colors[0].sizes[0].price).toBe('');

    const followUp = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'price 999' } });
    expect(followUp.statusCode).toBe(200);
    expect(data(followUp).lastTurnSucceeded).toBe(true);
    const finished = data(await app.inject({ method: 'GET', url: `/api/v1/retailer/listings/${chatListingId}`,
      headers: headers() }));
    expect(finished.variants[0].pricePaise).toBe(99900);
    expect(finished.draftVariantData).toBeNull();
  });

  it('queues chat mockups and adds only reviewed results to the product', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/retailer/product-chat/sessions', headers: headers() });
    const sessionId = data(created).id;
    const first = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'Blue linen dress', imageUrls: ['https://example.com/front.jpg'] } });
    expect(first.statusCode).toBe(200);
    const chatListingId = data(first).listingId;

    const queued = await app.inject({ method: 'POST', url: `/api/v1/retailer/product-chat/sessions/${sessionId}/mockups`,
      headers: headers(), payload: { mode: 'without_model' } });
    expect(queued.statusCode).toBe(200);
    const jobId = data(queued).mockupJob.id;
    expect(data(queued).mockupJob.status).toBe('queued');
    expect(data(queued).readiness.publishIssues)
      .toContainEqual(expect.objectContaining({ code: 'mockups_pending' }));
    await db.update(bulkMockupJobs).set({ status: 'ready', outputUrls: [
      'https://example.com/mockup-front.jpg', 'https://example.com/mockup-back.jpg',
    ] }).where(eq(bulkMockupJobs.id, jobId));

    const ready = await app.inject({ method: 'GET', url: `/api/v1/retailer/product-chat/sessions/${sessionId}`,
      headers: headers() });
    expect(data(ready).mockupJob.status).toBe('ready');
    const adopted = await app.inject({ method: 'POST',
      url: `/api/v1/retailer/product-chat/sessions/${sessionId}/mockups/adopt`,
      headers: headers(), payload: { imageUrls: ['https://example.com/mockup-front.jpg'] } });
    expect(adopted.statusCode).toBe(200);
    expect(data(adopted).mockupJob).toBeNull();
    const listing = data(await app.inject({ method: 'GET', url: `/api/v1/retailer/listings/${chatListingId}`,
      headers: headers() }));
    expect(listing.galleryUrls).toEqual(['https://example.com/front.jpg', 'https://example.com/mockup-front.jpg']);
    const job = await db.query.bulkMockupJobs.findFirst({ where: eq(bulkMockupJobs.id, jobId) });
    expect(job?.status).toBe('dismissed');

    const requestedInChat = await app.inject({ method: 'POST',
      url: `/api/v1/retailer/product-chat/sessions/${sessionId}/messages`,
      headers: headers(), payload: { text: 'generate mockups' } });
    expect(requestedInChat.statusCode).toBe(200);
    expect(data(requestedInChat).mockupJob.status).toBe('queued');
    const discarded = await app.inject({ method: 'DELETE',
      url: `/api/v1/retailer/product-chat/sessions/${sessionId}/mockups`, headers: headers() });
    expect(discarded.statusCode).toBe(200);
    expect(data(discarded).mockupJob).toBeNull();
    expect(data(discarded).readiness).not.toBeNull();
  });
});
