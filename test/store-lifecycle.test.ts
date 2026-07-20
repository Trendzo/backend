/**
 * Store + retailer-account lifecycle — end-to-end over the embedded test Postgres.
 *
 * Locks down the single-source-of-truth refactor: `status` alone carries the
 * lifecycle (the redundant `permanent_suspend` boolean is gone) and every transition
 * flows through shared/lifecycle/transitions.ts. The specific regressions pinned here:
 *   - terminate → reinstate used to 409 ("Store is not suspended")
 *   - accounts terminated via REJECT could never be reinstated (boolean-keyed unban)
 *   - account ban cascaded to all stores but unban restored only one
 *   - suspending a PAUSED store violated the pause_guard CHECK (pause fields not cleared)
 *   - the consumer catalog showed terminated/suspended stores' listings
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, pool } from '@/db/client.js';
import {
  adminAccounts,
  categories,
  changeRequests,
  productListings,
  retailerAccounts,
  retailerStores,
  variantGroups,
  variants,
} from '@/db/schema/index.js';
import { signAccessToken } from '@/shared/auth/jwt.js';
import { IdPrefix, newId } from '@/shared/ids.js';
import { buildApp } from '@/app.js';

type App = ReturnType<typeof buildApp>;
type InjectRes = { statusCode: number; body: string };

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const data = (res: InjectRes) => JSON.parse(res.body).data;

let app: App;
let adminToken: string;
let categoryId: string;

/** Fresh store + owner (+ a browsable listing) per test. */
async function makeStore(withListing = false) {
  const storeId = newId(IdPrefix.Store);
  const retailerId = newId(IdPrefix.Retailer);
  await db.insert(retailerStores).values({
    id: storeId,
    legalEntityId: retailerId,
    legalName: `Lifecycle Store ${storeId.slice(-6)}`,
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
  let listingId: string | null = null;
  if (withListing) {
    listingId = newId(IdPrefix.Listing);
    await db.insert(productListings).values({
      id: listingId,
      storeId,
      categoryId,
      name: `Lifecycle Tee ${listingId.slice(-6)}`,
      gender: 'unisex',
      listingPolicy: 'return',
      status: 'active',
      variantMode: 'single',
    });
    const groupId = newId(IdPrefix.VariantGroup);
    await db.insert(variantGroups).values({ id: groupId, listingId, storeId, name: 'Default', isDefault: true });
    await db.insert(variants).values({
      id: newId(IdPrefix.Variant),
      listingId,
      storeId,
      groupId,
      attributes: {},
      attributesLabel: 'One size',
      stock: 100,
      pricePaise: 50_000,
    });
  }
  return {
    storeId,
    retailerId,
    listingId,
    retailerToken: signAccessToken({ sub: retailerId, kind: 'retailer', subRole: 'owner' as const }),
  };
}

const adminPost = (path: string, payload: unknown = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/admin${path}`, headers: auth(adminToken), payload });

const storeRow = (id: string) =>
  db.query.retailerStores.findFirst({ where: eq(retailerStores.id, id) });
const accountRow = (id: string) =>
  db.query.retailerAccounts.findFirst({ where: eq(retailerAccounts.id, id) });

/** Ids of the listings the consumer browse currently shows for a store. */
async function browsable(storeId: string): Promise<string[]> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products?storeId=${storeId}&limit=50`,
  });
  expect(res.statusCode).toBe(200);
  return (data(res) as { id: string }[]).map((l) => l.id);
}

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
  categoryId = newId(IdPrefix.Category);
  await db.insert(categories).values({
    id: categoryId,
    slug: `lifecycle-cat-${categoryId.slice(-6)}`,
    label: 'Lifecycle Category',
    gender: 'unisex',
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('store suspend → unsuspend', () => {
  it('records the reason, hides listings from browse, and restores cleanly', async () => {
    const { storeId, listingId } = await makeStore(true);
    expect(await browsable(storeId)).toContain(listingId);

    expect(
      (await adminPost(`/stores/${storeId}/suspend`, { reason: 'policy review' })).statusCode,
    ).toBe(200);
    const s = await storeRow(storeId);
    expect(s!.status).toBe('suspended');
    expect(s!.suspendReason).toBe('policy review');
    expect(s!.suspendedAt).toBeTruthy();
    // The catalog no longer shows a suspended store's listings (it used to have NO
    // store-status filter at all).
    expect(await browsable(storeId)).toHaveLength(0);

    expect((await adminPost(`/stores/${storeId}/unsuspend`)).statusCode).toBe(200);
    const back = await storeRow(storeId);
    expect(back!.status).toBe('active');
    expect(back!.suspendReason).toBeNull();
    expect(await browsable(storeId)).toContain(listingId);
  });

  it('suspending a PAUSED store clears the pause fields (pause_guard CHECK)', async () => {
    const { storeId } = await makeStore();
    expect(
      (await adminPost(`/stores/${storeId}/pause`, { reason: 'holiday', visibility: 'visible' }))
        .statusCode,
    ).toBe(200);
    // This used to violate retailer_stores_pause_guard (pause fields left set on a
    // non-paused status) and 500.
    const res = await adminPost(`/stores/${storeId}/suspend`, { reason: 'policy review' });
    expect(res.statusCode).toBe(200);
    const s = await storeRow(storeId);
    expect(s!.status).toBe('suspended');
    expect(s!.pauseReason).toBeNull();
    expect(s!.pauseVisibility).toBeNull();
  });
});

describe('store terminate → reinstate (the original bug)', () => {
  it('a banned store can be reinstated', async () => {
    const { storeId, listingId } = await makeStore(true);
    expect((await adminPost(`/stores/${storeId}/ban`, { reason: 'fraud' })).statusCode).toBe(200);
    const dead = await storeRow(storeId);
    expect(dead!.status).toBe('terminated');
    expect(await browsable(storeId)).toHaveLength(0);

    // Used to 409 "Store is not suspended" — the guard read status, the button read
    // the (now deleted) permanentSuspend boolean.
    expect((await adminPost(`/stores/${storeId}/unban`)).statusCode).toBe(200);
    const alive = await storeRow(storeId);
    expect(alive!.status).toBe('active');
    expect(alive!.suspendReason).toBeNull();
    expect(await browsable(storeId)).toContain(listingId);
  });

  it('cannot double-terminate or suspend a terminated store', async () => {
    const { storeId } = await makeStore();
    await adminPost(`/stores/${storeId}/ban`, { reason: 'x' });
    expect((await adminPost(`/stores/${storeId}/ban`, { reason: 'x' })).statusCode).toBe(409);
    expect((await adminPost(`/stores/${storeId}/suspend`, { reason: 'x' })).statusCode).toBe(409);
  });
});

describe('account terminate → reinstate cascade', () => {
  it('ban terminates account + store; unban restores BOTH', async () => {
    const { storeId, retailerId } = await makeStore();
    expect(
      (await adminPost(`/retailers/${retailerId}/ban`, { reason: 'abuse' })).statusCode,
    ).toBe(200);
    expect((await accountRow(retailerId))!.status).toBe('terminated');
    expect((await storeRow(storeId))!.status).toBe('terminated');

    expect((await adminPost(`/retailers/${retailerId}/unban`)).statusCode).toBe(200);
    expect((await accountRow(retailerId))!.status).toBe('active');
    // The cascade used to be asymmetric — ban killed every store, unban revived none
    // matched by legalEntityId.
    expect((await storeRow(storeId))!.status).toBe('active');
  });

  it('a REJECTED account can now be reinstated (status-keyed gate)', async () => {
    const { retailerId } = await makeStore();
    expect(
      (await adminPost(`/retailers/${retailerId}/reject`, { reason: 'docs invalid' })).statusCode,
    ).toBe(200);
    const rejected = await accountRow(retailerId);
    expect(rejected!.status).toBe('terminated');
    expect(rejected!.suspendReason).toBe('docs invalid');

    // The old boolean-keyed guard refused with "Retailer is not banned" because
    // reject never set permanentSuspend — while the middleware had locked the account.
    expect((await adminPost(`/retailers/${retailerId}/unban`)).statusCode).toBe(200);
    expect((await accountRow(retailerId))!.status).toBe('active');
  });

  it('an independently SUSPENDED store keeps its suspension through ban + unban', async () => {
    const { storeId, retailerId } = await makeStore();
    await adminPost(`/stores/${storeId}/suspend`, { reason: 'independent action' });
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'abuse' });
    // The cascade leaves suspended-for-cause stores alone (the account lock already
    // cuts access) so the original suspension — and its reason — survive the round trip.
    const during = await storeRow(storeId);
    expect(during!.status).toBe('suspended');
    expect(during!.suspendReason).toBe('independent action');

    await adminPost(`/retailers/${retailerId}/unban`);
    const after = await storeRow(storeId);
    expect(after!.status).toBe('suspended');
    expect(after!.suspendReason).toBe('independent action');
  });

  it('an independently BANNED store is NOT revived by an account unban', async () => {
    const { storeId, retailerId } = await makeStore();
    // Store banned for cause FIRST — carries no cascade marker.
    await adminPost(`/stores/${storeId}/ban`, { reason: 'counterfeit goods' });
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'unrelated account issue' });
    await adminPost(`/retailers/${retailerId}/unban`);
    const s = await storeRow(storeId);
    expect(s!.status).toBe('terminated');
    expect(s!.suspendReason).toBe('counterfeit goods');
  });

  it('an ONBOARDING store returns to onboarding, not active (go-live gate intact)', async () => {
    const { storeId, retailerId } = await makeStore();
    await db.update(retailerStores).set({ status: 'onboarding' }).where(eq(retailerStores.id, storeId));
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'abuse' });
    expect((await storeRow(storeId))!.status).toBe('terminated');
    await adminPost(`/retailers/${retailerId}/unban`);
    expect((await storeRow(storeId))!.status).toBe('onboarding');
  });
});

