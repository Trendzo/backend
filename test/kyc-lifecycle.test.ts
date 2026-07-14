/**
 * KYC re-verification lifecycle — end-to-end over the embedded test Postgres.
 *
 * The loop this file locks down did not previously work at all:
 *   - `rejected` was terminal (upload + submit both required `pending`), so the only
 *     escape from a rejection was an admin re-trigger that DISCARDED every uploaded doc.
 *   - there was no per-document review, so a reviewer could not say "PAN is fine,
 *     address proof is blurry" — the decision blanket-stamped all five.
 *   - `overdue` had zero writers and the grace-period auto-pause never existed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import {
  adminAccounts,
  kycDocuments,
  kycReverifications,
  retailerAccounts,
  retailerStores,
} from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { KYC_REQUIRED_DOC_KINDS } from '@/shared/kyc/doc-kinds.js';
import { sweepKycDeadlines } from '@/shared/kyc/sweep.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;
const FILE = 'https://cdn.test/doc.pdf';

let app: App;
let adminToken: string;

/** A fresh store + owner per test — cycles are per-store, so this keeps them isolated. */
async function makeStore() {
  const storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: `LE_${storeId}`,
    legalName: 'KYC Test Store',
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
    phone: `+9190${Math.floor(10000000 + Math.random() * 89999999)}`,
    gstin: '27AAFCK1234M1Z5',
    subRole: 'owner',
    status: 'active',
  });
  return {
    storeId,
    token: signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' }),
  };
}

const adminPost = (path: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/admin${path}`, headers: auth(adminToken), payload });
const adminGet = (path: string) =>
  app.inject({ method: 'GET', url: `/api/v1/admin${path}`, headers: auth(adminToken) });
const retailerPost = (token: string, path: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/v1${path}`, headers: auth(token), payload });
const retailerGet = (token: string, path: string) =>
  app.inject({ method: 'GET', url: `/api/v1${path}`, headers: auth(token) });

/** Admin opens a cycle; returns the retailer's view of it. */
async function openCycle(storeId: string, token: string) {
  const res = await adminPost(`/compliance/stores/${storeId}/reverify`, { reason: 'annual check' });
  expect(res.statusCode).toBe(200);
  const cycle = data(await retailerGet(token, '/retailer/kyc'));
  expect(cycle.status).toBe('pending');
  expect(cycle.documents).toHaveLength(KYC_REQUIRED_DOC_KINDS.length);
  return cycle;
}

/** Retailer uploads every required document. */
async function uploadAll(token: string, cycleId: string) {
  for (const kind of KYC_REQUIRED_DOC_KINDS) {
    const res = await retailerPost(token, `/retailer/kyc/${cycleId}/documents`, {
      kind,
      url: `${FILE}?${kind}`,
    });
    expect(res.statusCode).toBe(200);
  }
}

const cycleRow = (id: string) =>
  db.query.kycReverifications.findFirst({ where: eq(kycReverifications.id, id) });
const storeRow = (id: string) =>
  db.query.retailerStores.findFirst({ where: eq(retailerStores.id, id) });
const docsOf = (cycleId: string) =>
  db.query.kycDocuments.findMany({ where: eq(kycDocuments.reverificationId, cycleId) });

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

