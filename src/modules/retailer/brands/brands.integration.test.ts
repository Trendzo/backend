import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { buildApp } from '@/app.js';
import { db } from '@/db/client.js';
import { brands, retailerAccounts } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';

type Envelope<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } };

const json = <T>(res: { json(): unknown }) => res.json() as Envelope<T>;

describe('retailer brand logos', () => {
  let app: FastifyInstance;
  const ownerId = newId(IdPrefix.Retailer);
  const otherId = newId(IdPrefix.Retailer);
  const ownerToken = signAccessToken({ kind: 'retailer', sub: ownerId, subRole: 'owner' });
  const otherToken = signAccessToken({ kind: 'retailer', sub: otherId, subRole: 'owner' });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    await db.insert(retailerAccounts).values([
      {
        id: ownerId,
        email: `${ownerId}@example.test`,
        passwordHash: 'test',
        legalName: 'Logo Owner',
        phone: `900${ownerId.slice(-7)}`,
        gstin: `GST${ownerId.slice(-12)}`,
        subRole: 'owner',
        status: 'active',
      },
      {
        id: otherId,
        email: `${otherId}@example.test`,
        passwordHash: 'test',
        legalName: 'Logo Other',
        phone: `901${otherId.slice(-7)}`,
        gstin: `GST${otherId.slice(-12)}`,
        subRole: 'owner',
        status: 'active',
      },
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a brand with a logo and records the retailer creator', async () => {
    const slug = `logo-${Date.now()}`;
    const logoUrl = 'https://cdn.example.test/brand-logo.png';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/brands',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { slug, name: `Logo Brand ${slug}`, logoUrl },
    });

    expect(res.statusCode).toBe(200);
    const body = json<Record<string, unknown> & { id: string; logoUrl: string | null; canEditLogo: boolean }>(res);
    expect(body.success).toBe(true);
    if (!body.success) return;
    expect(body.data.logoUrl).toBe(logoUrl);
    expect(body.data.canEditLogo).toBe(true);
    expect(body.data).not.toHaveProperty('createdByRetailerAccountId');
    expect(body.data).not.toHaveProperty('createdByAdminId');

    const stored = await db.query.brands.findFirst({ where: eq(brands.id, body.data.id) });
    expect(stored?.createdByRetailerAccountId).toBe(ownerId);
  });

  it('lists visible brands with creator-only logo edit flags', async () => {
    const ownSlug = `owned-${Date.now()}`;
    const adminSlug = `admin-${Date.now()}`;
    await db.insert(brands).values([
      {
        id: newId(IdPrefix.Brand),
        slug: ownSlug,
        name: `Owned ${ownSlug}`,
        createdByRetailerAccountId: ownerId,
        isActive: true,
      },
      {
        id: newId(IdPrefix.Brand),
        slug: adminSlug,
        name: `Admin ${adminSlug}`,
        isActive: true,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/retailer/brands',
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = json<Array<Record<string, unknown> & { slug: string; logoUrl: string | null; canEditLogo: boolean }>>(res);
    expect(body.success).toBe(true);
    if (!body.success) return;
    expect(body.data.find((b) => b.slug === ownSlug)?.canEditLogo).toBe(true);
    expect(body.data.find((b) => b.slug === adminSlug)?.canEditLogo).toBe(false);
    expect(body.data.find((b) => b.slug === ownSlug)).not.toHaveProperty(
      'createdByRetailerAccountId',
    );
    expect(body.data.find((b) => b.slug === adminSlug)).not.toHaveProperty('createdByAdminId');
  });

  it('lets only the creating retailer update or clear a logo', async () => {
    const id = newId(IdPrefix.Brand);
    await db.insert(brands).values({
      id,
      slug: `patch-${Date.now()}`,
      name: `Patch Logo ${Date.now()}`,
      logoUrl: 'https://cdn.example.test/old.png',
      createdByRetailerAccountId: ownerId,
      isActive: true,
    });

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/retailer/brands/${id}/logo`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { logoUrl: 'https://cdn.example.test/nope.png' },
    });
    expect(denied.statusCode).toBe(403);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/retailer/brands/${id}/logo`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { logoUrl: 'https://cdn.example.test/new.png' },
    });
    expect(updated.statusCode).toBe(200);
    expect(json<{ logoUrl: string | null }>(updated).success).toBe(true);

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/retailer/brands/${id}/logo`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { logoUrl: null },
    });
    expect(cleared.statusCode).toBe(200);
    const stored = await db.query.brands.findFirst({ where: eq(brands.id, id) });
    expect(stored?.logoUrl).toBeNull();
  });

  it('keeps catalog brand payloads public while returning logoUrl', async () => {
    const slug = `catalog-logo-${Date.now()}`;
    const logoUrl = 'https://cdn.example.test/catalog-logo.png';
    await db.insert(brands).values({
      id: newId(IdPrefix.Brand),
      slug,
      name: `Catalog Logo ${Date.now()}`,
      logoUrl,
      createdByRetailerAccountId: ownerId,
      isActive: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/brands',
    });

    expect(res.statusCode).toBe(200);
    const body = json<Array<Record<string, unknown> & { slug: string; logoUrl: string | null }>>(
      res,
    );
    expect(body.success).toBe(true);
    if (!body.success) return;
    const brand = body.data.find((b) => b.slug === slug);
    expect(brand?.logoUrl).toBe(logoUrl);
    expect(brand).not.toHaveProperty('createdByRetailerAccountId');
    expect(brand).not.toHaveProperty('createdByAdminId');
    expect(brand).not.toHaveProperty('canEditLogo');
  });
});