describe('policy enforcement transitions', () => {
  it('termination records attribution; lifting a warning on an active store is a no-op', async () => {
    const { storeId } = await makeStore();
    expect(
      (
        await adminPost('/compliance/policy-enforcement', {
          storeId,
          step: 'warning_1',
          breachKind: 'policy_violation',
          reason: 'first strike',
        })
      ).statusCode,
    ).toBe(200);
    expect((await storeRow(storeId))!.status).toBe('active');

    // Lifting while active must not 409 (reinstate only fires for suspended/terminated).
    expect(
      (
        await adminPost('/compliance/policy-enforcement', {
          storeId,
          step: 'lifted',
          breachKind: 'policy_violation',
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await adminPost('/compliance/policy-enforcement', {
          storeId,
          step: 'termination',
          breachKind: 'policy_violation',
          reason: 'third strike',
        })
      ).statusCode,
    ).toBe(200);
    const s = await storeRow(storeId);
    expect(s!.status).toBe('terminated');
    // Policy terminations used to write a bare status with NO reason/actor.
    expect(s!.suspendReason).toBe('third strike');
    expect(s!.suspendedByAccountId).toBeTruthy();
  });
});

describe('catalog browsability by store state', () => {
  it('paused-visible stays browsable; paused-hidden disappears', async () => {
    const { storeId, listingId } = await makeStore(true);

    await adminPost(`/stores/${storeId}/pause`, { reason: 'holiday', visibility: 'visible' });
    expect(await browsable(storeId)).toContain(listingId);

    await adminPost(`/stores/${storeId}/resume`);
    await adminPost(`/stores/${storeId}/pause`, { reason: 'holiday', visibility: 'hidden' });
    expect(await browsable(storeId)).toHaveLength(0);
  });
});

describe('middleware lock', () => {
  it('terminated account is read-only; closed account keeps write access', async () => {
    const { retailerId, retailerToken } = await makeStore();
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'abuse' });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/retailer/me',
      headers: auth(retailerToken),
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/terms/accept',
      headers: auth(retailerToken),
      payload: { version: 'v1' },
    });
    expect(write.statusCode).toBe(403);

    // A closed account must still be able to write (it files the reopen request).
    await db
      .update(retailerAccounts)
      .set({ status: 'closed', suspendReason: 'account_closed_by_owner' })
      .where(eq(retailerAccounts.id, retailerId));
    const reopen = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/reopen-request',
      headers: auth(retailerToken),
      payload: {},
    });
    expect(reopen.statusCode).toBe(200);
  });
});