describe('KYC — happy path', () => {
  it('trigger → upload → submit → verify each doc → approve', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);

    await uploadAll(token, cycle.id);
    expect((await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`)).statusCode).toBe(200);
    expect((await cycleRow(cycle.id))!.status).toBe('submitted');
    expect((await cycleRow(cycle.id))!.submittedAt).toBeTruthy();

    // Only submitted cycles are an admin task — the desk filters on it.
    const listed = data(await adminGet('/compliance/kyc?status=submitted')) as { id: string }[];
    expect(listed.some((c) => c.id === cycle.id)).toBe(true);

    // Verify each document individually.
    for (const d of await docsOf(cycle.id)) {
      const res = await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, {
        decision: 'verified',
      });
      expect(res.statusCode).toBe(200);
    }

    expect((await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' })).statusCode).toBe(200);

    const done = await cycleRow(cycle.id);
    expect(done!.status).toBe('approved');
    expect(done!.lastVerifiedAt).toBeTruthy();
    expect((await docsOf(cycle.id)).every((d) => d.status === 'verified')).toBe(true);
  });
});

describe('KYC — the reject loop (rejection is NOT a dead end)', () => {
  it('rejects one doc, retailer replaces only that one, re-submits, gets approved', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);

    const docs = await docsOf(cycle.id);
    const bad = docs.find((d) => d.kind === 'pan_card')!;
    const good = docs.filter((d) => d.id !== bad.id);

    for (const d of good) {
      await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, { decision: 'verified' });
    }
    expect(
      (await adminPost(`/compliance/kyc/${cycle.id}/documents/${bad.id}/decide`, {
        decision: 'rejected',
        note: 'PAN is blurry — re-scan it',
      })).statusCode,
    ).toBe(200);

    // Send the cycle back.
    expect(
      (await adminPost(`/compliance/kyc/${cycle.id}/decide`, {
        decision: 'rejected',
        reason: 'One document needs replacing',
      })).statusCode,
    ).toBe(200);
    expect((await cycleRow(cycle.id))!.status).toBe('rejected');

    // The retailer can SEE why — this was never serialized before.
    const seen = data(await retailerGet(token, '/retailer/kyc'));
    expect(seen.decisionReason).toBe('One document needs replacing');
    const seenBad = seen.documents.find((d: { kind: string }) => d.kind === 'pan_card');
    expect(seenBad.status).toBe('rejected');
    expect(seenBad.reviewerNote).toBe('PAN is blurry — re-scan it');

    // Replace ONLY the rejected document — no 409, and nothing was discarded.
    const reup = await retailerPost(token, `/retailer/kyc/${cycle.id}/documents`, {
      kind: 'pan_card',
      url: `${FILE}?pan_v2`,
    });
    expect(reup.statusCode).toBe(200);

    const after = await docsOf(cycle.id);
    expect(after.find((d) => d.kind === 'pan_card')!.status).toBe('pending_review');
    // The other four survived the round trip and stay verified.
    expect(after.filter((d) => d.status === 'verified')).toHaveLength(4);

    // Re-submit the SAME cycle and approve.
    expect((await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`)).statusCode).toBe(200);
    expect((await cycleRow(cycle.id))!.status).toBe('submitted');
    const fixed = (await docsOf(cycle.id)).find((d) => d.kind === 'pan_card')!;
    await adminPost(`/compliance/kyc/${cycle.id}/documents/${fixed.id}/decide`, { decision: 'verified' });
    expect((await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' })).statusCode).toBe(200);
    expect((await cycleRow(cycle.id))!.status).toBe('approved');
  });

  it('a rejection does NOT wipe the store\'s last good verification', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    for (const d of await docsOf(cycle.id)) {
      await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, { decision: 'verified' });
    }
    await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });
    const verifiedAt = (await cycleRow(cycle.id))!.lastVerifiedAt;
    expect(verifiedAt).toBeTruthy();

    // A fresh cycle that gets rejected must not null it out.
    const next = await openCycle(storeId, token);
    await uploadAll(token, next.id);
    await retailerPost(token, `/retailer/kyc/${next.id}/submit`);
    const one = (await docsOf(next.id))[0]!;
    await adminPost(`/compliance/kyc/${next.id}/documents/${one.id}/decide`, { decision: 'rejected', note: 'no' });
    await adminPost(`/compliance/kyc/${next.id}/decide`, { decision: 'rejected', reason: 'nope' });
    expect((await cycleRow(next.id))!.lastVerifiedAt).toBeTruthy();
  });
});

