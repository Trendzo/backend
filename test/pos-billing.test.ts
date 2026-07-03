import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import { adminAccounts, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const json = (res: InjectRes) => JSON.parse(res.body);
const data = (res: InjectRes) => json(res).data;

let app: App;
let adminToken: string;

/** Fresh store+owner account per test so POS state doesn't leak between cases. */
async function makeStore(posBillingEnabled: boolean): Promise<{ storeId: string; accountId: string; token: string }> {
  const storeId = newId(IdPrefix.Store);
  const accountId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: `LE_${storeId}`,
    legalName: 'POS Test Store',
    gstin: '27AAFCK1234M1Z5',
    address: '1 Test Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
    posBillingEnabled,
  });
  await db.insert(retailerAccounts).values({
    id: accountId,
    storeId,
    email: `owner+${accountId}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: '+91900000000',
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  const token = signAccessToken({ sub: accountId, kind: 'retailer', subRole: 'owner' });
  return { storeId, accountId, token };
}

const posHeld = (token: string) =>
  app.inject({ method: 'GET', url: '/api/v1/retailer/pos/held', headers: auth(token) });

const setPosBilling = (accountId: string, enabled: boolean) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/admin/retailers/${accountId}/pos-billing`,
    headers: auth(adminToken),
    payload: { enabled, reason: 'test toggle' },
  });

const submitActivation = (token: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/retailer/change-requests',
    headers: auth(token),
    payload: {
      field: 'pos_billing_activation',
      currentValue: 'disabled',
      requestedValue: 'enabled',
      reason: 'Please enable POS for my store.',
    },
  });

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  const adminId = newId(IdPrefix.Admin);
  await db.insert(adminAccounts).values({
    id: adminId,
    email: `admin+${adminId}@test.local`,
    passwordHash: 'x'.repeat(20),
    subRole: 'super_admin',
  });
  adminToken = signAccessToken({ sub: adminId, kind: 'admin', subRole: 'super_admin' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('pos-billing — default + guard', () => {
  it('a new store defaults to POS disabled and 403s POS endpoints', async () => {
    const { token } = await makeStore(false);
    const res = await posHeld(token);
    expect(res.statusCode).toBe(403);
  });

  it('an enabled store can reach POS endpoints', async () => {
    const { token } = await makeStore(true);
    const res = await posHeld(token);
    expect(res.statusCode).toBe(200);
  });
});

describe('pos-billing — admin toggle', () => {
  it('admin enable → POS reachable; admin disable → POS 403', async () => {
    const { accountId, token } = await makeStore(false);
    expect((await posHeld(token)).statusCode).toBe(403);

    const enable = await setPosBilling(accountId, true);
    expect(enable.statusCode).toBe(200);
    expect(data(enable).posBillingEnabled).toBe(true);
    expect((await posHeld(token)).statusCode).toBe(200);

    const disable = await setPosBilling(accountId, false);
    expect(disable.statusCode).toBe(200);
    expect((await posHeld(token)).statusCode).toBe(403);
  });
});

describe('pos-billing — activation request workflow', () => {
  it('rejects a second pending request (one-per-field dedup)', async () => {
    const { token } = await makeStore(false);
    const first = await submitActivation(token);
    expect(first.statusCode).toBe(200);
    const second = await submitActivation(token);
    expect(second.statusCode).toBe(409);
  });

  it('admin approving the request enables POS', async () => {
    const { token } = await makeStore(false);
    const req = await submitActivation(token);
    const crId = data(req).id as string;

    const decide = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/compliance/change-requests/${crId}/decide`,
      headers: auth(adminToken),
      payload: { decision: 'approved' },
    });
    expect(decide.statusCode).toBe(200);
    expect((await posHeld(token)).statusCode).toBe(200);
  });

  it('rejects an activation request when POS is already enabled', async () => {
    const { token } = await makeStore(true);
    const res = await submitActivation(token);
    expect(res.statusCode).toBe(409);
  });
});