describe('unified restore — POST /admin/stores/:id/restore', () => {
  const restore = (storeId: string) => adminPost(`/stores/${storeId}/restore`);

  it('paused → resumed', async () => {
    const { storeId } = await makeStore();
    await adminPost(`/stores/${storeId}/pause`, { reason: 'renovation', visibility: 'hidden' });
    const res = await restore(storeId);
    expect(res.statusCode).toBe(200);
    expect(data(res).restoreMode).toBe('resumed');
    expect((await storeRow(storeId))!.status).toBe('active');
  });

  it('admin-suspended → unsuspended', async () => {
    const { storeId } = await makeStore();
    await adminPost(`/stores/${storeId}/suspend`, { reason: 'policy review' });
    const res = await restore(storeId);
    expect(data(res).restoreMode).toBe('unsuspended');
    expect((await storeRow(storeId))!.status).toBe('active');
  });

  it('closure-suspended → reopens account + store and clears the pending reopen request', async () => {
    const { storeId, retailerId, retailerToken } = await makeStore();
    const closeReq = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/close-request',
      headers: auth(retailerToken),
      payload: {},
    });
    await adminPost(`/compliance/change-requests/${data(closeReq).id}/decide`, {
      decision: 'approved',
    });
    const reopenReq = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/reopen-request',
      headers: auth(retailerToken),
      payload: {},
    });

    const res = await restore(storeId);
    expect(data(res).restoreMode).toBe('account_reopened');
    expect((await storeRow(storeId))!.status).toBe('active');
    expect((await accountRow(retailerId))!.status).toBe('active');
    // The in-flight reopen request must not linger on the desk.
    const cr = await db.query.changeRequests.findFirst({
      where: eq(changeRequests.id, data(reopenReq).id as string),
    });
    expect(cr!.status).toBe('approved');
  });

  it('directly-banned store → reinstated', async () => {
    const { storeId } = await makeStore();
    await adminPost(`/stores/${storeId}/ban`, { reason: 'counterfeit goods' });
    const res = await restore(storeId);
    expect(data(res).restoreMode).toBe('reinstated');
    expect((await storeRow(storeId))!.status).toBe('active');
  });

  it('cascade-banned store → one call lifts the account ban AND restores the store', async () => {
    const { storeId, retailerId } = await makeStore();
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'fraud' });
    const res = await restore(storeId);
    expect(res.statusCode).toBe(200);
    expect(data(res).restoreMode).toBe('account_reinstated');
    expect((await accountRow(retailerId))!.status).toBe('active');
    expect((await storeRow(storeId))!.status).toBe('active');

    // Fully operating → nothing left to restore.
    const noop = await restore(storeId);
    expect(noop.statusCode).toBe(409);
  });

  it('stacked lock — account ban over an earlier store suspension — clears in one call', async () => {
    const { storeId, retailerId } = await makeStore();
    await adminPost(`/stores/${storeId}/suspend`, { reason: 'quality issues' });
    await adminPost(`/retailers/${retailerId}/ban`, { reason: 'fraud' });

    const res = await restore(storeId);
    expect(res.statusCode).toBe(200);
    // Cascade reinstates the account but leaves the for-cause suspension; the
    // store layer then lifts it too — admin intent on THIS store is explicit.
    expect(data(res).restoreActions).toEqual(['account_reinstated', 'unsuspended']);
    expect((await accountRow(retailerId))!.status).toBe('active');
    expect((await storeRow(storeId))!.status).toBe('active');
  });
});

