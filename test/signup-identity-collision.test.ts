/**
 * Signup identifier-collision precision: the backend must say EXACTLY which of
 * email / phone is already taken (and whether an approved account owns it), so
 * the UI can point the user at the right sign-in method — never a vague
 * "email or phone taken".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import { retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };
const data = (res: InjectRes) => JSON.parse(res.body).data;
const errBody = (res: InjectRes) => JSON.parse(res.body).error;

let app: App;

// A known approved account whose email + phone are "taken".
const TAKEN_EMAIL = `taken+${newId('x')}@test.local`.toLowerCase();
const TAKEN_PHONE = `+9199${Math.floor(10000000 + Math.random() * 89999999)}`;

const baseBody = (email: string, phone: string) => ({
  legalName: 'Collision Store',
  gstin: '27AAFCK1234M1Z5',
  ownerName: 'Collision Owner',
  ownerEmail: email,
  ownerPhone: phone,
  addressLine: '9 Collision Rd, Mumbai',
  pincode: '400001',
  stateCode: '27',
  password: 'collision-pass-123',
  acceptLegal: true,
});

const submit = (email: string, phone: string) =>
  app.inject({ method: 'POST', url: '/api/v1/applications', payload: baseBody(email, phone) }) as Promise<InjectRes>;

const check = (email: string, phone: string) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/applications/check-identity?email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}`,
  }) as Promise<InjectRes>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: 'Collision Owner Store',
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
    email: TAKEN_EMAIL,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: TAKEN_PHONE,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('submitApplication collision precision', () => {
  it('email taken (phone free) → emailTaken only, account flagged', async () => {
    const freePhone = `+9188${Math.floor(10000000 + Math.random() * 89999999)}`;
    const res = await submit(TAKEN_EMAIL, freePhone);
    expect(res.statusCode).toBe(409);
    const e = errBody(res);
    expect(e.code).toBe('signup_identifier_taken');
    expect(e.details.emailTaken).toBe(true);
    expect(e.details.phoneTaken).toBe(false);
    expect(e.details.accountExists).toBe(true);
    expect(e.message.toLowerCase()).toContain('email');
    expect(e.message.toLowerCase()).not.toContain('phone');
  });

  it('phone taken (email free) → phoneTaken only', async () => {
    const freeEmail = `free+${newId('x')}@test.local`.toLowerCase();
    const res = await submit(freeEmail, TAKEN_PHONE);
    expect(res.statusCode).toBe(409);
    const e = errBody(res);
    expect(e.code).toBe('signup_identifier_taken');
    expect(e.details.emailTaken).toBe(false);
    expect(e.details.phoneTaken).toBe(true);
    expect(e.message.toLowerCase()).toContain('phone');
  });

  it('both taken → both flagged', async () => {
    const res = await submit(TAKEN_EMAIL, TAKEN_PHONE);
    expect(res.statusCode).toBe(409);
    const e = errBody(res);
    expect(e.details.emailTaken).toBe(true);
    expect(e.details.phoneTaken).toBe(true);
    expect(e.message.toLowerCase()).toContain('email');
    expect(e.message.toLowerCase()).toContain('phone');
  });

  it('neither taken → application is created', async () => {
    const n = Math.floor(10000000 + Math.random() * 89999999);
    const res = await submit(`fresh+${n}@test.local`, `+9177${n}`);
    expect(res.statusCode).toBe(200);
    expect(data(res).id).toBeTruthy();
  });
});

describe('checkIdentity account-level flags', () => {
  it('exposes accountEmailTaken / accountPhoneTaken per field', async () => {
    const freePhone = `+9166${Math.floor(10000000 + Math.random() * 89999999)}`;
    const res = await check(TAKEN_EMAIL, freePhone);
    expect(res.statusCode).toBe(200);
    const d = data(res);
    expect(d.emailTaken).toBe(true);
    expect(d.phoneTaken).toBe(false);
    expect(d.accountEmailTaken).toBe(true);
    expect(d.accountPhoneTaken).toBe(false);
    expect(d.accountExists).toBe(true);
  });
});
