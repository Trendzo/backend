/**
 * Legal-document pipeline (Retailer T&C + Privacy Policy) — both documents run the
 * SAME versioned accept/decline machinery (`retailer_terms` + kind), and the go-live
 * gate requires the current version of BOTH. Locks down:
 *   - the two documents version + accept independently (no cross-satisfaction)
 *   - publishing a new privacy version re-flags retailers without touching T&C state
 *   - go-live gate names the missing document and passes only when both are accepted
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '@/db/client.js';
import { adminAccounts, retailerAccounts, retailerStores } from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { assertTermsAcceptedForGoLive } from '@/shared/terms.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;

let app: App;
let adminToken: string;

async function makeStore() {
  const storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: `Legal Docs Store ${storeId.slice(-6)}`,
    gstin: '27AAFCK1234M1Z5',
    address: '1 Test Rd, Mumbai, MH',
    stateCode: 'MH',
    lat: 19.06,
    lng: 72.83,
    status: 'active',
    platformFeeBp: 200,
  });
  await db.insert(retailerAccounts).values({
    id: retailerId,
    storeId,
    email: `owner+${retailerId}@test.local`,
    passwordHash: 'x'.repeat(20),
    legalName: 'Owner',
    phone: `+9191${Math.floor(10000000 + Math.random() * 89999999)}`,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  return {
    storeId,
    retailerToken: signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' as const }),
  };
}

const retailerGet = (path: string, token: string) =>
  app.inject({ method: 'GET', url: `/api/v1/retailer${path}`, headers: auth(token) });
const retailerPost = (path: string, token: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1/retailer${path}`, headers: auth(token), payload });

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

describe('privacy policy pipeline (mirror of the T&C)', () => {
  it('serves distinct documents; accepting one does not satisfy the other', async () => {
    const { retailerToken } = await makeStore();

    const terms = data(await retailerGet('/terms', retailerToken));
    const privacy = data(await retailerGet('/privacy', retailerToken));
    expect(terms.version).not.toBe(privacy.version);
    expect(privacy.shortText).toContain('Privacy Policy');

    let me = data(await retailerGet('/me', retailerToken));
    expect(me.termsAcceptanceRequired).toBe(true);
    expect(me.privacyAcceptanceRequired).toBe(true);

    // Accept ONLY the terms — privacy must stay pending.
    const acceptTerms = await retailerPost('/terms/accept', retailerToken, { version: terms.version });
    expect(acceptTerms.statusCode).toBe(200);
    me = data(await retailerGet('/me', retailerToken));
    expect(me.termsAcceptanceRequired).toBe(false);
    expect(me.privacyAcceptanceRequired).toBe(true);
    expect(me.privacyStatus).toBe('pending');

    const acceptPrivacy = await retailerPost('/privacy/accept', retailerToken, { version: privacy.version });
    expect(acceptPrivacy.statusCode).toBe(200);
    me = data(await retailerGet('/me', retailerToken));
    expect(me.privacyAcceptanceRequired).toBe(false);
    expect(me.privacyStatus).toBe('accepted');
  });

  it('go-live gate requires BOTH documents and names the missing one', async () => {
    const { storeId, retailerToken } = await makeStore();
    const terms = data(await retailerGet('/terms', retailerToken));
    await retailerPost('/terms/accept', retailerToken, { version: terms.version });

    await expect(assertTermsAcceptedForGoLive(db, storeId)).rejects.toThrow(/Privacy Policy/);

    const privacy = data(await retailerGet('/privacy', retailerToken));
    await retailerPost('/privacy/accept', retailerToken, { version: privacy.version });
    await expect(assertTermsAcceptedForGoLive(db, storeId)).resolves.toBeUndefined();
  });

  it('publishing a new privacy version re-flags retailers without touching T&C state', async () => {
    const { retailerToken } = await makeStore();
    const terms = data(await retailerGet('/terms', retailerToken));
    const privacy = data(await retailerGet('/privacy', retailerToken));
    await retailerPost('/terms/accept', retailerToken, { version: terms.version });
    await retailerPost('/privacy/accept', retailerToken, { version: privacy.version });

    const publish = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/terms',
      headers: auth(adminToken),
      payload: { kind: 'privacy', shortText: 'Updated privacy policy body — long enough to pass validation.' },
    });
    expect(publish.statusCode).toBe(200);

    const me = data(await retailerGet('/me', retailerToken));
    expect(me.privacyAcceptanceRequired).toBe(true); // re-flagged by the new version
    expect(me.termsAcceptanceRequired).toBe(false); // T&C untouched
    expect(me.currentPrivacyVersion).toBe(data(publish).id);

    // Admin listing is kind-scoped: the new version is current for privacy only.
    const privacyList = data(
      await app.inject({ method: 'GET', url: '/api/v1/admin/terms?kind=privacy', headers: auth(adminToken) }),
    );
    expect(privacyList.current.version).toBe(data(publish).id);
    const termsList = data(
      await app.inject({ method: 'GET', url: '/api/v1/admin/terms', headers: auth(adminToken) }),
    );
    expect(termsList.current.version).not.toBe(data(publish).id);

    // Accepting the STALE version 409s; accepting the new one clears the flag.
    const stale = await retailerPost('/privacy/accept', retailerToken, { version: privacy.version });
    expect(stale.statusCode).toBe(409);
    const fresh = await retailerPost('/privacy/accept', retailerToken, { version: data(publish).id });
    expect(fresh.statusCode).toBe(200);
  });

  it('signup-form consent seeds both acceptances on approval — no post-login gate', async () => {
    const n = Math.floor(10000000 + Math.random() * 89999999);
    const submit = await app.inject({
      method: 'POST',
      url: '/api/v1/applications',
      payload: {
        legalName: 'Consent Test Store',
        gstin: '27AAFCK1234M1Z5',
        ownerName: 'Consent Owner',
        ownerEmail: `consent+${n}@test.local`,
        ownerPhone: `+9198${n}`,
        addressLine: '12 Consent Rd, Mumbai',
        pincode: '400001',
        stateCode: '27',
        password: 'consent-pass-123',
        acceptLegal: true,
      },
    });
    expect(submit.statusCode).toBe(200);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/applications/${data(submit).id}/approve`,
      headers: auth(adminToken),
      payload: { platformFeeBp: 1000 },
    });
    expect(approve.statusCode).toBe(200);

    const token = signAccessToken({
      sub: data(approve).retailerId as string,
      kind: 'retailer',
      subRole: 'owner' as const,
    });
    const me = data(await retailerGet('/me', token));
    expect(me.termsAcceptanceRequired).toBe(false);
    expect(me.privacyAcceptanceRequired).toBe(false);

    // A NEWER privacy version published after signup still re-prompts (version-pinned).
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/terms',
      headers: auth(adminToken),
      payload: { kind: 'privacy', shortText: 'Newer privacy policy that shipped after this applicant signed up.' },
    });
    const me2 = data(await retailerGet('/me', token));
    expect(me2.privacyAcceptanceRequired).toBe(true);
    expect(me2.termsAcceptanceRequired).toBe(false);
  });

  it('public view routes serve the latest published content — no auth needed', async () => {
    // JSON — both kinds, unauthenticated.
    const terms = await app.inject({ method: 'GET', url: '/api/v1/legal/terms' });
    expect(terms.statusCode).toBe(200);
    expect(data(terms).shortText.length).toBeGreaterThan(20);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/legal/refund' });
    expect(bad.statusCode).toBe(422); // zod param validation


    // Publish a new privacy version → public JSON AND the public HTML page serve it.
    const marker = `Public-view marker ${Math.floor(Math.random() * 1e9)} — updated privacy policy body.`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/terms',
      headers: auth(adminToken),
      payload: { kind: 'privacy', shortText: marker },
    });
    const privacy = await app.inject({ method: 'GET', url: '/api/v1/legal/privacy' });
    expect(data(privacy).shortText).toBe(marker);

    const html = await app.inject({ method: 'GET', url: '/privacy' });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('Public-view marker');
    // Terms page renders the terms document, not the privacy one.
    const termsHtml = await app.inject({ method: 'GET', url: '/terms' });
    expect(termsHtml.body).not.toContain('Public-view marker');
    expect(termsHtml.body).toContain('Retailer Terms');
  });

  it('declining the privacy policy is recorded but leaves it required', async () => {
    const { retailerToken } = await makeStore();
    const privacy = data(await retailerGet('/privacy', retailerToken));
    const decline = await retailerPost('/privacy/decline', retailerToken, { version: privacy.version });
    expect(decline.statusCode).toBe(200);
    const me = data(await retailerGet('/me', retailerToken));
    expect(me.privacyAcceptanceRequired).toBe(true);
  });
});