describe('owner-closure suspension is not manually liftable', () => {
  it('unsuspend/reinstate 409 on a closure-suspended store; reopen approval is the exit', async () => {
    const { storeId, retailerId, retailerToken } = await makeStore();

    // Owner files closure; admin approves → store suspended, account closed.
    const closeReq = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/close-request',
      headers: auth(retailerToken),
      payload: {},
    });
    expect(closeReq.statusCode).toBe(200);
    await adminPost(`/compliance/change-requests/${data(closeReq).id}/decide`, {
      decision: 'approved',
    });
    expect((await storeRow(storeId))!.status).toBe('suspended');
    expect((await accountRow(retailerId))!.status).toBe('closed');

    // The prod incident: admin lifting just the store strands a live storefront
    // with every account closed. Both lift paths must refuse.
    const unsuspend = await adminPost(`/stores/${storeId}/unsuspend`);
    expect(unsuspend.statusCode).toBe(409);
    const unban = await adminPost(`/stores/${storeId}/unban`);
    expect(unban.statusCode).toBe(409);
    expect((await storeRow(storeId))!.status).toBe('suspended');

    // The real exit: reopen request → approval restores store AND account together.
    const reopenReq = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/reopen-request',
      headers: auth(retailerToken),
      payload: {},
    });
    expect(reopenReq.statusCode).toBe(200);
    await adminPost(`/compliance/change-requests/${data(reopenReq).id}/decide`, {
      decision: 'approved',
    });
    expect((await storeRow(storeId))!.status).toBe('active');
    expect((await accountRow(retailerId))!.status).toBe('active');
  });
});

