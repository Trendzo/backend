/**
 * Phone-OTP logins end to end through the real Fastify app, using the fake provider
 * (OTP_PROVIDER=fake: a token is `fake:<phone>`). Covers the provider-neutral `/otp/login`
 * paths, the legacy `/otp/msg91` paths shipped builds still call, the account rules each
 * login keeps, and the public config clients bootstrap from.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client.js';
import { consumers, deliveryAgents, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type Res = { statusCode: number; body: string };
const json = (r: Res) => JSON.parse(r.body);
/** Real access tokens are long JWTs (the body schema needs >= 20 chars); pad the fake one. */
const tok = (phone: string) => `fake:${phone}:${'x'.repeat(24)}`;

let app: App;
const rnd = () => String(Math.floor(1_000_000_00 + Math.random() * 8_000_000_00)).slice(0, 8);
const post = (url: string, payload: object) =>
  app.inject({ method: 'POST', url, payload }) as Promise<Res>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /auth/otp-config', () => {
  it('is public and tells clients the provider, what is accepted and the code length', async () => {
    const res = (await app.inject({ method: 'GET', url: '/api/v1/auth/otp-config' })) as Res;
    expect(res.statusCode).toBe(200);
    expect(json(res).data).toMatchObject({ provider: 'fake', accepts: ['fake'] });
    expect(typeof json(res).data.otpLength).toBe('number');
    expect(res.body).not.toMatch(/sk_|api_?key/i);
  });

  it('accepts ?client=web and rejects an unknown client', async () => {
    const web = (await app.inject({
      method: 'GET',
      url: '/api/v1/auth/otp-config?client=web',
    })) as Res;
    expect(web.statusCode).toBe(200);
    const bad = (await app.inject({
      method: 'GET',
      url: '/api/v1/auth/otp-config?client=tv',
    })) as Res;
    expect(bad.statusCode).toBe(422);
  });
});

describe('consumer', () => {
  for (const path of ['/api/v1/auth/consumer/otp/login', '/api/v1/auth/consumer/otp/msg91']) {
    it(`${path}: first verify creates the account, the next one reuses it`, async () => {
      const national = `98${rnd()}`.slice(0, 10);
      const first = await post(path, { accessToken: tok(`+91${national}`) });
      expect(first.statusCode).toBe(200);
      const a = json(first).data;
      expect(a.token).toBeTruthy();
      expect(a.consumer.phone).toBe(national);

      const second = await post(path, { accessToken: tok(`+91${national}`) });
      expect(json(second).data.consumer.id).toBe(a.consumer.id);
      const rows = await db.select().from(consumers).where(eq(consumers.phone, national));
      expect(rows).toHaveLength(1);
    });
  }

  it('rejects a bad token (401) and a provider tag the server does not accept (422)', async () => {
    expect(
      (await post('/api/v1/auth/consumer/otp/login', { accessToken: 'x'.repeat(30) })).statusCode,
    ).toBe(401);
    const tagged = await post('/api/v1/auth/consumer/otp/login', {
      accessToken: tok('+919800000099'),
      provider: 'slide',
    });
    expect(tagged.statusCode).toBe(422);
  });

  it('refuses a suspended consumer', async () => {
    const national = `97${rnd()}`.slice(0, 10);
    await db.insert(consumers).values({
      id: newId(IdPrefix.Consumer),
      phone: national,
      referralCode: `R${rnd()}`,
      status: 'suspended',
    });
    const res = await post('/api/v1/auth/consumer/otp/login', {
      accessToken: tok(`+91${national}`),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('retailer', () => {
  const phone = `+9194${rnd()}`;

  beforeAll(async () => {
    const storeId = newId(IdPrefix.Store);
    const retailerId = newId(IdPrefix.Retailer);
    await db.insert(retailerStores).values({
      id: storeId,
      legalEntityId: retailerId,
      legalName: 'OTP Login Store',
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
      email: `otp+${retailerId}@test.local`,
      passwordHash: 'x'.repeat(20),
      legalName: 'Owner',
      phone,
      gstin: '27AAFCK1234M1Z5',
      subRole: 'owner',
      status: 'active',
    });
  });

  for (const path of ['/api/v1/auth/retailer/otp/login', '/api/v1/auth/retailer/otp/msg91']) {
    it(`${path}: an existing account signs in; an unknown phone is a 401 (no account is created)`, async () => {
      const ok = await post(path, { accessToken: tok(phone) });
      expect(ok.statusCode).toBe(200);
      expect(json(ok).data.retailer.phone).toBe(phone);
      expect(json(ok).data.token).toBeTruthy();

      const unknown = `+9193${rnd()}`;
      const no = await post(path, { accessToken: tok(unknown) });
      expect(no.statusCode).toBe(401);
      const rows = await db
        .select()
        .from(retailerAccounts)
        .where(eq(retailerAccounts.phone, unknown));
      expect(rows).toHaveLength(0);
    });
  }
});

describe('driver', () => {
  for (const path of ['/api/v1/auth/driver/otp/login', '/api/v1/auth/driver/otp/msg91']) {
    it(`${path}: first verify creates the driver (isNew), the next one does not`, async () => {
      const phone = `+9196${rnd()}`;
      const first = await post(path, { accessToken: tok(phone) });
      expect(first.statusCode).toBe(200);
      expect(json(first).data.isNew).toBe(true);
      expect(json(first).data.driver.phone).toBe(phone);

      const second = await post(path, { accessToken: tok(phone) });
      expect(json(second).data.isNew).toBe(false);
      const rows = await db.select().from(deliveryAgents).where(eq(deliveryAgents.phone, phone));
      expect(rows).toHaveLength(1);
    });
  }
});