describe('KYC — guards', () => {
  it('cannot decide a cycle the retailer never submitted', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    const res = await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });
    expect(res.statusCode).toBe(409);
  });

  it('cannot approve while any required document is unverified', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    // Verify only one of five.
    const first = (await docsOf(cycle.id))[0]!;
    await adminPost(`/compliance/kyc/${cycle.id}/documents/${first.id}/decide`, { decision: 'verified' });
    const res = await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });
    expect(res.statusCode).toBe(422);
  });

  it('cannot send a cycle back without rejecting a document', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    const res = await adminPost(`/compliance/kyc/${cycle.id}/decide`, {
      decision: 'rejected',
      reason: 'vibes',
    });
    expect(res.statusCode).toBe(422);
  });

  it('cannot submit before every document is uploaded', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/documents`, {
      kind: 'pan_card',
      url: FILE,
    });
    const res = await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    expect(res.statusCode).toBe(422);
  });

  it('rejects an off-list document kind instead of inserting an orphan row', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    const res = await retailerPost(token, `/retailer/kyc/${cycle.id}/documents`, {
      kind: 'passport',
      url: FILE,
    });
    // Schema validation rejects it outright (was a free string that silently inserted a 6th row).
    expect(res.statusCode).toBe(422);
    expect(await docsOf(cycle.id)).toHaveLength(KYC_REQUIRED_DOC_KINDS.length);
  });

  it('neither upload path can touch a cycle that is under review', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);

    // The kyc route.
    const viaKyc = await retailerPost(token, `/retailer/kyc/${cycle.id}/documents`, {
      kind: 'pan_card',
      url: `${FILE}?sneaky`,
    });
    expect(viaKyc.statusCode).toBe(409);

    // The store-ops route — this one had NO status guard at all and could silently
    // flip a verified document back to pending_review on a decided cycle.
    const doc = (await docsOf(cycle.id))[0]!;
    const viaStoreOps = await retailerPost(token, `/retailer/store/documents/${doc.id}/upload`, {
      url: `${FILE}?sneaky2`,
    });
    expect(viaStoreOps.statusCode).toBe(409);
  });
});

describe('KYC — deadline sweep + auto-pause enforcement', () => {
  it('marks an unsubmitted cycle overdue, then pauses the store once grace lapses', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);

    // Past due, grace still open.
    await db
      .update(kycReverifications)
      .set({
        dueAt: new Date(Date.now() - 2 * 86_400_000),
        gracePeriodEndsAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(kycReverifications.id, cycle.id));

    let counts = await sweepKycDeadlines(db);
    expect(counts.markedOverdue).toBeGreaterThanOrEqual(1);
    expect((await cycleRow(cycle.id))!.status).toBe('overdue');
    // Overdue is still writable — the retailer can catch up.
    expect((await storeRow(storeId))!.status).toBe('active');

    // Now the grace period lapses.
    await db
      .update(kycReverifications)
      .set({ gracePeriodEndsAt: new Date(Date.now() - 3_600_000) })
      .where(eq(kycReverifications.id, cycle.id));

    counts = await sweepKycDeadlines(db);
    expect(counts.storesPaused).toBeGreaterThanOrEqual(1);
    const paused = await storeRow(storeId);
    expect(paused!.status).toBe('paused');
    expect(paused!.pauseReason).toBe('kyc_overdue');

    // Idempotent — a second pass doesn't re-pause.
    expect((await sweepKycDeadlines(db)).storesPaused).toBe(0);

    // The retailer can still fix it while overdue, and approval un-pauses the store.
    await uploadAll(token, cycle.id);
    expect((await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`)).statusCode).toBe(200);
    for (const d of await docsOf(cycle.id)) {
      await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, { decision: 'verified' });
    }
    await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });

    const resumed = await storeRow(storeId);
    expect(resumed!.status).toBe('active');
    expect(resumed!.pauseReason).toBeNull();
  });

  it('never un-pauses a store a human paused deliberately', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    // An admin pause, for an unrelated reason.
    await db
      .update(retailerStores)
      .set({ status: 'paused', pauseReason: 'manual review', pauseVisibility: 'hidden' })
      .where(eq(retailerStores.id, storeId));

    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    for (const d of await docsOf(cycle.id)) {
      await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, { decision: 'verified' });
    }
    await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });

    const still = await storeRow(storeId);
    expect(still!.status).toBe('paused');
    expect(still!.pauseReason).toBe('manual review');
  });
});

describe('KYC — listing', () => {
  it('honours ?status= and no longer returns every cycle that ever existed', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);

    const pending = data(await adminGet('/compliance/kyc?status=pending')) as { id: string }[];
    expect(pending.some((c) => c.id === cycle.id)).toBe(true);

    const submitted = data(await adminGet('/compliance/kyc?status=submitted')) as { id: string }[];
    expect(submitted.some((c) => c.id === cycle.id)).toBe(false);

    // A decided cycle must drop off the submitted desk.
    await uploadAll(token, cycle.id);
    await retailerPost(token, `/retailer/kyc/${cycle.id}/submit`);
    expect(
      (data(await adminGet('/compliance/kyc?status=submitted')) as { id: string }[]).some(
        (c) => c.id === cycle.id,
      ),
    ).toBe(true);

    for (const d of await docsOf(cycle.id)) {
      await adminPost(`/compliance/kyc/${cycle.id}/documents/${d.id}/decide`, { decision: 'verified' });
    }
    await adminPost(`/compliance/kyc/${cycle.id}/decide`, { decision: 'approved' });

    expect(
      (data(await adminGet('/compliance/kyc?status=submitted')) as { id: string }[]).some(
        (c) => c.id === cycle.id,
      ),
    ).toBe(false);
  });

  it('a re-trigger on a live cycle preserves the retailer\'s uploads', async () => {
    const { storeId, token } = await makeStore();
    const cycle = await openCycle(storeId, token);
    await uploadAll(token, cycle.id);

    // Re-triggering used to insert a BRAND NEW cycle, orphaning every uploaded document.
    await adminPost(`/compliance/stores/${storeId}/reverify`, { reason: 'nudge' });

    const same = data(await retailerGet(token, '/retailer/kyc'));
    expect(same.id).toBe(cycle.id);
    expect(same.documents.every((d: { status: string }) => d.status !== 'missing')).toBe(true);
  });
});

// Keep the unused-import checker honest about `and` — used by nothing else here.
void and;