describe('appeals queue (admin Pending Requests desk)', () => {
  it('a retailer appeal surfaces in the queue and an admin reply clears it', async () => {
    const { storeId, retailerToken } = await makeStore();
    await adminPost(`/stores/${storeId}/suspend`, { reason: 'queue test' });

    // Terminated/suspended accounts may still write to the appeal path (allowlist).
    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/appeal',
      headers: auth(retailerToken),
      payload: { body: 'Please reconsider — the flagged listing was already removed.' },
    });
    expect(post.statusCode).toBe(200);

    const queue = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/stores/appeals/pending',
        headers: auth(adminToken),
      });
      expect(res.statusCode).toBe(200);
      return data(res) as { storeId: string; storeStatus: string; lastMessagePreview: string }[];
    };

    const pending = (await queue()).find((r) => r.storeId === storeId);
    expect(pending).toBeDefined();
    expect(pending!.storeStatus).toBe('suspended');
    expect(pending!.lastMessagePreview).toContain('Please reconsider');

    // Admin replies → ball is back with the retailer → thread leaves the queue.
    const reply = await adminPost(`/stores/${storeId}/appeal`, {
      body: 'Reviewed — reinstating your store shortly.',
    });
    expect(reply.statusCode).toBe(200);
    expect((await queue()).find((r) => r.storeId === storeId)).toBeUndefined();

    // Retailer follows up → it re-enters the queue.
    await app.inject({
      method: 'POST',
      url: '/api/v1/retailer/account/appeal',
      headers: auth(retailerToken),
      payload: { body: 'Thank you — waiting for the reinstate.' },
    });
    expect((await queue()).find((r) => r.storeId === storeId)).toBeDefined();

    // Restoring the store resolves the appeal de facto — even with the retailer as
    // the last author, the thread must leave the desk (stale-card edge case).
    await adminPost(`/stores/${storeId}/restore`);
    expect((await storeRow(storeId))!.status).toBe('active');
    expect((await queue()).find((r) => r.storeId === storeId)).toBeUndefined();
  });
});
